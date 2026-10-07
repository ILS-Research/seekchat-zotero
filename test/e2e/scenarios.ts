/**
 * E2E scenarios, run in order inside a real Zotero against the mock LLM
 * (e2e/mock-llm.mjs). Later scenarios use what earlier ones put in ctx.
 * Add new scenarios at the end of the list.
 */
import { currentReaderPage, getPdfPages, PdfContextProvider } from '../../src/core/context/pdf-context';
import { analyzeFit } from '../../src/core/context/fit';
import { buildOutline, type OutlineNode } from '../../src/core/context/outline';
import { readPrefs } from '../../src/prefs';
import { getSession } from '../../src/core/session';
import { setPref } from '../../src/prefs';
import { getRegisteredPaneID } from '../../src/ui/chat-section';
import { createClient } from '../../src/core/llm';
import { getZotSeekStatus, searchPassages, ZotSeekUnavailableError } from '../../src/core/zotseek/client';
import { booksInScope } from '../../src/core/library/books';
import { buildMessages } from '../../src/core/prompt';
import { logger } from '../../src/util/log';
import { collectionScope, itemsScope, libraryScope, LibraryContextProvider } from '../../src/core/library/library-context';
import { openSourceCitation } from '../../src/core/library/zotero-items';
import { getLibraryChatWindow, getPrefsPaneID, openLibraryChat } from '../../src/ui/library-window';
import { getToolbarButton, getToolsToolbarButton } from '../../src/ui/toolbar-button';
import { getToolsChatView, getToolsChatWindow, openToolsChat } from '../../src/ui/tools-window';
import { getToolSession } from '../../src/core/tools/session';
import { setSaveChatTestPath } from '../../src/ui/save-chat';
import { addLegacyMenu, chatWithFile, chatWithSelection, menuState, registerMenus, removeLegacyMenu, unregisterMenus } from '../../src/ui/context-menu';
import { splitSourceCitations } from '../../src/core/citations';
import { buildSources } from '../../src/core/library/sources';
import { renderTurn } from '../../src/ui/turn-view';
import { resolveAttachment } from '../../src/ui/chat-section';
import { docKind } from '../../src/core/context/document';
import { assert, delay, screenshot, SkipError, waitFor, type E2EContext } from './harness';
import { noteText } from '../../src/core/context/notes';
import type { ToolRun, Turn } from '../../src/core/turn';
import { probeCertificate, readCerts, upsertCert, writeCerts } from '../../src/core/certs';
import { decideCertificate, forgetServer, resetTlsChecks } from '../../src/core/tls';
import { getPref } from '../../src/prefs';

type Scenario = [string, (ctx: E2EContext) => Promise<void>];

const MOCK = 'http://127.0.0.1:11434';

async function mockLastRequest(): Promise<any> {
  const resp = await Zotero.getMainWindow().fetch(`${MOCK}/__last`);
  return resp.json();
}

async function mockRequests(): Promise<any[]> {
  const resp = await Zotero.getMainWindow().fetch(`${MOCK}/__requests`);
  return resp.json();
}

/**
 * Optional live scenarios against a real model server (E2E_LIVE_URL in e2e/run.sh).
 * Points SeekChat at it, or skips when no server is configured.
 */
function useLiveServer(ctx: E2EContext): void {
  const url: string = Zotero.Prefs.get('seekchat.e2e.liveUrl') || '';
  if (!url) throw new SkipError('E2E_LIVE_URL not set');
  setPref('baseUrl', url);
  setPref('model', Zotero.Prefs.get('seekchat.e2e.liveModel') || '');
  setPref('apiKey', Zotero.Prefs.get('seekchat.e2e.liveApiKey') || '');
  setPref('allowedRemoteHosts', new URL(url).hostname);
  ctx.live ??= [];
}

/** Appends a record to e2e/out/live-report.json (answers are not asserted verbatim). */
async function reportLive(ctx: E2EContext, entry: Record<string, unknown>): Promise<void> {
  ctx.live.push(entry);
  await Zotero.File.putContentsAsync(`${ctx.outDir}/live-report.json`, JSON.stringify(ctx.live, null, 2));
}

/** Real documents of zotero-reference's test set (E2E_REF_ASSETS), or skip. */
function refAssets(): string {
  const dir: string = Zotero.Prefs.get('seekchat.e2e.refAssetsDir') || '';
  if (!dir) throw new SkipError('zotero-reference test assets not mounted');
  return dir;
}

/** A regular item with a real PDF of the test set attached. */
async function liveDoc(type: string, title: string, file: string, collectionID?: number): Promise<{ item: any; att: any }> {
  const item = new Zotero.Item(type);
  item.setField('title', title);
  if (collectionID) item.setCollections([collectionID]);
  await item.saveTx();
  const att = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${refAssets()}/${file}`), parentItemID: item.id });
  return { item, att };
}

/**
 * Asks the tool chat with a real model: answers every confirmation with `decide` (true = confirm), takes a screenshot
 * at each confirmation, every 20 s while it runs and at the end. Returns the answer turn.
 */
async function liveToolAsk(ctx: E2EContext, name: string, question: string, decide: (run: ToolRun) => boolean = () => true): Promise<Turn> {
  const toolsWin = getToolsChatWindow();
  const view = getToolsChatView()!;
  const session = getToolSession();
  view.input.value = question;
  let finished = false;
  const sending = view.send().finally(() => { finished = true; });
  const answered = new Set<ToolRun>();
  let shots = 0;
  let lastShot = Date.now();
  while (!finished) {
    const turn = session.turns[session.turns.length - 1];
    const run = turn?.toolRuns?.find((r) => r.state === 'confirm' && !answered.has(r));
    if (run) {
      answered.add(run);
      await delay(400);
      await screenshot(ctx, `${name}-${++shots}-confirm-${run.name}`, toolsWin);
      session.confirm(run, decide(run));
    } else if (Date.now() - lastShot > 20000) {
      lastShot = Date.now();
      await screenshot(ctx, `${name}-${++shots}-running`, toolsWin);
    }
    await delay(500);
  }
  await sending;
  await delay(400);
  const turn = session.turns[session.turns.length - 1];
  await screenshot(ctx, `${name}-${++shots}-answer`, toolsWin);
  for (const block of Array.from(toolsWin.document.querySelectorAll('.seekchat-tools-block') as NodeListOf<HTMLDetailsElement>)) block.open = true;
  await delay(300);
  await screenshot(ctx, `${name}-${++shots}-answer-tools-opened`, toolsWin);
  return turn;
}

/** The tool runs of a turn in short form for the live report. */
function runsReport(turn: Turn): unknown[] {
  return (turn.toolRuns || []).map((r) => ({ name: r.name, title: r.title, state: r.state, status: r.status, items: r.items?.map((i) => `${i.badge || ''} ${i.label}${i.detail ? ` | ${i.detail.slice(0, 200)}` : ''}`) }));
}

/** Opens the tool chat on the user library for a live scenario. */
async function openLiveToolChat(): Promise<void> {
  openToolsChat();
  await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
  const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
  getToolsChatWindow().resizeTo(1100, 820);
  await delay(300);
  view.setTarget(`l${Zotero.Libraries.userLibraryID}`);
  getToolSession().clear();
}

/** Checkbox of the chapter with this title in the tree. */
function chapterBox(section: Element, title: string): HTMLInputElement {
  const row = Array.from(section.querySelectorAll('.seekchat-chapter'))
    .find((r) => r.querySelector('.seekchat-chapter-title')?.textContent === title);
  assert(row, `chapter ${title} not in tree`);
  return row.querySelector('input') as HTMLInputElement;
}

/** Page numbers marked [Page N] in a system prompt. */
function sentPages(system: string): number[] {
  return [...system.matchAll(/\[Page (\d+)\]/g)].map((m) => Number(m[1]));
}

/**
 * Stand-in for ZotSeek: the flag object plus /zotseek/stats and /zotseek/search on
 * Zotero's real HTTP server, same paths and response shapes as ZotSeek's REST endpoints.
 */
function installZotSeek(opts: { indexed?: number; search?: boolean; results?: any[] } = {}) {
  const server = (Zotero as any).Server;
  assert(server?.port, 'Zotero HTTP server not running');
  const state = {
    indexed: opts.indexed ?? 5,
    seen: [] as any[],
    setSearch(fn: (sp: URLSearchParams) => any[]) {
      server.Endpoints['/zotseek/search'] = endpoint((sp) => ({ results: fn(sp) }));
    },
    /** ZotSeek's toolbar button (same id and place), which our button sits next to. */
    addButton() {
      const doc = Zotero.getMainWindow().document;
      if (doc.getElementById('zotseek-toolbar-button')) return;
      const btn = doc.createXULElement('toolbarbutton');
      btn.id = 'zotseek-toolbar-button';
      btn.setAttribute('class', 'zotero-tb-button');
      doc.getElementById('zotero-tb-search')?.before(btn);
    },
    uninstall() {
      Zotero.getMainWindow().document.getElementById('zotseek-toolbar-button')?.remove();
      delete server.Endpoints['/zotseek/search'];
      delete server.Endpoints['/zotseek/stats'];
      delete (Zotero as any).ZotSeek;
    },
  };
  function endpoint(payload: (sp: URLSearchParams) => any) {
    const E: any = function () {};
    E.prototype = {
      supportedMethods: ['GET'],
      supportedDataTypes: ['application/json'],
      permitBookmarklet: false,
      init: async (req: any) => {
        state.seen.push(Object.fromEntries(req.searchParams));
        return [200, 'application/json', JSON.stringify(payload(req.searchParams))];
      },
    };
    return E;
  }
  (Zotero as any).ZotSeek = { standIn: true };
  server.Endpoints['/zotseek/stats'] = endpoint(() => ({ ready: state.indexed > 0, indexedPapers: state.indexed, totalChunks: state.indexed * 10 }));
  if (opts.search !== false) state.setSearch(() => opts.results || []);
  return state;
}

/**
 * Saves the real SeekBook (sideloaded in live runs) and its endpoints before a stand-in replaces them;
 * the returned function puts them back.
 */
function stashSeekBook(): () => void {
  const server = (Zotero as any).Server;
  const paths = ['/seekbook/stats', '/seekbook/search', '/seekbook/books', '/seekbook/pages'];
  const plugin = (Zotero as any).SeekBook;
  const endpoints = paths.map((p) => server.Endpoints[p]);
  return () => {
    paths.forEach((p, i) => {
      if (endpoints[i]) server.Endpoints[p] = endpoints[i];
      else delete server.Endpoints[p];
    });
    if (plugin) (Zotero as any).SeekBook = plugin;
    else delete (Zotero as any).SeekBook;
  };
}

/** A ZotSeek search result with text, as /zotseek/search returns it for granularity=passages. */
function passage(itemKey: string, title: string, page: number, text: string): any {
  return {
    itemKey, libraryKey: 'user', title, authors: ['Muster'], year: 2021, score: 0.02, semanticScore: 0.7, keywordScore: null,
    source: 'semantic', matchedChunk: { snippet: text, page, textSource: 'pdf' },
  };
}

const CITED_PAGES = /\[S\. (\d+)\]/g;

async function importFixture(title: string, file: string): Promise<{ parentID: number; attachment: any }> {
  const item = new Zotero.Item('book');
  item.setField('title', title);
  const parentID = await item.saveTx();
  const attachment = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(file), parentItemID: parentID });
  return { parentID, attachment };
}

/** Selects an item in the library tab and returns the (scrolled-to) chat section. */
async function openSectionInLibrary(parentID: number): Promise<Element> {
  const win = Zotero.getMainWindow();
  win.Zotero_Tabs.select('zotero-pane');
  await win.ZoteroPane.selectItem(parentID);
  const itemPane = win.document.getElementById('zotero-item-pane');
  const section: Element = await waitFor('section in item pane', () => findSection(itemPane)).catch((e) => {
    throw new Error(`${e.message}; ${describePanes(itemPane)}`);
  });
  await (section.closest('item-details') as any)?.scrollToPane(section.getAttribute('data-pane'), 'instant');
  return section;
}

/** The chat section inside a given container (item pane or reader context pane). */
function findSection(root: Element | null): Element | null {
  const id = getRegisteredPaneID();
  if (!root || !id) return null;
  const match = Array.from(root.querySelectorAll('[data-pane]')).find((e) => e.getAttribute('data-pane') === id);
  return match ? (match.closest('item-pane-custom-section') || match) : null;
}

/** For failure messages: which panes exist in the container. */
function describePanes(root: Element | null): string {
  if (!root) return 'container missing';
  const ids = Array.from(root.querySelectorAll('[data-pane]')).map((e) => `${e.localName}:${e.getAttribute('data-pane')}`);
  return `looking for ${getRegisteredPaneID()}, found ${ids.join(', ') || 'none'}`;
}

async function askThroughUi(section: Element, question: string, timeoutMs = 20000): Promise<Element> {
  const doc = section.ownerDocument!;
  const textarea = await waitFor('chat input enabled', () => {
    const t = section.querySelector('textarea.seekchat-input') as HTMLTextAreaElement | null;
    return t && !t.disabled ? t : null;
  });
  const before = section.querySelectorAll('.seekchat-msg.assistant:not(.notice)').length;
  textarea.value = question;
  textarea.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const answer = await waitFor('assistant answer with citation', () => {
    const answers = section.querySelectorAll('.seekchat-msg.assistant:not(.notice)');
    const last = answers[answers.length - 1];
    return answers.length > before && last?.querySelector('.seekchat-cite') ? last : null;
  }, timeoutMs);
  // The first citation shows up while the answer still streams: wait until the send button is back (no "Stop").
  await waitFor('answer finished', () => !Array.from(section.querySelectorAll('button')).some((b) => /^Stopp?$/.test(b.textContent?.trim() || '')) || null, timeoutMs);
  return answer;
}

export const scenarios: Scenario[] = [
  ['plugin is loaded and the section registered', async () => {
    assert(Zotero.SeekChat, 'Zotero.SeekChat missing');
    assert(getRegisteredPaneID(), 'item pane section not registered');
  }],

  ['fixture PDF is imported', async (ctx) => {
    const item = new Zotero.Item('journalArticle');
    item.setField('title', 'SeekChat E2E Testdokument');
    item.setField('date', '2021');
    item.setCreators([{ creatorType: 'author', firstName: 'Erika', lastName: 'Muster' }]);
    ctx.parentID = await item.saveTx();
    const file = Zotero.File.pathToFile(`${ctx.fixturesDir}/seekchat-test.pdf`);
    const att = await Zotero.Attachments.importFromFile({ file, parentItemID: ctx.parentID });
    assert(att?.isPDFAttachment(), 'attachment is not a PDF');
    ctx.attachment = att;
  }],

  ['PDF text is extracted per page', async (ctx) => {
    const pages = await getPdfPages(ctx.attachment);
    assert(pages.length === 3, `expected 3 pages, got ${pages.length}`);
    assert(pages[1].text.includes('Starkregen'), `page 2 text unexpected: ${pages[1].text.slice(0, 80)}`);
  }],

  ['chat session streams an answer from the model server', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const session = getSession(new PdfContextProvider(ctx.attachment));
    await session.ask('Was steht zu Starkregen?');
    const answer = session.turns[session.turns.length - 1];
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(answer.content.includes('[S. 2]'), `answer lacks citation: ${answer.content}`);
    assert(answer.meta?.includes('vollständiger Text'), `unexpected meta: ${answer.meta}`);
    const req = await mockLastRequest();
    assert(req.model === 'mock-model', 'wrong model sent');
    // Auto limits from the mock's /api/ps (loaded window 20480; /v1/models reports none): 80 % -> 16384, answer 1638,
    // text -> 46000 chars. Only the OpenAI interface: max_tokens, no Ollama options, never num_ctx.
    assert(req.max_tokens === 1638 && !('options' in req) && !JSON.stringify(req).includes('num_ctx'), `auto limits not applied: ${JSON.stringify({ max_tokens: req.max_tokens, options: req.options })}`);
    assert(req.messages[0].content.includes('[Page 2]'), 'document pages missing in system prompt');
    session.clear();
  }],

  ['chat works in the library item pane', async (ctx) => {
    const win = Zotero.getMainWindow();
    await win.ZoteroPane.selectItem(ctx.parentID);
    const itemPane = win.document.getElementById('zotero-item-pane');
    const section: Element = await waitFor('section in item pane', () => findSection(itemPane)).catch((e) => {
      throw new Error(`${e.message}; ${describePanes(itemPane)}`);
    });
    const details = section.closest('item-details') as any;
    await details?.scrollToPane(section.getAttribute('data-pane'), 'instant');
    await waitFor('section shows the PDF', () => section.querySelector('.seekchat-target')?.textContent?.startsWith('PDF:'));
    const answer = await askThroughUi(section, 'Worum geht es in Kapitel 2?');
    assert(answer.textContent?.includes('Starkregen'), `unexpected answer: ${answer.textContent}`);
  }],

  ['chat works in the reader side pane', async (ctx) => {
    const win = Zotero.getMainWindow();
    const reader = await Zotero.Reader.open(ctx.attachment.id);
    await waitFor('reader ready', () => reader?._internalReader);
    // A fresh profile starts with the reader's side pane collapsed; open it like a user would.
    win.ZoteroContextPane.collapsed = false;
    const contextPane = win.document.getElementById('zotero-context-pane');
    const section: Element = await waitFor('section in reader pane', () => {
      const s = findSection(contextPane);
      return s && !s.hasAttribute('hidden') ? s : null;
    }).catch((e) => {
      throw new Error(`${e.message}; ${describePanes(contextPane)}`);
    });
    const details = section.closest('item-details') as any;
    await details?.scrollToPane(section.getAttribute('data-pane'), 'instant');
    await askThroughUi(section, 'Was ist das Fazit?');
    ctx.readerSection = section;
  }],

  ['a citation opens the PDF on that page', async (ctx) => {
    const cite = ctx.readerSection.querySelector('.seekchat-cite') as HTMLElement;
    cite.click();
    // The reader saves the current page as the attachment's last page index (0-based).
    await waitFor('reader on page 2', () => ctx.attachment.getAttachmentLastPageIndex() === 1, 10000);
  }],

  ['short PDF: size check says it fits', async (ctx) => {
    const section = await openSectionInLibrary(ctx.parentID);
    const hint = await waitFor('fit hint', () => section.querySelector('.seekchat-longdoc')?.textContent?.includes('Passt vollständig') ? section.querySelector('.seekchat-longdoc') : null);
    assert(!hint.classList.contains('warning'), 'short PDF flagged as too large');
  }],

  ['long PDF: size check warns and offers three strategies', async (ctx) => {
    const { parentID, attachment } = await importFixture('SeekChat E2E Langes Buch', `${ctx.fixturesDir}/seekchat-long.pdf`);
    ctx.longParentID = parentID;
    ctx.longAttachment = attachment;
    const section = await openSectionInLibrary(parentID);
    const panel = await waitFor('size warning', () => section.querySelector('.seekchat-longdoc.warning'), 20000);
    assert(panel.textContent?.includes('zu groß'), `unexpected warning text: ${panel.textContent}`);
    const strategies = Array.from(panel.querySelectorAll('.seekchat-strategy')) as HTMLElement[];
    assert(strategies.map((e) => e.dataset.strategy).join() === 'vector,keywords,chapters', 'strategies missing or out of order');
    const checked = panel.querySelector('input[type="radio"]:checked') as HTMLInputElement | null;
    assert(checked?.value === 'keywords', 'keywords is not the default strategy');
    assert(!panel.querySelector('.seekchat-badge'), 'placeholder badge still shown');
    ctx.longSection = section;
  }],

  ['long PDF: semantic search is greyed out without SeekBook and cannot be picked', async (ctx) => {
    const section: Element = ctx.longSection;
    for (const id of ['vector']) {
      const row = section.querySelector(`.seekchat-strategy[data-strategy="${id}"]`) as HTMLElement;
      const radio = row.querySelector('input') as HTMLInputElement;
      assert(radio.disabled && row.classList.contains('disabled'), `${id} is not disabled`);
      row.click();
      radio.click();
      assert(!radio.checked, `${id} could be selected`);
      await waitFor('index hint', () => section.querySelector('.seekchat-index-panel')?.textContent?.includes('braucht SeekBook'), 5000);
    }
    const checked = section.querySelector('.seekchat-strategy input:checked') as HTMLInputElement;
    assert(checked?.value === 'keywords', `selection changed to ${checked?.value}`);
    assert(!section.querySelector('.seekchat-chapters'), 'chapter panel shown');
    await screenshot(ctx, 'strategies');
  }],

  ['long PDF: outline is read from the PDF bookmarks', async (ctx) => {
    const outline = await new PdfContextProvider(ctx.longAttachment).outline();
    assert(outline.source === 'pdf', `outline source ${outline.source}`);
    assert(outline.nodes.length === 4 && outline.nodes.reduce((n, c) => n + c.children.length, 0) === 3,
      `unexpected tree: ${JSON.stringify(outline.nodes.map((n) => [n.title, n.children.length]))}`);
    const results = outline.nodes.find((n) => n.title === 'Ergebnisse');
    assert(results?.pageStart === 20 && results.pageEnd === 35, `chapter range ${results?.pageStart}–${results?.pageEnd}`);
  }],

  ['long PDF: model keywords find the matching page', async (ctx) => {
    const before = (await mockRequests()).length;
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    await session.ask('Was sagt das Buch zum Stadtklima?');
    const answer = session.turns[session.turns.length - 1];
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(answer.meta?.includes('Suchbegriffe: Waermeinseln'), `keywords missing in meta: ${answer.meta}`);
    assert(answer.meta?.includes('Dokumentsprache: Deutsch (vom Modell erkannt)'), `language missing in meta: ${answer.meta}`);
    const reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 3, `expected language + keyword + answer request, got ${reqs.length}`);
    assert(reqs[0].messages[0].content.includes('Identify the language'), 'first request is not the language request');
    assert(reqs[0].messages[1].content.includes('Kapitel 1') || reqs[0].messages[1].content.includes('Langes Buch'), 'language sample lacks the first pages');
    assert(reqs[1].messages[0].content.includes('only in German'), 'keyword request not restricted to the document language');
    const system: string = reqs[2].messages[0].content;
    assert(system.includes('[Page 27]') && system.includes('Waermeinseln'), 'matching page 27 not sent');
    const pagesSent = (system.match(/\[Page \d+\]/g) || []).length;
    assert(pagesSent < 40, `whole book sent (${pagesSent} pages)`);
    ctx.longSession = session;
  }],

  ['long PDF: detected language is reused, metadata language wins', async (ctx) => {
    const session = ctx.longSession;
    let before = (await mockRequests()).length;
    await session.ask('Und was steht im Fazit?');
    let reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 2, `language detected again: ${reqs.length} requests`);

    const parent = Zotero.Items.get(ctx.longParentID);
    parent.setField('language', 'en-GB');
    await parent.saveTx();
    before = (await mockRequests()).length;
    await session.ask('Was steht zu Hitze?');
    reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 2, `expected keyword + answer request, got ${reqs.length}`);
    assert(reqs[0].messages[0].content.includes('only in English'), 'metadata language not used for keywords');
    const meta = session.turns[session.turns.length - 1].meta;
    assert(meta?.includes('Dokumentsprache: Englisch (aus Metadaten)'), `unexpected meta: ${meta}`);
    session.clear();
  }],

  ['long PDF: selected chapters that fit are sent whole, without keyword call', async (ctx) => {
    const section = await openSectionInLibrary(ctx.longParentID);
    const radio = await waitFor('chapters radio', () => section.querySelector('.seekchat-strategy[data-strategy="chapters"] input') as HTMLInputElement | null);
    assert(!radio.disabled, 'chapters strategy still disabled');
    radio.click();
    await waitFor('chapter tree', () => section.querySelector('.seekchat-chapters'), 10000);
    const sum = () => section.querySelector('.seekchat-chapter-sum')?.textContent || '';
    assert(sum().includes('Noch kein Kapitel'), `unexpected sum: ${sum()}`);
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    session.clear();
    await session.ask('Was steht im Fazit?');
    let answer = session.turns[session.turns.length - 1];
    assert(answer.error && answer.content.includes('Keine Kapitel ausgewählt'), `no-selection error missing: ${answer.content}`);

    chapterBox(section, 'Fazit').click();
    assert(sum().includes('geht vollständig mit'), `unexpected sum: ${sum()}`);
    const before = (await mockRequests()).length;
    await session.ask('Was steht im Fazit?');
    answer = session.turns[session.turns.length - 1];
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(answer.meta?.includes('Kapitel „Fazit“ vollständig: S. 36–40'), `unexpected meta: ${answer.meta}`);
    const reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 1, `expected only the answer request, got ${reqs.length}`);
    const sent = sentPages(reqs[0].messages[0].content);
    assert(sent.join() === '36,37,38,39,40', `pages sent: ${sent}`);
    await screenshot(ctx, 'chapters');
    ctx.chapterSection = section;
  }],

  ['long PDF: chapters larger than the budget are searched with keywords', async (ctx) => {
    const section: Element = ctx.chapterSection;
    chapterBox(section, 'Fazit').click();
    chapterBox(section, 'Ergebnisse').click();
    const sum = section.querySelector('.seekchat-chapter-sum')?.textContent || '';
    assert(sum.includes('innerhalb der Auswahl'), `unexpected sum: ${sum}`);
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    const before = (await mockRequests()).length;
    await session.ask('Was sagt das Buch zum Stadtklima?');
    const answer = session.turns[session.turns.length - 1];
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(answer.meta?.includes('Kapitel „Ergebnisse“, Auszüge'), `unexpected meta: ${answer.meta}`);
    const reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 2, `expected keyword + answer request, got ${reqs.length}`);
    const sent = sentPages(reqs[1].messages[0].content);
    assert(sent.includes(27), `page 27 not sent: ${sent}`);
    assert(sent.every((p) => p >= 20 && p <= 35), `pages outside the chapter: ${sent}`);
    session.clear();
  }],

  ['ZotSeek missing: library search is unavailable, nothing else depends on it', async () => {
    assert(!(Zotero as any).ZotSeek, 'ZotSeek unexpectedly installed in the E2E profile');
    const status = await getZotSeekStatus();
    assert(!status.available && status.reason === 'not-installed', `unexpected status: ${JSON.stringify(status)}`);
    let err: any = null;
    await searchPassages('Stadtklima').catch((e) => { err = e; });
    assert(err instanceof ZotSeekUnavailableError && err.reason === 'not-installed', `unexpected error: ${err}`);
  }],

  ['ZotSeek REST: passages come through Zotero\'s local server', async () => {
    const zs = installZotSeek({ indexed: 0, search: false });
    try {
      let status = await getZotSeekStatus();
      assert(!status.available && status.reason === 'endpoint-off', `without search endpoint: ${JSON.stringify(status)}`);
      zs.setSearch((sp) => [{
        itemKey: 'ABCD1234', libraryKey: 'user', title: 'Stadtklima', authors: ['Muster'], year: 2021, score: 0.03,
        semanticScore: 0.71, keywordScore: null, source: 'semantic',
        matchedChunk: { snippet: `Treffer zu ${sp.get('q')}`, page: 27, textSource: 'pdf' },
      }]);
      status = await getZotSeekStatus();
      assert(!status.available && status.reason === 'no-index', `empty index: ${JSON.stringify(status)}`);
      zs.indexed = 3;
      status = await getZotSeekStatus();
      assert(status.available && status.stats.indexedPapers === 3, `indexed: ${JSON.stringify(status)}`);

      const passages = await searchPassages('Hitze in Städten', { topK: 15, libraryKey: 'user' });
      assert(passages.length === 1 && passages[0].text === 'Treffer zu Hitze in Städten' && passages[0].page === 27,
        `unexpected passages: ${JSON.stringify(passages)}`);
      const q = zs.seen[zs.seen.length - 1];
      assert(q.granularity === 'passages' && q.topK === '15' && q.libraryKey === 'user', `unexpected query: ${JSON.stringify(q)}`);
    } finally {
      zs.uninstall();
    }
  }],

  ['library chat: ZotSeek passages become numbered sources, the answer cites [n, S. x]', async (ctx) => {
    const a = Zotero.Items.get(ctx.parentID).key;
    const b = Zotero.Items.get(ctx.longParentID).key;
    const zs = installZotSeek({
      results: [
        passage(a, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.'),
        passage(b, 'SeekChat E2E Langes Buch', 27, 'Waermeinseln in dicht bebauten Quartieren erhoehen die naechtlichen Temperaturen.'),
        passage(a, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.'),
        { itemKey: 'ZZZZ9999', libraryKey: 'user', title: 'Nur Stichwort', score: 0.01, matchedChunk: null },
        passage(a, 'SeekChat E2E Testdokument', 1, 'Es beschreibt Methoden der Stadtklimaforschung.'),
      ],
    });
    try {
      const session = getSession(new LibraryContextProvider(libraryScope(Zotero.Libraries.userLibraryID)));
      session.clear();
      await session.ask('Was sagt meine Bibliothek zu Starkregen und Hitze?');
      const answer = session.turns[session.turns.length - 1];
      assert(!answer.error, `answer is an error: ${answer.content}`);
      const sources = answer.sources!;
      assert(sources?.length === 2 && sources[0].itemKey === a && sources[1].itemKey === b, `sources: ${JSON.stringify(sources)}`);
      assert(sources[0].excerpts.map((e) => e.page).join() === '1,2', `excerpts of [1]: ${JSON.stringify(sources[0].excerpts)}`);
      assert(answer.meta?.includes('2 Quellen, 3 Abschnitte (ZotSeek); 1 Treffer ohne Textauszug'), `meta: ${answer.meta}`);
      const system: string = (await mockLastRequest()).messages[0].content;
      assert(system.includes('<sources>') && system.includes('[1] Muster 2021 – SeekChat E2E Testdokument') && system.includes('(S. 27)'),
        `system prompt: ${system.slice(0, 600)}`);
      assert(!system.includes('Nur Stichwort'), 'hit without text went into the prompt');
      const cites = splitSourceCitations(answer.content, sources.length).filter((s) => s.type === 'source') as any[];
      assert(cites.map((c) => `${c.n}:${c.page ?? '-'}`).join() === '1:2,2:27,1:-', `citations: ${JSON.stringify(cites)}`);
      const q = zs.seen[zs.seen.length - 1];
      assert(q.topK === '30' && q.libraryKey === 'user' && q.q.startsWith('Was sagt meine Bibliothek'), `query: ${JSON.stringify(q)}`);
      ctx.librarySources = sources;
    } finally {
      zs.uninstall();
    }
  }],

  ['long PDF: semantic search via SeekBook – hand the book over, then pages from the index, no keyword call', async (ctx) => {
    const server = (Zotero as any).Server;
    const restore = stashSeekBook();
    const state = { indexed: false, handed: 0, searches: [] as any[] };
    const E = (payload: (sp: URLSearchParams) => any) => {
      const F: any = function () {};
      F.prototype = { supportedMethods: ['GET'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
        init: async (req: any) => [200, 'application/json', JSON.stringify(payload(req.searchParams))] };
      return F;
    };
    (Zotero as any).SeekBook = {
      apiVersion: 1, standIn: true,
      isIndexed: async () => state.indexed,
      indexer: { progress: {}, indexBooks: async () => { state.handed++; state.indexed = true; return 1; } },
    };
    server.Endpoints['/seekbook/stats'] = E(() => ({ apiVersion: 1, indexedBooks: 1, ready: true }));
    server.Endpoints['/seekbook/search'] = E((sp) => {
      state.searches.push(Object.fromEntries(sp));
      return { apiVersion: 1, results: [{ itemKey: Zotero.Items.get(ctx.longParentID).key, libraryKey: 'user', title: 'Buch', score: 1, semanticScore: 0.9, keywordScore: null,
        matchedChunk: { snippet: 'x', page: 27, pageEnd: 28, attachmentKey: ctx.longAttachment.key } }] };
    });
    try {
      // Reopen: the panel reads the index state per document.
      await openSectionInLibrary(ctx.parentID);
      const section = await openSectionInLibrary(ctx.longParentID);
      const btn = await waitFor('hand-over button', () => section.querySelector('.seekchat-add-index') as HTMLButtonElement | null, 10000);
      assert(btn.textContent?.includes('an SeekBook'), `button: ${btn.textContent}`);
      btn.click();
      const radio = await waitFor('semantic radio enabled', () => {
        const r = section.querySelector('.seekchat-strategy[data-strategy="vector"] input') as HTMLInputElement | null;
        return r && !r.disabled ? r : null;
      }, 10000);
      assert(state.handed === 1, `handed over ${state.handed}×`);
      radio.click();
      await waitFor('ready note', () => section.querySelector('.seekchat-index-panel')?.textContent?.includes('Semantische Suche über SeekBook'), 5000);
      const session = getSession(new PdfContextProvider(ctx.longAttachment));
      session.clear();
      const before = (await mockRequests()).length;
      await session.ask('Was steht zu Waermeinseln?');
      const answer = session.turns[session.turns.length - 1];
      assert(!answer.error && answer.meta?.includes('Semantische Suche (SeekBook)'), `meta: ${answer.meta} / ${answer.content}`);
      const reqs = (await mockRequests()).slice(before);
      assert(reqs.length === 1, `expected only the answer request, got ${reqs.length}`);
      const sent = sentPages(reqs[0].messages[0].content);
      assert(sent.includes(27) && sent.includes(28) && sent[0] === 1, `pages sent: ${sent}`);
      assert(state.searches[0]?.attachmentKeys === ctx.longAttachment.key, `search: ${JSON.stringify(state.searches)}`);
      session.setStrategy('keywords');
      session.clear();
    } finally {
      restore();
    }
  }],

  ['PDF chat: the page open in the reader and two on each side always go along', async (ctx) => {
    const win = Zotero.getMainWindow();
    const reader = await Zotero.Reader.open(ctx.longAttachment.id, { pageIndex: 11 });
    await waitFor('reader on page 12', () => currentReaderPage(ctx.longAttachment) === 12, 15000);
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    session.setStrategy('keywords');
    session.clear();
    try {
      await session.ask('Was steht zu Waermeinseln?');
      const answer = session.turns[session.turns.length - 1];
      const system: string = (await mockLastRequest()).messages[0].content;
      const sent = sentPages(system);
      assert(!answer.error && [10, 11, 12, 13, 14].every((p) => sent.includes(p)) && sent.includes(27), `pages sent: ${sent}`);
      assert(system.includes('currently has page 12 open') && answer.meta?.includes('Im Reader geöffnet: S. 12'), `meta: ${answer.meta}`);
    } finally {
      session.clear();
      win.Zotero_Tabs.close(reader?.tabID);
      win.Zotero_Tabs.select('zotero-pane');
    }
  }],

  ['PDF chat: running headers removed, printed page numbers in the prompt', async (ctx) => {
    const { attachment } = await importFixture('SeekChat E2E Kopfzeilen', `${ctx.fixturesDir}/seekchat-headers.pdf`);
    const pages = await getPdfPages(attachment);
    assert(pages.every((p) => !p.text.includes('Handbuch Stadtklima') && !p.text.includes('Lizenz CC')), `header left: ${pages[1].text.slice(0, 120)}`);
    assert(pages[2].text.startsWith('Kapitel 1 Starkregen'), `page 3: ${pages[2].text.slice(0, 80)}`);
    const block = await new PdfContextProvider(attachment).build('Starkregen', 100000);
    assert(block.body.includes('[Page 1] (printed i)') && block.body.includes('[Page 3] (printed 1)'), block.body.slice(0, 300));
    const msgs = buildMessages({ context: block, history: [], question: 'x' });
    assert(msgs[0].content.includes('page number printed on that page'), 'no note on printed page numbers');
  }],

  ['PDF chat: notes as context, and one answer saved as a note', async (ctx) => {
    const parent = Zotero.Items.get(ctx.parentID);
    const note = new Zotero.Item('note');
    note.libraryID = parent.libraryID;
    note.parentID = parent.id;
    note.setNote('<h1>Meine Lesenotiz</h1><p>NOTIZ-KONTEXT: Gruendaecher halbieren den Abfluss.</p>');
    await note.saveTx();
    const section = await openSectionInLibrary(ctx.parentID);
    const box = await waitFor('note checkbox', () => section.querySelector(`.seekchat-notes input[data-note-id="${note.id}"]`) as HTMLInputElement | null, 10000);
    (section.querySelector('.seekchat-notes') as any).open = true;
    box.click();
    const session = getSession(new PdfContextProvider(ctx.attachment));
    assert(session.contextNotes.has(note.id), 'note not ticked');
    session.clear();
    await session.ask('Was steht zu Starkregen?');
    const answer = session.turns[session.turns.length - 1];
    const system: string = (await mockLastRequest()).messages[0].content;
    assert(!answer.error && system.includes('<notes>') && system.includes('NOTIZ-KONTEXT') && answer.meta?.includes('Notiz als Kontext'), `notes: ${answer.meta} / ${system.slice(-400)}`);
    const before = parent.getNotes().length;
    const btn = await waitFor('answer note button', () => section.querySelector('.seekchat-msg.assistant .seekchat-answer-note') as HTMLButtonElement | null, 10000);
    btn.click();
    await waitFor('note saved', () => Zotero.Items.get(ctx.parentID).getNotes().length === before + 1, 10000);
    const saved = Zotero.Items.get(Zotero.Items.get(ctx.parentID).getNotes()).find((n: any) => n.getNote().includes('Was steht zu Starkregen?'));
    assert(saved && !saved.getNote().includes('Frage 2'), 'answer note missing or with the whole chat');
    await waitFor('button shows saved', () => section.querySelector('.seekchat-answer-note')?.textContent?.includes('✓'), 5000);
    session.contextNotes.clear();
    session.clear();
    await note.eraseTx();
    await saved.eraseTx();
  }],

  ['library chat: a citation opens the PDF page, without page it selects the item', async (ctx) => {
    const [first, second] = ctx.librarySources;
    await openSourceCitation(second, 27);
    await waitFor('long PDF on page 27', () => ctx.longAttachment.getAttachmentLastPageIndex() === 26, 10000);
    await openSourceCitation(first);
    const win = Zotero.getMainWindow();
    await waitFor('item selected', () => win.ZoteroPane.getSelectedItems()[0]?.id === ctx.parentID, 5000);
  }],

  ['library chat: collection and item scopes keep only their items', async (ctx) => {
    const a = Zotero.Items.get(ctx.parentID);
    const b = Zotero.Items.get(ctx.longParentID);
    const zs = installZotSeek({
      results: [
        passage(a.key, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.'),
        passage(b.key, 'SeekChat E2E Langes Buch', 27, 'Waermeinseln in dicht bebauten Quartieren erhoehen die naechtlichen Temperaturen.'),
      ],
    });
    try {
      const col = new Zotero.Collection();
      col.name = 'SeekChat E2E Collection';
      await col.saveTx();
      const sub = new Zotero.Collection();
      sub.name = 'SeekChat E2E Unter';
      sub.parentID = col.id;
      await sub.saveTx();
      a.addToCollection(col.id);
      await a.saveTx();

      let ctxBlock = await new LibraryContextProvider(collectionScope(col)).build('Starkregen', 40000);
      assert(ctxBlock.library!.sources.map((s) => s.itemKey).join() === a.key, `collection: ${JSON.stringify(ctxBlock.library!.sources)}`);
      assert(zs.seen[zs.seen.length - 1].topK === '100', 'filtered scope does not fetch the maximum');
      assert(ctxBlock.library!.scope === 'Collection „SeekChat E2E Collection“', `scope: ${ctxBlock.library!.scope}`);

      b.addToCollection(sub.id);
      await b.saveTx();
      ctxBlock = await new LibraryContextProvider(collectionScope(col)).build('Starkregen', 40000);
      assert(ctxBlock.library!.sources.length === 2, 'subcollection items missing');

      // A selected attachment stands for its parent item.
      ctxBlock = await new LibraryContextProvider(itemsScope([ctx.longAttachment])).build('Hitze', 40000);
      assert(ctxBlock.library!.sources.map((s) => s.itemKey).join() === b.key, `items: ${JSON.stringify(ctxBlock.library!.sources)}`);
      assert((ctxBlock.library!.scope as string) === '1 ausgewählter Eintrag', `scope: ${ctxBlock.library!.scope}`);
    } finally {
      zs.uninstall();
    }
  }],

  ['library chat: no usable ZotSeek result means a hint and no answer call', async () => {
    const session = getSession(new LibraryContextProvider(libraryScope(Zotero.Libraries.userLibraryID)));
    const ask = async () => {
      session.clear();
      const before = (await mockRequests()).length;
      await session.ask('Was steht zu Starkregen?');
      const answer = session.turns[session.turns.length - 1];
      assert(answer.error, `expected a hint, got: ${answer.content}`);
      // At most the planning call (queries for ZotSeek); never an answer without sources.
      const calls = (await mockRequests()).slice(before);
      assert(calls.every((r: any) => r.messages[0].content.includes('literature search')), 'model was asked for an answer anyway');
      return answer.content;
    };
    const askNoCall = async () => {
      session.clear();
      const before = (await mockRequests()).length;
      await session.ask('Was steht zu Starkregen?');
      const answer = session.turns[session.turns.length - 1];
      assert(answer.error, `expected a hint, got: ${answer.content}`);
      assert((await mockRequests()).length === before, 'model was called without ZotSeek');
      return answer.content;
    };
    let msg = await askNoCall();
    assert(msg.includes('braucht das Plugin ZotSeek'), `without ZotSeek: ${msg}`);

    const zs = installZotSeek({ results: [{ itemKey: 'ZZZZ9999', libraryKey: 'user', title: 'Nur Stichwort', score: 0.01, matchedChunk: null }] });
    try {
      msg = await ask();
      assert(msg.includes('nur Treffer ohne Textauszug'), `keyword-only hits: ${msg}`);
      zs.setSearch(() => []);
      msg = await ask();
      assert(msg.includes('keine passenden Textstellen'), `no hits: ${msg}`);
    } finally {
      zs.uninstall();
    }
    session.clear();
  }],

  ['library window: no button, not even next to ZotSeek\'s (library chat disabled since 1.0.0-rc.4)', async () => {
    assert(!getToolbarButton(), 'SeekChat button shown without ZotSeek');
    const zs = installZotSeek();
    try {
      zs.addButton();
      await Zotero.Promise.delay(500);
      assert(!getToolbarButton(), 'library chat button shown next to ZotSeek');
      assert(getToolsToolbarButton()?.previousElementSibling?.id === 'zotseek-toolbar-button', 'tool chat button not after ZotSeek\'s');
    } finally {
      zs.uninstall();
    }
  }],

  ['library window: opens with the selection as scope, answers and follows citations', async (ctx) => {
    const win = Zotero.getMainWindow();
    const a = Zotero.Items.get(ctx.parentID);
    const b = Zotero.Items.get(ctx.longParentID);
    const zs = installZotSeek({
      results: [
        passage(a.key, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.'),
        passage(b.key, 'SeekChat E2E Langes Buch', 27, 'Waermeinseln in dicht bebauten Quartieren erhoehen die naechtlichen Temperaturen.'),
      ],
    });
    try {
      zs.addButton();
      win.Zotero_Tabs.select('zotero-pane');
      await win.ZoteroPane.collectionsView.selectLibrary(Zotero.Libraries.userLibraryID);
      await win.ZoteroPane.selectItems([a.id, b.id]);
      openLibraryChat(); // no button since 1.0.0-rc.4: the window itself stays tested
      const cw = await waitFor('chat window loaded', () => {
        const w = getLibraryChatWindow();
        return w?.document?.querySelector('.seekchat-library-row') ? w : null;
      }, 15000);
      const doc = cw.document;
      const scopeText = () => (doc.querySelector('.seekchat-library-scope') as HTMLSelectElement)?.selectedOptions[0]?.textContent;
      assert(scopeText() === '2 ausgewählte Einträge', `scope: ${scopeText()}`);
      const options = Array.from((doc.querySelector('.seekchat-library-scope') as HTMLSelectElement).options).map((o) => o.textContent);
      assert(options.some((o) => o?.startsWith('Bibliothek „')), `scope options: ${options}`);
      // One of the two is a book, and ZotSeek's defaults exclude books and index abstracts only.
      await waitFor('coverage hint', () => {
        const t = doc.querySelector('.seekchat-library-coverage')?.textContent || '';
        return t.includes('1 Buch') && t.includes('„abstract“');
      }, 5000);
      await waitFor('ZotSeek status', () => doc.querySelector('.seekchat-library-status')?.textContent?.includes('5 Einträge indexiert'), 5000);
      const zsBox = doc.getElementById('seekchat-source-zotseek') as HTMLInputElement;
      const booksBox = doc.getElementById('seekchat-source-books') as HTMLInputElement;
      assert(zsBox?.checked && !zsBox.disabled, 'ZotSeek source not on by default');
      assert(doc.querySelector('.seekchat-library-zotseek-note')?.textContent?.includes('Literaturverzeichnis'), 'note on ZotSeek limits missing');
      assert(booksBox && booksBox.disabled && !booksBox.checked, 'books source not greyed out');
      zsBox.click();
      await waitFor('input disabled without source', () => (doc.querySelector('textarea.seekchat-input') as HTMLTextAreaElement).disabled
        && doc.querySelector('.seekchat-library-empty')?.textContent?.includes('Keine Quelle ausgewählt'), 5000);
      zsBox.click();
      const input = await waitFor('input enabled', () => {
        const t = doc.querySelector('textarea.seekchat-input') as HTMLTextAreaElement | null;
        return t && !t.disabled ? t : null;
      }, 5000);
      input.value = 'Was sagen die beiden zu Starkregen und Hitze?';
      input.dispatchEvent(new cw.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const answer = await waitFor('answer with source citations', () => {
        const msgs = doc.querySelectorAll('.seekchat-msg.assistant:not(.notice)');
        const last = msgs[msgs.length - 1];
        return last?.querySelectorAll('.seekchat-md .seekchat-cite').length === 3 ? last : null;
      }, 20000);
      await screenshot(ctx, 'library-window', cw);
      await screenshot(ctx, 'library-toolbar');
      const sourceItems = await waitFor('source list', () => {
        const li = doc.querySelectorAll('.seekchat-sources-list li');
        return li.length === 2 ? li : null;
      }, 5000);
      assert(doc.querySelector('.seekchat-sources-title')?.textContent === 'Quellen (2 von 2 zitiert)',
        `source list title: ${doc.querySelector('.seekchat-sources-title')?.textContent}`);
      assert(sourceItems[1].textContent?.includes('SeekChat E2E Langes Buch – S. 27'), `source 2: ${sourceItems[1].textContent}`);
      // "Chat als .md" writes the whole history (file picker skipped in tests).
      const mdPath = `${ctx.outDir}/chat-export.md`;
      setSaveChatTestPath(mdPath);
      (doc.querySelector('.seekchat-library-footer .seekchat-save') as HTMLButtonElement).click();
      const exported = await waitFor('exported chat', async () => {
        try {
          const text: string = await Zotero.File.getContentsAsync(mdPath);
          return text.includes('Quellen:') ? text : null;
        } catch {
          return null;
        }
      }, 5000);
      setSaveChatTestPath(null);
      assert(exported.startsWith('# SeekChat – 2 ausgewählte Einträge') && exported.includes('> Was sagen die beiden')
        && exported.includes('2. Muster 2021 – SeekChat E2E Langes Buch – S. 27')
        && exported.includes('Anfrage 1 an das Modell: Suchvorbereitung') && exported.includes('Anfrage 2 an das Modell: Antwort') && exported.includes('<sources>'), `export: ${exported.slice(0, 400)}`);
      const cite = answer.querySelectorAll('.seekchat-md .seekchat-cite')[1] as HTMLElement;
      assert(cite.textContent === '[2, S. 27]', `second citation: ${cite.textContent}`);
      cite.click();
      await waitFor('long PDF on page 27', () => ctx.longAttachment.getAttachmentLastPageIndex() === 26, 10000);

      // Opening again with a different selection switches the scope in the same window.
      win.Zotero_Tabs.select('zotero-pane');
      await win.ZoteroPane.selectItems([a.id]);
      openLibraryChat();
      await waitFor('library scope', () => scopeText()?.startsWith('Bibliothek „'), 5000);
      // Picking a scope in the window switches the chat.
      const select = doc.querySelector('.seekchat-library-scope') as HTMLSelectElement;
      await win.ZoteroPane.selectItems([a.id, b.id]);
      select.dispatchEvent(new cw.FocusEvent('focus'));
      const idx = Array.from(select.options).findIndex((o) => o.textContent === '2 ausgewählte Einträge');
      assert(idx >= 0, `selection not offered: ${Array.from(select.options).map((o) => o.textContent)}`);
      select.selectedIndex = idx;
      select.dispatchEvent(new cw.Event('change'));
      await waitFor('earlier chat back', () => scopeText() === '2 ausgewählte Einträge' && doc.querySelectorAll('.seekchat-msg.assistant:not(.notice)').length === 1, 5000);
      assert(getLibraryChatWindow() === cw, 'a second window was opened');
    } finally {
      zs.uninstall();
    }
  }],

  ['library window: without the ZotSeek endpoint it shows why and takes no questions', async () => {
    const cw = getLibraryChatWindow();
    assert(cw, 'chat window not open');
    const doc = cw.document;
    // ZotSeek gone while the window is open: re-checked when the window is (re)opened.
    Zotero.SeekChat.openLibraryChat();
    await waitFor('unavailable status', () => doc.querySelector('.seekchat-library-status.unavailable')?.textContent?.includes('braucht das Plugin ZotSeek'), 5000);
    assert((doc.querySelector('textarea.seekchat-input') as HTMLTextAreaElement).disabled, 'input enabled without ZotSeek');
    cw.close();
    await waitFor('window closed', () => !getLibraryChatWindow(), 5000);
  }],

  ['settings: limits come from the model by default, manual values on the second tab', async (ctx) => {
    Zotero.Utilities.Internal.openPreferences(getPrefsPaneID() || undefined);
    const pw = await waitFor('settings window with SeekChat pane', () => {
      const w = Services.wm.getMostRecentWindow('zotero:pref');
      return w?.document?.getElementById('seekchat-limits-auto') ? w : null;
    }, 20000);
    const doc = pw.document;
    await waitFor('auto limits shown', () => doc.getElementById('seekchat-auto-numCtx')?.textContent === '16.384 Tokens'
      && doc.getElementById('seekchat-auto-detail')?.textContent?.includes('des geladenen Modells'), 10000);
    assert(!doc.getElementById('seekchat-limits-auto-panel').hidden && doc.getElementById('seekchat-limits-manual-panel').hidden,
      'auto tab not the default');
    doc.getElementById('seekchat-limits-auto-panel').scrollIntoView();
    await screenshot(ctx, 'settings-limits', pw);
    doc.getElementById('seekchat-limits-manual').click();
    assert(readPrefs().limitsMode === 'manual' && !doc.getElementById('seekchat-limits-manual-panel').hidden, 'manual tab not applied');
    doc.getElementById('seekchat-limits-auto').click();
    assert(readPrefs().limitsMode === 'auto', 'auto tab not applied');
    pw.close();
  }],

  ['notes: both chats save their history as a Zotero note', async (ctx) => {
    // PDF chat: child note of the PDF's item, citations as zotero:// links.
    const session = getSession(new PdfContextProvider(ctx.attachment));
    session.clear();
    await session.ask('Was steht zu Starkregen?');
    const section = await openSectionInLibrary(ctx.parentID);
    const noteBtn = await waitFor('note button enabled', () => {
      const b = section.querySelector('.seekchat-save-note') as HTMLButtonElement | null;
      return b && !b.disabled ? b : null;
    }, 5000);
    const before = Zotero.Items.get(ctx.parentID).getNotes().length;
    noteBtn.click();
    const noteID = await waitFor('child note', () => Zotero.Items.get(ctx.parentID).getNotes().length > before
      && Zotero.Items.get(ctx.parentID).getNotes().slice(-1)[0], 5000);
    const html: string = Zotero.Items.get(noteID).getNote();
    assert(html.includes('SeekChat – PDF') && html.includes(`zotero://open-pdf/library/items/${ctx.attachment.key}?page=2`),
      `PDF note: ${html.slice(0, 400)}`);
    session.clear();

    // Library chat, collection scope: standalone note in that collection.
    const a = Zotero.Items.get(ctx.parentID);
    const zs = installZotSeek({ results: [passage(a.key, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.')] });
    try {
      const col = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID).find((c: any) => c.name === 'SeekChat E2E Collection');
      const { collectionScope } = await import('../../src/core/library/library-context');
      const { saveLibraryChatAsNote } = await import('../../src/ui/save-note');
      const scope = collectionScope(col);
      const libSession = getSession(new LibraryContextProvider(scope));
      libSession.clear();
      await libSession.ask('Was steht zu Starkregen?');
      const note = await saveLibraryChatAsNote(libSession, scope);
      assert(note.isNote() && !note.parentItemID && note.getCollections().includes(col.id), 'library note not in the collection');
      assert(note.getNote().includes(`zotero://select/library/items/${a.key}`), `library note: ${note.getNote().slice(0, 400)}`);
      libSession.clear();
    } finally {
      zs.uninstall();
    }
  }],

  ['context menu: entries for one file and for a selection', async (ctx) => {
    const win = Zotero.getMainWindow();
    const a = Zotero.Items.get(ctx.parentID);
    const b = Zotero.Items.get(ctx.longParentID);
    win.Zotero_Tabs.select('zotero-pane');
    await win.ZoteroPane.collectionsView.selectLibrary(Zotero.Libraries.userLibraryID);
    await win.ZoteroPane.selectItems([a.id]);
    // Zotero 8+ has MenuManager: the entries come from there. Zotero 7: the next scenario tests the DOM fallback.
    if (!(Zotero as any).MenuManager) throw new SkipError('Zotero 7 has no MenuManager (DOM fallback: next scenario)');
    const popup = win.document.getElementById('zotero-itemmenu');
    popup.openPopup(null, 'overlap', 0, 0, true, false);
    const file = await waitFor('file entry', () => popup.querySelector('[data-l10n-id="seekchat-menu-chat-file"]'), 5000);
    assert(!file.hidden, 'file entry hidden for one item with PDF');
    assert(popup.querySelector('[data-l10n-id="seekchat-menu-chat-selection"]')?.hidden, 'selection entry shown for one item');
    popup.hidePopup();

    await win.ZoteroPane.selectItems([a.id, b.id]);
    let state = menuState();
    assert(!state.file && !state.selection && !state.selectionEnabled, `two items without ZotSeek: ${JSON.stringify(state)}`);
    const zs = installZotSeek();
    try {
      zs.addButton();
      state = menuState();
      assert(!state.selection, 'selection entry shown (library chat disabled since 1.0.0-rc.4)');
      chatWithSelection();
      const cw = await waitFor('chat window with the selection', () => {
        const w = getLibraryChatWindow();
        const sel = w?.document?.querySelector('.seekchat-library-scope') as HTMLSelectElement | null;
        return sel?.selectedOptions[0]?.textContent === '2 ausgewählte Einträge' ? w : null;
      }, 15000);
      cw.close();
    } finally {
      zs.uninstall();
    }

    await chatWithFile(a);
    const pane = win.document.getElementById('zotero-context-pane');
    await waitFor('reader with chat section', () => win.Zotero_Tabs.selectedType === 'reader' && findSection(pane), 10000);
    win.Zotero_Tabs.select('zotero-pane');
  }],

  ['context menu: Zotero 7 fallback adds the same entries to the DOM', async (ctx) => {
    const win = Zotero.getMainWindow();
    unregisterMenus();
    try {
      addLegacyMenu(win);
      await win.ZoteroPane.selectItems([ctx.parentID]);
      const popup = win.document.getElementById('zotero-itemmenu');
      popup.openPopup(null, 'overlap', 0, 0, true, false);
      await waitFor('legacy entries', () => {
        const file = win.document.getElementById('seekchat-menu-chat-file');
        const sel = win.document.getElementById('seekchat-menu-chat-selection');
        return file && !file.hidden && sel?.hidden && file.getAttribute('label') ? file : null;
      }, 5000);
      popup.hidePopup();
    } finally {
      removeLegacyMenu(win);
      // As on startup: MenuManager (Zotero 8+), else the DOM entries again (Zotero 7).
      if (!registerMenus(Zotero.SeekChat.info.id, `${Zotero.SeekChat.info.rootURI}content/icons/seekchat.svg`)) addLegacyMenu(win);
    }
  }],

  ['library window: books are pre-read into one answer, single books can be skipped, stop cancels', async (ctx) => {
    const a = Zotero.Items.get(ctx.parentID);
    const b = Zotero.Items.get(ctx.longParentID);
    assert(b.itemType === 'book' && a.itemType !== 'book', 'fixture item types changed');
    openLibraryChat(itemsScope([a, b]));
    const cw = await waitFor('chat window', () => {
      const w = getLibraryChatWindow();
      return w?.document?.getElementById('seekchat-source-books-keywords') ? w : null;
    }, 15000);
    const doc = cw.document;
    (doc.getElementById('seekchat-source-zotseek') as HTMLInputElement).click();
    (doc.getElementById('seekchat-source-books-keywords') as HTMLInputElement).click();
    await waitFor('book count', () => doc.querySelector('.seekchat-library-books')?.textContent?.startsWith('1 Buch mit PDF'), 10000);
    const input = await waitFor('input enabled without ZotSeek', () => {
      const t = doc.querySelector('textarea.seekchat-input') as HTMLTextAreaElement | null;
      return t && !t.disabled ? t : null;
    }, 5000);
    const session = getSession(new LibraryContextProvider(itemsScope([a, b])));
    session.clear();

    const send = (question: string) => {
      input.value = question;
      input.dispatchEvent(new cw.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    const ask = async (question: string) => {
      send(question);
      await waitFor('answer done', () => session.turns.length && !session.busy && session.turns.every((t) => !t.pending), 20000);
      return session.turns[session.turns.length - 1];
    };
    const before = (await mockRequests()).length;
    let t = await ask('Was sagt das Buch zum Stadtklima?');
    assert(session.turns.filter((x) => x.role === 'assistant').length === 1, 'more than one answer');
    assert(!t.error, `answer is an error: ${t.content}`);
    assert(t.bookProgress?.[0].state === 'found', `book state: ${JSON.stringify(t.bookProgress)}`);
    const source = t.sources?.find((s) => s.origin === 'book');
    assert(source?.n === 1 && source.label.includes('Langes Buch') && source.excerpts.every((e) => e.attachmentID === ctx.longAttachment.id),
      `book source: ${JSON.stringify(t.sources)}`);
    assert(t.content.includes('[1, S. 2]'), `answer: ${t.content}`);
    assert(t.meta?.includes('(Bücher 1)') && t.meta.includes('Bücher: 1 mit Fundstellen') && !t.meta.includes('Suchbegriffe:'), `meta: ${t.meta}`);
    assert(t.bookProgress?.[0].keywords?.length && t.bookProgress[0].pages?.length, `book details: ${JSON.stringify(t.bookProgress)}`);
    // Plan, pre-reading, answer: three requests, the answer sees the book's passages as a source.
    const reqs = (await mockRequests()).slice(before);
    const systems = reqs.map((r: any) => r.messages[0].content as string);
    // Per book like the PDF chat (language if not in metadata, search terms, answer from the pages), then the joint answer.
    const last = systems[systems.length - 1];
    // First question without ZotSeek: no planning call; the book makes its own search terms like the PDF chat.
    assert(!systems.some((x: string) => x.includes('literature search')) && systems.some((x: string) => x.includes('search terms for a keyword search'))
      && systems[systems.length - 2].includes('answer a question from one book') && last.includes('<sources>') && last.includes('(book)'), `requests: ${systems.map((x: string) => x.slice(0, 60)).join(' | ')}`);
    await waitFor('book list and source marked as book', () => doc.querySelector('.seekchat-books-progress li.state-found')
      && doc.querySelector('.seekchat-sources-list li')?.textContent?.includes('📖'), 5000);

    // SeekChat's hint after the first answer, then a follow-up that loads a page of source [1] (7e-2).
    assert(t.notice?.includes('Folgefragen besprechen'), `notice: ${t.notice}`);
    await waitFor('notice shown', () => doc.querySelector('.seekchat-msg.notice')?.textContent?.includes('S. 45'), 5000);
    const beforeLoad = (await mockRequests()).length;
    t = await ask('Was steht genau auf Seite 2 von [1]?');
    assert(!t.error && t.meta?.includes('Nachgeladen: [1] S. 2 (ganze Seiten)') && !t.notice, `load: ${t.meta} / ${t.content}`);
    const loadReqs = (await mockRequests()).slice(beforeLoad);
    assert(loadReqs[0].messages[0].content.includes('load_pages') && loadReqs[0].messages[1].content.includes('(book)'),
      `plan request: ${loadReqs[0].messages[1].content.slice(0, 300)}`);
    const lastSystem: string = loadReqs[loadReqs.length - 1].messages[0].content;
    assert(lastSystem.includes('S. 2, whole page') && lastSystem.includes('loaded in full'), `answer prompt: ${lastSystem.slice(0, 500)}`);

    // No keyword hits: the book is not read; the source cited before is carried into the answer.
    // Reworking the result: no new search, no book read again, only the cited passages come along.
    const beforeRework = (await mockRequests()).length;
    t = await ask('Fasse das zusammen.');
    const reworkSystems = (await mockRequests()).slice(beforeRework).map((r: any) => r.messages[0].content as string);
    assert(!t.error && !t.bookProgress && t.meta?.includes('keine neue Suche')
      && !reworkSystems.some((x: string) => x.includes('answer a question from one book')), `rework: ${t.meta} / ${JSON.stringify(t.bookProgress)}`);
    const reworkPrompt = reworkSystems[reworkSystems.length - 1];
    assert(reworkPrompt.includes('<sources>') && (reworkPrompt.match(/\(S\. \d+/g) || []).length <= 3, `rework prompt: ${reworkPrompt.slice(0, 600)}`);

    t = await ask('Was steht zu Vulkane?');
    assert(['nohits', 'none'].includes(t.bookProgress?.[0].state || ''), `book state: ${JSON.stringify(t.bookProgress)}`);
    assert(!t.error && t.meta?.includes('1 Quelle aus früheren Antworten') && t.sources?.[0]?.n === 1, `carried: ${t.meta} / ${t.content}`);

    // Skipping the book being read: the question still gets its answer.
    send('Was steht zur Hitze?');
    const skip = await waitFor('skip button while reading', () =>
      doc.querySelector('.seekchat-books-progress li.state-reading .seekchat-book-skip') as HTMLButtonElement | null, 10000);
    await screenshot(ctx, 'library-books', cw);
    skip.click();
    await waitFor('done after skip', () => !session.busy, 10000);
    t = session.turns[session.turns.length - 1];
    assert(t.bookProgress?.[0].state === 'skipped' && !t.error && t.meta?.includes('1 übersprungen'), `after skip: ${t.meta} / ${t.content}`);

    // Stop cancels the whole question.
    send('Und zu Hitze?');
    await waitFor('reading', () => session.turns[session.turns.length - 1].bookProgress?.[0].state === 'reading', 10000);
    session.stop();
    await waitFor('stopped', () => !session.busy, 10000);
    t = session.turns[session.turns.length - 1];
    assert(t.content.includes('[abgebrochen]') && t.bookProgress?.[0].state === 'skipped', `after stop: ${t.content}`);
    session.clear();
    cw.close();
  }],

  // Optional: real PDFs from test/assets (mounted read-only, not part of the image).
  // Reports what Zotero extracts into e2e/out/assets-report.json; fails only on errors.
  ['assets: real PDFs are analyzed (report)', async (ctx) => {
    const dir = Zotero.Prefs.get('seekchat.e2e.assetsDir');
    const win = Zotero.getMainWindow();
    let files: string[] = [];
    try {
      const children: string[] = await win.IOUtils.getChildren(dir);
      files = children.filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
    } catch {
      // no assets mounted
    }
    const report: any[] = [];
    const brief = (nodes: OutlineNode[]) => nodes.slice(0, 15).map((n) => `${n.title} [S. ${n.pageStart}–${n.pageEnd}, ~${n.tokens} Tok., ${n.children.length} Unterk.]`);
    for (const file of files) {
      const { attachment } = await importFixture(file.split('/').pop()!, file);
      const t0 = Date.now();
      const pages = await getPdfPages(attachment);
      const extractMs = Date.now() - t0;
      const fit = analyzeFit(pages, readPrefs().contextChars);
      const textOutline = buildOutline(pages);
      const t2 = Date.now();
      const pdfOutline = await new PdfContextProvider(attachment).outline();
      const outlineMs = Date.now() - t2;
      const t1 = Date.now();
      const sel = await new PdfContextProvider(attachment).build('Wie konfiguriere ich einen Workflow?', readPrefs().contextChars,
        { keywords: ['workflow', 'transition', 'status', 'Arbeitsablauf'] });
      report.push({
        file: file.split('/').pop(),
        pages: pages.length,
        emptyPages: pages.filter((p) => !p.text).length,
        extractMs,
        fit,
        firstPages: pages.slice(0, 3).map((p) => p.text.slice(0, 200)),
        samplePages: [0.25, 0.5, 0.75].map((f) => pages[Math.floor(pages.length * f)]?.text.slice(0, 300)),
        outlineMs,
        outline: { source: pdfOutline.source, count: pdfOutline.nodes.length, nodes: brief(pdfOutline.nodes) },
        textOutline: { source: textOutline.source, count: textOutline.nodes.length, nodes: brief(textOutline.nodes) },
        keywordSelection: { ms: Date.now() - t1, mode: sel.mode, pages: sel.includedPages, matched: sel.matchedPages, noMatches: sel.noMatches },
      });
    }
    await Zotero.File.putContentsAsync(`${ctx.outDir}/assets-report.json`, JSON.stringify(report, null, 2));
  }],

  // Optional: real model server. Skipped unless e2e/run.sh gets E2E_LIVE_URL.
  ['book with two PDFs: source list groups pages per PDF, each page opens its own PDF', async (ctx) => {
    const win = Zotero.getMainWindow();
    const book = new Zotero.Item('book');
    book.libraryID = Zotero.Libraries.userLibraryID;
    book.setField('title', 'Buch aus zwei PDFs');
    await book.saveTx();
    const part1 = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${ctx.fixturesDir}/seekchat-test.pdf`), parentItemID: book.id, title: 'Teil 1' });
    const part2 = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${ctx.fixturesDir}/seekchat-long.pdf`), parentItemID: book.id, title: 'Teil 2' });
    const ev = (att: any, title: string, page: number, text: string) => ({
      itemKey: book.key, libraryKey: 'user', label: 'Buch aus zwei PDFs', origin: 'book' as const, text, page, attachmentID: att.id, attachmentTitle: title,
    });
    // Step 7: the keyword reading gets one target per PDF.
    const targets = (await booksInScope(itemsScope([book]))).filter((x) => x.itemKey === book.key);
    assert(targets.length === 2 && targets.every((x) => x.label.includes('Teil')), `book targets: ${JSON.stringify(targets.map((x) => x.label))}; attachments ${JSON.stringify(book.getAttachments())} hashes ${JSON.stringify([part1, part2].map((x: any) => [x.id, x.isPDFAttachment(), x.attachmentHash]))}`);
    const set = buildSources([ev(part1, 'Teil 1', 2, 'Starkregen'), ev(part2, 'Teil 2', 27, 'Waermeinseln'), ev(part2, 'Teil 2', 2, 'Grundlagen')], 10_000);
    const turn: any = { role: 'assistant', content: 'Starkregen [1, S. 2]; Waermeinseln [1, S. 27].', sources: set.sources };
    const opened: [number, number | undefined][] = [];
    const { openSourceCitation } = await import('../../src/core/library/zotero-items');
    const node = renderTurn(win.document, turn, {
      onSource: (source, page, attachmentID) => {
        opened.push([page!, attachmentID]);
        void openSourceCitation(source, page, attachmentID);
      },
    }) as any;
    const text = node.textContent;
    assert(text.includes('Teil 1: S. 2') && text.includes('Teil 2: S. 2, 27'), `source list: ${text}`);
    // Page 2 exists in both PDFs: the link in the "Teil 2" group must open Teil 2.
    const links = Array.from(node.querySelectorAll('.seekchat-sources a, .seekchat-sources [role="link"], .seekchat-sources .seekchat-cite')) as any[];
    const teil2page2 = links.filter((a) => a.textContent === '2')[1];
    assert(teil2page2, `page links: ${links.map((a) => a.textContent).join(',')}`);
    teil2page2.click();
    await waitFor('reader with Teil 2', () => win.Zotero_Tabs.selectedType === 'reader'
      && Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID)?.itemID === part2.id, 10000);
    assert(opened[0][0] === 2 && opened[0][1] === part2.id, `opened ${JSON.stringify(opened)}`);
    // The inline citation [1, S. 27] resolves to Teil 2 by itself (only Teil 2 has page 27).
    win.Zotero_Tabs.select('zotero-pane');
    await openSourceCitation(set.sources[0], 27);
    await waitFor('reader with Teil 2 at page 27', () => Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID)?.itemID === part2.id, 10000);
    win.Zotero_Tabs.select('zotero-pane');
    await book.eraseTx();
  }],

  ['sources: coverage line and the SeekBook switch follow ZotSeek and SeekBook live', async () => {
    const zs = installZotSeek({ indexed: 5 });
    const server = (Zotero as any).Server;
    const restoreSeekBook = stashSeekBook();
    const installSeekBook = (books: number) => {
      (Zotero as any).SeekBook = { apiVersion: 1, standIn: true };
      const E: any = function () {};
      E.prototype = { supportedMethods: ['GET'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
        init: async (_req: any) => [200, 'application/json', JSON.stringify({ ready: books > 0, indexedBooks: books, queuedDocuments: 0, apiVersion: 1 })] };
      server.Endpoints['/seekbook/stats'] = E;
    };
    const removeSeekBook = () => {
      delete (Zotero as any).SeekBook;
      delete server.Endpoints['/seekbook/stats'];
    };
    // A sideloaded real SeekBook (live runs) is taken away for this scenario and restored at the end.
    removeSeekBook();
    const prefs = { excludeBooks: Zotero.Prefs.get('zotseek.excludeBooks', true), includeSeekBook: Zotero.Prefs.get('zotseek.includeSeekBook', true) };
    try {
      openLibraryChat(libraryScope(Zotero.Libraries.userLibraryID));
      const cw: any = await waitFor('chat window', () => getLibraryChatWindow()?.document?.getElementById('seekchat-source-books') ? getLibraryChatWindow() : null, 15000);
      const doc = cw.document;
      const box = doc.getElementById('seekchat-source-books') as HTMLInputElement;
      const zsBox = doc.getElementById('seekchat-source-zotseek') as HTMLInputElement;
      const note = () => doc.querySelector('.seekchat-library-seekbook')?.textContent || '';
      const coverage = () => doc.querySelector('.seekchat-library-coverage')?.textContent || '';
      const refocus = () => cw.dispatchEvent(new cw.Event('focus'));
      if (!zsBox.checked) zsBox.click();
      // Whole library: the keyword book search finds the books (getAll was not awaited before 0.9.2).
      const booksBoxKw = doc.getElementById('seekchat-source-books-keywords') as HTMLInputElement;
      booksBoxKw.click();
      await waitFor('books found in the whole library', () => /\d+ B(ü|u)ch/.test(doc.querySelector('.seekchat-library-books')?.textContent || ''), 10000);
      booksBoxKw.click();

      // 1. No SeekBook: locked, with the reason.
      await waitFor('locked without SeekBook', () => box.disabled && note().includes('nicht installiert'), 10000);
      await waitFor('coverage line', () => coverage().includes('ZotSeek durchsucht hier'), 10000);

      // 2. SeekBook ready, ZotSeek excludes books: allowed.
      installSeekBook(3);
      refocus();
      try {
        await waitFor('allowed with SeekBook', () => !box.disabled && note().includes('SeekBook: 3 Bücher indexiert'), 10000);
      } catch (e: any) {
        throw new Error(`${e.message}; disabled=${box.disabled}, note="${note()}", coverage="${coverage()}"`);
      }
      box.click();
      await waitFor('ticked', () => box.checked && !note().includes('Vorschau'), 5000);

      // 3. ZotSeek binds SeekBook: locked, and the tick is taken back (pref observer, no refocus).
      Zotero.Prefs.set('zotseek.includeSeekBook', true, true);
      await waitFor('locked via ZotSeek', () => box.disabled && !box.checked && note().includes('bindet SeekBook bereits ein')
        && coverage().includes('über SeekBook'), 10000);

      // 4. ZotSeek unticked: SeekBook can be asked directly; no coverage line for ZotSeek.
      zsBox.click();
      await waitFor('allowed without ZotSeek', () => !box.disabled && coverage() === '', 5000);
      zsBox.click();
      await waitFor('locked again with ZotSeek', () => box.disabled, 5000);

      // 5. ZotSeek with its own books (not bound): allowed, with the note on doubles once ticked.
      Zotero.Prefs.set('zotseek.includeSeekBook', false, true);
      Zotero.Prefs.set('zotseek.excludeBooks', false, true);
      await waitFor('allowed with native books', () => !box.disabled, 10000);
      box.click();
      await waitFor('note on doubles', () => note().includes('nur SeekBooks Stellen'), 5000);

      // 6. SeekBook switched off meanwhile: locked on the next focus, tick removed.
      removeSeekBook();
      refocus();
      await waitFor('locked after SeekBook left', () => box.disabled && !box.checked && note().includes('nicht installiert'), 10000);
      cw.close();
    } finally {
      removeSeekBook();
      restoreSeekBook();
      Zotero.Prefs.set('zotseek.excludeBooks', prefs.excludeBooks ?? true, true);
      Zotero.Prefs.set('zotseek.includeSeekBook', prefs.includeSeekBook ?? false, true);
      zs.uninstall();
    }
  }],

  ['library chat with SeekBook: indexed books from its index, ZotSeek doubles left out, chapter and printed page in the prompt', async (ctx) => {
    const a = Zotero.Items.get(ctx.parentID).key;
    const b = Zotero.Items.get(ctx.longParentID).key;
    const server = (Zotero as any).Server;
    const seen: Record<string, any[]> = { search: [], books: [] };
    const endpoint = (name: string, payload: (sp: URLSearchParams) => any) => {
      const E: any = function () {};
      E.prototype = { supportedMethods: ['GET'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
        init: async (req: any) => {
          (seen[name] ||= []).push(Object.fromEntries(req.searchParams));
          return [200, 'application/json', JSON.stringify(payload(req.searchParams))];
        } };
      return E;
    };
    const restoreSeekBook = stashSeekBook();
    (Zotero as any).SeekBook = { apiVersion: 1, standIn: true };
    server.Endpoints['/seekbook/stats'] = endpoint('stats', () => ({ ready: true, indexedBooks: 1, queuedDocuments: 0, apiVersion: 1 }));
    server.Endpoints['/seekbook/books'] = endpoint('books', () => ({ apiVersion: 1, books: [{ itemKey: b, searchable: true, readyDocuments: 1 }] }));
    server.Endpoints['/seekbook/search'] = endpoint('search', () => ({ source: 'seekbook', apiVersion: 1, results: [{
      itemKey: b, libraryKey: 'user', title: 'SeekChat E2E Langes Buch', authors: ['Muster'], year: 2021, score: 0.03,
      semanticScore: 0.8, keywordScore: 0.5, itemType: 'book',
      matchedChunk: { snippet: 'Waermeinseln entstehen durch versiegelte Flaechen und fehlende Verdunstung.', page: 27, pageEnd: 27, pageLabel: '25',
        chapter: 'Kapitel 2 Waermeinseln', textSource: 'book', attachmentKey: ctx.longAttachment.key, attachmentTitle: 'Volltext', chunkIndex: 12 },
    }] }));
    server.Endpoints['/seekbook/pages'] = endpoint('pages', () => ({ attachmentKey: ctx.longAttachment.key, attachmentTitle: 'Volltext',
      pages: [{ page: 27, label: '25', text: 'SEEKBOOK-SEITENTEXT bereinigt ohne Kopfzeile.' }] }));
    const zs = installZotSeek({ results: [
      passage(a, 'SeekChat E2E Testdokument', 2, 'Starkregenereignisse fuehren in Staedten zu Ueberflutungen.'),
      passage(b, 'SeekChat E2E Langes Buch', 27, 'Waermeinseln in dicht bebauten Quartieren erhoehen die naechtlichen Temperaturen.'),
    ] });
    try {
      const session = getSession(new LibraryContextProvider(libraryScope(Zotero.Libraries.userLibraryID)));
      session.clear();
      const before = (await mockRequests()).length;
      await session.ask('Was sagt meine Bibliothek zu Starkregen und Hitze?', {
        zotseek: true, seekbook: true, books: [{ attachment: ctx.longAttachment, label: 'SeekChat E2E Langes Buch', itemKey: b }],
      });
      const t = session.turns[session.turns.length - 1];
      assert(!t.error, `answer is an error: ${t.content}`);
      const book = t.sources?.find((s) => s.itemKey === b);
      const article = t.sources?.find((s) => s.itemKey === a);
      assert(book?.origin === 'book' && article?.origin === 'zotseek', `sources: ${JSON.stringify(t.sources)}`);
      assert(book.excerpts.length === 1 && book.excerpts[0].chapter === 'Kapitel 2 Waermeinseln' && book.excerpts[0].pageLabel === '25'
        && book.excerpts[0].attachmentID === ctx.longAttachment.id && book.excerpts[0].text.includes('versiegelte'), `book excerpts: ${JSON.stringify(book.excerpts)}`);
      assert(t.meta?.includes('1 ZotSeek-Stelle aus einem Buch weggelassen') && t.meta.includes('1 Buch über seinen Index durchsucht')
        && t.meta.includes('SeekBook: 1 Stelle'), `meta: ${t.meta}`);
      assert(!t.bookProgress, `keyword reading of an indexed book: ${JSON.stringify(t.bookProgress)}`);
      const reqs = (await mockRequests()).slice(before);
      const systems = reqs.map((r: any) => r.messages[0].content as string);
      assert(!systems.some((x) => x.includes('answer a question from one book')), 'the indexed book was read by keywords');
      const last = systems[systems.length - 1];
      assert(last.includes('chapter: Kapitel 2 Waermeinseln') && last.includes('(printed 25)') && last.includes('(book)'), `prompt: ${last.slice(0, 800)}`);
      assert(seen.search.length >= 1 && seen.search[0].libraryKey === 'user' && !seen.search[0].itemKeys, `seekbook query: ${JSON.stringify(seen.search)}`);
      // Step 5: pages of an indexed book come from SeekBook; step 6: the book SeekBook does not know is named.
      const nPages = seen.pages?.length || 0;
      await session.ask(`Was steht auf Seite 27 von [${book.n}]?`, { zotseek: false, seekbook: true });
      const tp = session.turns[session.turns.length - 1];
      const pagePrompt: string = (await mockLastRequest()).messages[0].content;
      assert(!tp.error && (seen.pages?.length || 0) === nPages + 1 && seen.pages[nPages].pages === '27' && seen.pages[nPages].attachmentKey === ctx.longAttachment.key
        && pagePrompt.includes('SEEKBOOK-SEITENTEXT'), `pages via SeekBook: ${tp.meta} / ${JSON.stringify(seen.pages)}`);
      // Follow-up on a new aspect: a supplementary search with few hits; searching in the book goes to SeekBook.
      const nSearch = seen.search.length;
      await session.ask('Und was steht zu Starkregen?', { zotseek: true, seekbook: true });
      const tf = session.turns[session.turns.length - 1];
      assert(tf.meta?.includes('im SeekBook-Index'), `no note on unindexed books: ${tf.meta}`);
      assert(!tf.error && tf.meta?.includes('ergänzender Suche') && seen.search.slice(nSearch).every((x) => x.topK === '8'),
        `top-up: ${tf.meta} / ${JSON.stringify(seen.search.slice(nSearch))}`);
      const bookN = tf.sources?.find((x) => x.itemKey === b)?.n ?? book.n;
      const nSearch2 = seen.search.length;
      await session.ask(`Suche in [${bookN}] nach Verdunstung`, { zotseek: true, seekbook: true });
      const td = session.turns[session.turns.length - 1];
      const docQuery = seen.search.slice(nSearch2).find((x) => x.q === 'Verdunstung');
      assert(!td.error && docQuery?.itemKeys === b && td.meta?.includes('(SeekBook): 1 Abschnitte'), `document search: ${td.meta} / ${JSON.stringify(seen.search.slice(nSearch2))}`);

      // ZotSeek already bringing SeekBook (switch locked) + keyword books: the indexed book is not read by keywords.
      session.clear();
      const beforeVia = (await mockRequests()).length;
      await session.ask('Was steht zu Hitze?', {
        zotseek: true, seekbook: false, skipIndexedBooks: true, books: [{ attachment: ctx.longAttachment, label: 'SeekChat E2E Langes Buch', itemKey: b }],
      });
      const tv = session.turns[session.turns.length - 1];
      const viaSystems = (await mockRequests()).slice(beforeVia).map((r: any) => r.messages[0].content as string);
      assert(!tv.error && !tv.bookProgress && !viaSystems.some((x) => x.includes('answer a question from one book'))
        && tv.meta?.includes('1 Buch über seinen Index'), `via ZotSeek: ${tv.meta} / ${JSON.stringify(tv.bookProgress)}`);
      // Collection scope: SeekBook only gets the scope's books.
      const col = new Zotero.Collection();
      col.name = 'SeekChat E2E SeekBook';
      await col.saveTx();
      const bItem = Zotero.Items.get(ctx.longParentID);
      bItem.addToCollection(col.id);
      await bItem.saveTx();
      try {
        const s2 = getSession(new LibraryContextProvider(collectionScope(col)));
        s2.clear();
        await s2.ask('Was steht zu Hitze?', { zotseek: false, seekbook: true });
        const t2 = s2.turns[s2.turns.length - 1];
        assert(!t2.error && t2.sources?.[0]?.itemKey === b, `collection answer: ${t2.content} ${JSON.stringify(t2.sources)}`);
        assert(seen.search[seen.search.length - 1].itemKeys === b && seen.books[seen.books.length - 1].itemKeys === b,
          `collection queries: ${JSON.stringify([seen.search, seen.books])}`);
      } finally {
        await col.eraseTx();
      }
    } finally {
      zs.uninstall();
      restoreSeekBook();
    }
  }],

  ['Tools menu: general chat (library chat disabled)', async () => {
    const doc = Zotero.getMainWindow().document;
    const popup = doc.getElementById('menu_ToolsPopup');
    const tools = await waitFor('tools menu entry', () => doc.getElementById('seekchat-tools-menu-tools-chat'), 5000);
    assert(tools.parentElement === popup, 'entry not in the Tools menu');
    assert(!doc.getElementById('seekchat-tools-menu-library-chat'), 'library chat entry (disabled since 1.0.0-rc.4)');
    tools.doCommand();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    toolsWin.close();
  }],

  // Zotero's own connection (NSS store of the profile) must accept the portal's certificate, signed by the in-house CA:
  // otherwise the plugin's automatic update check fails.
  ['tool chat: button without ZotSeek, references imported after confirmation, duplicates offered unchecked', async (ctx) => {
    const win = Zotero.getMainWindow();
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const button = await waitFor('tools button', () => getToolsToolbarButton(), 5000);
    assert(!getToolbarButton(), 'library chat button without ZotSeek');
    assert(button.previousElementSibling?.id === 'zotero-tb-lookup', `tools button after ${button.previousElementSibling?.id}`);
    const col = new Zotero.Collection();
    col.libraryID = Zotero.Libraries.userLibraryID;
    col.name = 'SeekChat Import E2E';
    await col.saveTx();
    await win.ZoteroPane.collectionsView.selectByID(`C${col.id}`);
    await waitFor('collection selected', () => win.ZoteroPane.getSelectedCollection()?.id === col.id, 5000);
    button.doCommand();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    assert(view.target?.collectionID === col.id, `target ${JSON.stringify(view.target)}`);
    const doc = toolsWin.document;
    const session = getToolSession();
    session.clear();

    // Plain question: answer without tools run.
    view.input.value = 'Hallo?';
    await view.send();
    const hello = session.turns[1];
    assert(hello.content === 'Hallo aus dem Werkzeug-Chat.' && !hello.toolRuns?.length, `hello: ${hello.content}`);

    // Import: preview, confirm in the window, items in the collection.
    view.input.value = 'Bitte importiere diese Quellen: …';
    const asked = view.send();
    const run = await waitFor('import preview', () => session.turns[3]?.toolRuns?.find((r) => r.state === 'confirm'), 15000);
    assert(run.items?.length === 2 && run.items.every((i) => i.selectable && i.checked && i.badge === 'Text'), `preview ${JSON.stringify(run.items)}`);
    // Ticking an item keeps the scroll position (no jump to the end while the preview waits).
    toolsWin.resizeTo(900, 380);
    const messages = doc.querySelector('.seekchat-messages') as HTMLElement;
    await waitFor('chat scrollable', () => messages.scrollHeight > messages.clientHeight + 60, 5000);
    messages.scrollTop = 0;
    const tick = await waitFor('preview checkbox', () => doc.querySelector('.seekchat-tool-items input[type=checkbox]') as HTMLInputElement, 5000);
    tick.click();
    await delay(300);
    assert(messages.scrollTop === 0, `scrolled to ${messages.scrollTop} after unticking`);
    assert(!run.items![0].checked, 'untick not taken over');
    (doc.querySelector('.seekchat-tool-items input[type=checkbox]') as HTMLInputElement).click();
    await delay(300);
    assert(messages.scrollTop === 0 && run.items![0].checked, `after ticking again: ${messages.scrollTop}`);
    toolsWin.resizeTo(900, 600);
    const ok = await waitFor('confirm button', () => doc.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000);
    ok.click();
    await asked;
    const answer = session.turns[3];
    assert(run.state === 'done' && run.items!.every((i) => i.itemID), `run ${run.state}: ${JSON.stringify(run.items)}`);
    assert(/Erledigt: 2 gespeichert/.test(answer.content), `answer: ${answer.content}`);
    const items = Zotero.Items.get(col.getChildItems(true));
    const byTitle = (title: string) => (items as any[]).find((i) => i.getField('title').startsWith(title));
    assert(items.length === 2, `${items.length} items in collection`);
    const article = byTitle('Klimawandel im urbanen');
    assert(article?.itemType === 'journalArticle' && article.getField('publicationTitle') === 'Environmental Sciences Europe' && article.getCreators()[0]?.lastName === 'Kuttler',
      `article ${article?.itemType} ${article?.getField('publicationTitle')}`);
    const report = byTitle('Hitze in der Stadt');
    assert(report?.itemType === 'report' && report.getField('institution') === 'Umweltbundesamt' && report.getCreators()[0]?.fieldMode === 1,
      `report ${report?.itemType} ${report?.getField('institution')} ${JSON.stringify(report?.getCreators())}`);
    // PDF: the report's link is downloaded and attached; the article has neither DOI nor link.
    const pdfs = Zotero.Items.get(report.getAttachments()).filter((a: any) => a.attachmentContentType === 'application/pdf');
    assert(pdfs.length === 1 && await pdfs[0].fileExists(), `report PDFs: ${pdfs.length}`);
    assert(!article.getAttachments().length, 'article got an attachment');
    assert(/PDF angehängt/.test(run.items![1].detail || '') && /keine PDF-Suche/.test(run.items![0].detail || ''), `details ${run.items!.map((i) => i.detail).join(' | ')}`);
    assert(/1 PDF angehängt/.test(run.status || ''), `status ${run.status}`);
    // Right after the import (new items, PDF just attached and being indexed) the item context menu still opens.
    await win.ZoteroPane.selectItems([article.id, report.id]);
    const built = await Promise.race([win.ZoteroPane.buildItemContextMenu().then(() => 'built'), delay(10000).then(() => 'timeout')]);
    assert(built === 'built', 'item context menu not built within 10 s after the import');
    await win.ZoteroPane.selectItems([report.id]);
    await win.ZoteroPane.buildItemContextMenu();
    const menu = win.document.getElementById('zotero-itemmenu');
    menu.openPopup(null, 'overlap', 0, 0, true, false);
    await waitFor('item menu open', () => menu.state === 'open', 5000);
    const entry = await waitFor('SeekChat entry for the new PDF', () => menu.querySelector('[data-l10n-id="seekchat-menu-chat-file"]:not([hidden])'), 5000)
      .catch((e) => {
        const ours = Array.from(menu.querySelectorAll('[data-l10n-id^="seekchat"], [id^="seekchat"]')) as Element[];
        throw new Error(`${e.message}; state ${JSON.stringify(menuState([report]))}, attachments ${JSON.stringify(Zotero.Items.get(report.getAttachments()).map((a: any) => a.attachmentContentType))}, `
          + `entries ${JSON.stringify(ours.map((x) => [x.id, x.getAttribute('data-l10n-id'), x.hasAttribute('hidden')]))}`);
      });
    assert(entry, 'no SeekChat entry for the imported item with PDF');
    menu.hidePopup();
    const toolMsg = (await mockLastRequest()).messages.find((m: any) => m.role === 'tool');
    assert(toolMsg && JSON.parse(toolMsg.content).saved === 2, `tool result to model: ${toolMsg?.content}`);
    const link = Array.from(doc.querySelectorAll('.seekchat-tool-run .seekchat-cite')) as HTMLElement[];
    assert(link.length === 2, `${link.length} item links`);

    // Same references again: both already there, unchecked; cancel saves nothing.
    view.input.value = 'Importiere sie nochmal';
    const again = view.send();
    const run2 = await waitFor('second preview', () => session.turns[5]?.toolRuns?.find((r) => r.state === 'confirm'), 15000);
    assert(run2.items!.every((i) => !i.checked && i.itemID), `duplicates ${JSON.stringify(run2.items)}`);
    assert((doc.querySelector('.seekchat-tool-ok') as HTMLButtonElement)?.disabled, 'import button enabled without selection');
    (doc.querySelector('.seekchat-tool-cancel') as HTMLButtonElement).click();
    await again;
    assert(run2.state === 'cancelled' && col.getChildItems(true).length === 2, `after cancel: ${run2.state}, ${col.getChildItems(true).length} items`);
    await screenshot(ctx, 'tool-chat', toolsWin);
    toolsWin.close();
    await waitFor('tool chat window closed', () => !getToolsChatView(), 5000);
  }],

  ['tool chat: tool list switches tools off; parser option uses zotero-reference only when installed', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    const doc = toolsWin.document;
    const session = getToolSession();
    session.clear();
    const list = doc.querySelector('.seekchat-tools-list') as HTMLDetailsElement;
    assert(list && /11 von 13/.test(list.querySelector('summary')!.textContent!), `summary ${list?.querySelector('summary')?.textContent}`);
    list.open = true;
    const item = () => doc.querySelector('.seekchat-tools-item[data-tool="import_references"]') as HTMLElement;
    const select = () => item().querySelector('select[data-option="parser"]') as HTMLSelectElement;
    const findrefsOption = () => Array.from(select().options).find((o) => o.value === 'zotero-reference')!;
    assert(findrefsOption().disabled, 'zotero-reference offered without the plugin');

    // Off: no tools sent, the model just answers.
    const box = item().querySelector('input[type=checkbox]') as HTMLInputElement;
    box.click();
    assert(Zotero.Prefs.get('seekchat.tools.disabled') === 'import_references', `pref ${Zotero.Prefs.get('seekchat.tools.disabled')}`);
    assert(/10 von 13/.test(doc.querySelector('.seekchat-tools-list summary')!.textContent!), 'summary not updated');
    view.input.value = 'Bitte importiere das';
    await view.send();
    const req = await mockLastRequest();
    const offered = (req.tools || []).map((x: any) => x.function.name);
    assert(!offered.includes('import_references') && offered.includes('search_library') && !session.turns[1].toolRuns?.length, `tools sent: ${offered}`);
    (item().querySelector('input[type=checkbox]') as HTMLInputElement).click();
    assert(!Zotero.Prefs.get('seekchat.tools.disabled'), 'tool not switched on again');

    // Stand-in for Find Online References: its lookup finds the article, the report stays unknown.
    const lookups: any[] = [];
    (Zotero as any).FindOnlineReferences = { api: {
      version: 1,
      parseReference: (text: string) => ({ text, title: text.split('. ')[0], authors: [], identifiers: {} }),
      lookup: async (ref: any) => {
        lookups.push(ref);
        return /Klimawandel/.test(ref.title) ? { title: 'Klimawandel im urbanen Bereich (OpenAlex)', authors: ['Kuttler, Wilhelm'], year: '2011', identifiers: {}, type: 'journalArticle', venue: 'ESEU', source: 'openalex' } : undefined;
      },
    } };
    try {
      toolsWin.dispatchEvent(new toolsWin.Event('focus'));
      await waitFor('zotero-reference offered', () => !findrefsOption().disabled, 5000);
      select().value = 'zotero-reference';
      select().dispatchEvent(new toolsWin.Event('change'));
      assert(Zotero.Prefs.get('seekchat.tools.import_references.parser') === 'zotero-reference', 'option not stored');
      session.clear();
      view.input.value = 'Bitte importiere diese Quellen';
      const asked = view.send();
      const run = await waitFor('preview', () => session.turns[1]?.toolRuns?.find((r) => r.state === 'confirm'), 15000);
      assert(lookups.length === 2, `${lookups.length} lookups`);
      assert(run.items![0].label.includes('(OpenAlex)') && /openalex/.test(run.items![0].detail || ''), `first ${JSON.stringify(run.items![0])}`);
      assert(/Quellentext/.test(run.items![1].detail || ''), `second falls back to text: ${run.items![1].detail}`);
      session.confirm(run, false);
      await asked;
      // "Chat als .md" writes question, tool call with its items and the answer (file picker skipped in tests).
      const mdPath = `${ctx.outDir}/tool-chat-export.md`;
      setSaveChatTestPath(mdPath);
      const saveBtn = doc.querySelector('.seekchat-library-footer .seekchat-save') as HTMLButtonElement;
      await waitFor('save button enabled', () => !saveBtn.disabled, 5000);
      saveBtn.click();
      const exported = await waitFor('exported tool chat', async () => {
        try {
          const text: string = await Zotero.File.getContentsAsync(mdPath);
          return text.includes('Werkzeug:') ? text : null;
        } catch {
          return null;
        }
      }, 5000);
      setSaveChatTestPath(null);
      assert(exported.startsWith('# SeekChat – Chatte mit deiner Literatur (') && exported.includes('> Bitte importiere diese Quellen')
        && exported.includes('Klimawandel im urbanen Bereich (OpenAlex)'), `export: ${exported.slice(0, 600)}`);
    } finally {
      delete (Zotero as any).FindOnlineReferences;
      Zotero.Prefs.set('seekchat.tools.import_references.parser', 'zotero');
    }
    // Plugin gone: the stored choice would fall back; the option is offered disabled again.
    toolsWin.dispatchEvent(new toolsWin.Event('focus'));
    await waitFor('zotero-reference disabled again', () => findrefsOption().disabled, 5000);
    await screenshot(ctx, 'tool-list', toolsWin);
    toolsWin.close();
    await waitFor('tool chat window closed', () => !getToolsChatView(), 5000);
  }],

  ['documents: web page, EPUB and text file are chatted with like a PDF, without page citations', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const win = Zotero.getMainWindow();
    const { IOUtils, PathUtils } = win as any;
    const dir = PathUtils.join(Zotero.getTempDirectory().path, `seekchat-docs-${Date.now()}`);
    await IOUtils.makeDirectory(dir);
    const write = (name: string, text: string) => IOUtils.writeUTF8(PathUtils.join(dir, name), text);
    const para = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic} Absatz ${i}: ` + 'Fülltext über Stadtklima und Grünflächen. '.repeat(12)).join('\n\n');
    await write('hitze.html', `<html><head><meta charset="utf-8"><title>Hitze</title><script>var geheim = 'SKRIPT';</script></head><body><h1>Hitzeschutz in St&auml;dten</h1><p>Begrünte Dächer kühlen Quartiere um bis zu zwei Grad.</p></body></html>`);
    await write('notizen.txt', `Protokoll Workshop\n\nDie Teilnehmenden nannten Trinkbrunnen als wichtigste Maßnahme.\n\n${para('Text', 150)}`);
    const epubDir = PathUtils.join(dir, 'epub');
    await IOUtils.makeDirectory(PathUtils.join(epubDir, 'META-INF'), { createAncestors: true });
    await IOUtils.writeUTF8(PathUtils.join(epubDir, 'mimetype'), 'application/epub+zip');
    await IOUtils.writeUTF8(PathUtils.join(epubDir, 'META-INF', 'container.xml'), '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    await IOUtils.writeUTF8(PathUtils.join(epubDir, 'content.opf'), '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">seekchat-e2e</dc:identifier><dc:title>Stadtbaeume</dc:title><dc:language>de</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
    await IOUtils.writeUTF8(PathUtils.join(epubDir, 'c1.xhtml'), '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kapitel 1</title></head><body><h1>Kapitel 1</h1><p>Stadtbäume spenden Schatten und senken die gefühlte Temperatur deutlich.</p></body></html>');
    const epubPath = PathUtils.join(dir, 'baeume.epub');
    await Zotero.File.zipDirectory(epubDir, epubPath);

    const make = async (title: string, file: string, contentType: string) => {
      const parent = new Zotero.Item('webpage');
      parent.setField('title', title);
      await parent.saveTx();
      const att = await Zotero.Attachments.importFromFile({ file: PathUtils.join(dir, file), parentItemID: parent.id, contentType });
      return { parent, att };
    };
    const html = await make('Hitzeschutz in Städten', 'hitze.html', 'text/html');
    const text = await make('Workshop-Protokoll', 'notizen.txt', 'text/plain');
    const epub = await make('Stadtbäume', 'baeume.epub', 'application/epub+zip');
    for (const [d, kind] of [[html, 'html'], [text, 'text'], [epub, 'epub']] as const) {
      assert(docKind(d.att) === kind, `${kind}: kind ${docKind(d.att)} (${d.att.attachmentContentType})`);
      const resolved = await resolveAttachment(d.parent, 'library', win.document);
      assert(resolved?.id === d.att.id, `${kind}: chat would use ${resolved?.id}`);
      assert(menuState([d.parent]).file, `${kind}: no "chat with this file" entry`);
    }

    const ask = async (att: any, q: string) => {
      const session = getSession(new PdfContextProvider(att));
      session.clear();
      await session.ask(q);
      const answer = session.turns[session.turns.length - 1];
      const req = await mockLastRequest();
      return { answer, system: String(req.messages[0].content) };
    };
    const h = await ask(html.att, 'Was kühlt Quartiere?');
    assert(!h.answer.error, `html: ${h.answer.content}`);
    assert(h.system.includes('Begrünte Dächer kühlen Quartiere') && h.system.includes('Hitzeschutz in Städten'), `html text missing: ${h.system.slice(h.system.indexOf("Document:"), h.system.indexOf("Document:") + 500)}`);
    assert(!h.system.includes('SKRIPT') && /saved web page without page numbers/.test(h.system) && !/\[S\. 12\]/.test(h.system), 'html prompt');
    assert(h.answer.meta?.includes('Volltext (Webseite)'), `html meta ${h.answer.meta}`);

    const e = await ask(epub.att, 'Was leisten Stadtbäume?');
    assert(!e.answer.error && e.system.includes('Stadtbäume spenden Schatten') && /e-book \(EPUB\)/.test(e.system), `epub: ${e.answer.content} / ${e.system.slice(0, 400)}`);

    // Long text file: excerpts of sections, the one with the question's words among them.
    const x = await ask(text.att, 'Welche Maßnahme nannten die Teilnehmenden im Workshop als wichtigste? Trinkbrunnen?');
    assert(!x.answer.error && x.system.includes('Trinkbrunnen als wichtigste Maßnahme') && /text file without page numbers/.test(x.system), `text: ${x.answer.content}`);
    assert(/Auszüge \(Textdatei\): \d+ von \d+ Abschnitten/.test(x.answer.meta || '') || x.answer.meta?.includes('Volltext (Textdatei)'), `text meta ${x.answer.meta}`);

    // Item pane section shows the web page as the chat's document.
    const section = await openSectionInLibrary(html.parent.id);
    await waitFor('section target', () => /Webseite: .*Hitzeschutz/.test(section.querySelector('.seekchat-target')?.textContent || ''), 10000)
      .catch((e) => { throw new Error(`${e.message}: ${section.querySelector('.seekchat-target')?.textContent}`); });
  }],

  ['tool chat: library tools search with Zotero, ZotSeek and SeekBook (as set), read items, selection, collections, tags', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const win = Zotero.getMainWindow();
    const lib = Zotero.Libraries.userLibraryID;
    const parent = new Zotero.Collection({ libraryID: lib, name: 'E2E Suche' });
    await parent.saveTx();
    const child = new Zotero.Collection({ libraryID: lib, name: 'E2E Hitze', parentID: parent.id });
    await child.saveTx();
    const make = async (type: string, title: string, year: string, last: string, tags: string[], collections: number[]) => {
      const item = new Zotero.Item(type);
      item.setField('title', title);
      item.setField('date', year);
      item.setCreators([{ creatorType: 'author', firstName: 'Eva', lastName: last }]);
      for (const tag of tags) item.addTag(tag);
      item.setCollections(collections);
      await item.saveTx();
      return item;
    };
    const a = await make('journalArticle', 'Hitzeinseln in Großstädten', '2018', 'Schmidt', ['E2E-Hitze', 'Methode/Messung'], [child.id]);
    const b = await make('book', 'Stadtgrün und Gesundheit', '2005', 'Berger', ['E2E-Hitze'], [parent.id]);
    const c = await make('report', 'Starkregenvorsorge', '2021', 'Klein', [], []);
    const note = new Zotero.Item('note');
    note.setNote('<h1>Lesenotiz</h1><p>Messnetz mit 40 Stationen.</p>');
    note.parentID = a.id;
    await note.saveTx();

    const server = (Zotero as any).Server;
    const restoreSeekBook = stashSeekBook();
    const E = (payload: () => any) => {
      const F: any = function () {};
      F.prototype = { supportedMethods: ['GET'], supportedDataTypes: ['application/json'], permitBookmarklet: false,
        init: async (_req: any) => [200, 'application/json', JSON.stringify(payload())] };
      return F;
    };
    (Zotero as any).SeekBook = { apiVersion: 1, standIn: true };
    server.Endpoints['/seekbook/stats'] = E(() => ({ ready: true, indexedBooks: 1, queuedDocuments: 0, apiVersion: 1 }));
    server.Endpoints['/seekbook/search'] = E(() => ({ source: 'seekbook', apiVersion: 1, results: [{
      itemKey: b.key, libraryKey: 'user', title: 'Stadtgrün', authors: ['Berger'], year: 2005, score: 0.03, semanticScore: 0.8, keywordScore: null,
      matchedChunk: { snippet: 'Hitzeperioden belasten ältere Menschen besonders.', page: 40, pageLabel: '38', chapter: 'Kapitel 2', textSource: 'book' },
    }] }));
    const zs = installZotSeek({ results: [passage(c.key, 'Starkregenvorsorge', 3, 'Hitze und Starkregen hängen im Klimawandel zusammen.')] });
    const prefs = ['seekchat.tools.search_library.zotseek', 'seekchat.tools.search_library.seekbook'];
    try {
      openToolsChat();
      const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
      const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
      view.setTarget(`l${lib}`);
      const session = getToolSession();
      session.clear();
      const call = async (name: string, args: object) => {
        view.input.value = `TOOL ${name} ${JSON.stringify(args)}`;
        await view.send();
        const turn = session.turns[session.turns.length - 1];
        const req = await mockLastRequest();
        const toolMsg = [...req.messages].reverse().find((m: any) => m.role === 'tool');
        assert(!turn.error && toolMsg, `${name}: ${turn.content}`);
        let result: any;
        try {
          result = JSON.parse(toolMsg.content);
        } catch {
          result = { text: toolMsg.content };
        }
        return { run: turn.toolRuns![0], result, answer: turn.content };
      };

      // All three sources: Zotero finds the title, ZotSeek and SeekBook their passages.
      const all = await call('search_library', { query: 'Hitze' });
      const keys = all.result.results?.map((r: any) => r.key);
      assert(keys?.includes(a.key) && keys.includes(b.key) && keys.includes(c.key), `keys ${keys} / ${JSON.stringify(all.result).slice(0, 500)} / ${all.run.status}`);
      assert(all.result.sources.zotero >= 1 && all.result.sources.zotseek === 1 && all.result.sources.seekbook === 1, `sources ${JSON.stringify(all.result.sources)}`);
      const bookHit = all.result.results.find((r: any) => r.key === b.key);
      assert(bookHit.foundBy.includes('seekbook') && /Kapitel 2, S\. 38/.test(bookHit.excerpts[0].where), `book hit ${JSON.stringify(bookHit)}`);
      assert(/ZotSeek: 1 Treffer · SeekBook: 1 Treffer/.test(all.run.status || ''), `status ${all.run.status}`);
      assert(all.run.items!.every((i) => i.itemID), 'items without link');
      assert(/Ergebnis search_library: \d+/.test(all.answer), `answer ${all.answer}`);
      const doc = toolsWin.document;
      // The window repaints at most every 60 ms.
      await waitFor('item links in the window', () => doc.querySelectorAll('.seekchat-tool-run .seekchat-cite').length >= 3, 5000);

      // Filters apply to passage hits too: year from 2020 keeps only the report.
      const recent = await call('search_library', { query: 'Hitze', year_from: 2020 });
      assert(recent.result.results.map((r: any) => r.key).join() === c.key, `year filter ${JSON.stringify(recent.result.results.map((r: any) => r.label))}`);

      // Collection (with subcollections) and tags, Zotero's search only.
      const inCol = await call('search_library', { collection: 'E2E Suche', tags: ['E2E-Hitze'], sources: ['zotero'] });
      assert(inCol.result.results.map((r: any) => r.key).sort().join() === [a.key, b.key].sort().join(), `collection ${JSON.stringify(inCol.result)}`);
      assert(inCol.result.sources.zotseek === 'switched off' || inCol.result.sources.zotseek === 'not asked (no free-text query, or included in ZotSeek)', `zotseek ${inCol.result.sources.zotseek}`);

      // Option ZotSeek "do not use": no ZotSeek hit any more.
      Zotero.Prefs.set(prefs[0], 'off');
      const noZs = await call('search_library', { query: 'Hitze' });
      assert(noZs.result.sources.zotseek === 'switched off' && !noZs.result.results.some((r: any) => r.key === c.key), `zotseek off ${JSON.stringify(noZs.result.sources)}`);
      Zotero.Prefs.set(prefs[0], 'on');

      // Read one item with notes and collections.
      const item = await call('get_item', { key: a.key, include: ['fields', 'notes', 'collections', 'tags'] });
      assert(item.result.fields.title === 'Hitzeinseln in Großstädten' && item.result.notes[0].text.includes('40 Stationen'), `item ${JSON.stringify(item.result).slice(0, 400)}`);
      assert(item.result.collections.includes('E2E Suche / E2E Hitze') && item.result.tags.includes('Methode/Messung'), `item collections ${item.result.collections}`);
      const missing = await call('get_item', { key: 'NOSUCHKY' });
      assert(missing.run.state === 'error', 'unknown key not reported');

      // Collections as paths, tags with counts.
      const cols = await call('list_collections', { parent: 'E2E Suche' });
      assert(cols.result.collections.map((x: any) => x.path).join('|') === 'E2E Suche|E2E Suche / E2E Hitze', `collections ${JSON.stringify(cols.result)}`);
      const tags = await call('list_tags', { filter: 'E2E-' });
      assert(tags.result.tags.length === 1 && tags.result.tags[0].tag === 'E2E-Hitze' && tags.result.tags[0].items === 2, `tags ${JSON.stringify(tags.result)}`);

      // Selection: the items selected in the library.
      win.Zotero_Tabs.select('zotero-pane');
      await win.ZoteroPane.collectionsView.selectLibrary(lib);
      await win.ZoteroPane.selectItems([a.id, b.id]);
      const sel = await call('get_selection', {});
      assert(sel.result.selectedItems.map((x: any) => x.key).sort().join() === [a.key, b.key].sort().join(), `selection ${JSON.stringify(sel.result)}`);

      // Save found items into a new nested collection: preview, confirm, created and filled; unknown keys reported.
      const doc2 = toolsWin.document;
      view.input.value = `TOOL save_to_collection ${JSON.stringify({ collection: 'E2E Suche / Ergebnisse Hitze', keys: [a.key, c.key, 'NOSUCHKY'] })}`;
      const saving = view.send();
      const run = await waitFor('collection preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(run.items!.length === 3 && run.items![0].checked && run.items![1].checked && !run.items![2].selectable, `preview ${JSON.stringify(run.items)}`);
      assert(/Neue Sammlung „E2E Suche \/ Ergebnisse Hitze“/.test(run.status || ''), `status ${run.status}`);
      const ok = await waitFor('confirm button', () => doc2.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000);
      assert(ok.textContent === 'Anlegen und speichern', `button ${ok.textContent}`);
      ok.click();
      await saving;
      const made = Zotero.Collections.getByLibrary(lib, true).find((x: any) => x.name === 'Ergebnisse Hitze');
      assert(made && made.parentID === parent.id, 'collection not created below "E2E Suche"');
      assert(made.getChildItems(true).sort().join() === [a.id, c.id].sort().join(), `items in collection: ${made.getChildItems(true)}`);
      const saved = JSON.parse([...(await mockLastRequest()).messages].reverse().find((m: any) => m.role === 'tool').content);
      assert(saved.added === 2 && saved.created.join() === 'Ergebnisse Hitze' && saved.notFound.join() === 'NOSUCHKY', `result ${JSON.stringify(saved)}`);

      // Again into the same collection: both already inside (unchecked), nothing to confirm; cancel.
      view.input.value = `TOOL save_to_collection ${JSON.stringify({ collection: 'Ergebnisse Hitze', keys: [a.key, c.key] })}`;
      const again = view.send();
      const run2 = await waitFor('second preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(run2.items!.every((i) => !i.checked && i.badge === 'schon enthalten'), `again ${JSON.stringify(run2.items)}`);
      assert((await waitFor('ok', () => doc2.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000)).disabled, 'confirm enabled with nothing to add');
      (doc2.querySelector('.seekchat-tool-cancel') as HTMLButtonElement).click();
      await again;
      assert(run2.state === 'cancelled' && made.getChildItems(true).length === 2, `after cancel ${run2.state}`);

      // Reference list of a document through Find Online References: without the plugin the tools are not offered.
      const offeredNow = ((await mockLastRequest()).tools || []).map((x: any) => x.function.name);
      assert(!offeredNow.includes('get_document_references'), 'reference tools offered without the plugin');
      const listItem = doc2.querySelector('.seekchat-tools-item[data-tool="get_document_references"]');
      assert(listItem?.classList.contains('unavailable') && /Find Online References/.test(listItem.textContent || ''), 'tool not greyed out');
      const asked: any[] = [];
      (Zotero as any).FindOnlineReferences = { api: {
        version: 1,
        parseReference: (text: string) => ({ text, authors: [], identifiers: {} }),
        lookup: async () => undefined,
        getReferences: async (item: any) => {
          asked.push(item.key);
          return { attachmentKey: item.key, itemKey: item.key, source: 'pdf', references: [
            { number: 1, text: 'Berger, E. (2005): Stadtgrün und Gesundheit. München.', title: 'Stadtgrün und Gesundheit', authors: ['Berger'], year: '2005', identifiers: {} },
            { number: 2, text: 'Oke, T. (1982): The energetic basis of the urban heat island. QJRMS 108, 1-24.', title: 'The energetic basis of the urban heat island', authors: ['Oke'], year: '1982', identifiers: { DOI: '10.1002/qj.49710845502' } },
            { number: 3, text: 'Umweltbundesamt (2019): Hitze in der Stadt. Dessau.', title: 'Hitze in der Stadt', authors: [], year: '2019', identifiers: {} },
          ] };
        },
        findInLibrary: async (ref: any) => (/Stadtgrün/.test(ref.title || '') ? b : undefined),
      } };
      try {
        toolsWin.dispatchEvent(new toolsWin.Event('focus'));
        await waitFor('reference tools usable', () => !doc2.querySelector('.seekchat-tools-item[data-tool="get_document_references"]')?.classList.contains('unavailable'), 5000);
        const list = await call('get_document_references', { key: a.key });
        assert(asked[0] === a.key && list.result.total === 3 && list.result.references[1].doi === '10.1002/qj.49710845502', `list ${JSON.stringify(list.result).slice(0, 400)}`);
        const shown = await call('show_references', { key: a.key, numbers: [1, 2, 3, 9], reasons: { 2: 'Grundlagenwerk zu Wärmeinseln' } });
        const links = shown.run.items!;
        assert(links.length === 3 && links[0].itemID === b.id && links[0].badge === 'in Bibliothek', `first ${JSON.stringify(links[0])}`);
        assert(links[1].url === 'https://doi.org/10.1002/qj.49710845502' && links[1].detail === 'Grundlagenwerk zu Wärmeinseln', `second ${JSON.stringify(links[1])}`);
        assert(links[2].url?.startsWith('https://scholar.google.com/scholar?q=Hitze') && links[2].badge === 'Suche', `third ${JSON.stringify(links[2])}`);
        assert(shown.result.shown.find((x: any) => x.n === 9).status === 'no such entry', 'unknown number not reported');
        // The window repaints at most every 60 ms: wait for the run with its three links.
        await waitFor('links rendered', () => {
          const rendered = Array.from(doc2.querySelectorAll('.seekchat-tool-run') as NodeListOf<Element>).pop();
          return rendered?.querySelectorAll('.seekchat-cite').length === 3;
        }, 5000);
      } finally {
        delete (Zotero as any).FindOnlineReferences;
      }

      // The system prompt names today's date.
      const req = await mockLastRequest();
      assert(new RegExp(`Today is ${new Date().toISOString().slice(0, 10)}`).test(req.messages[0].content), 'no date in the prompt');
      await screenshot(ctx, 'library-tools', toolsWin);
      toolsWin.close();
      await waitFor('tool chat window closed', () => !getToolsChatView(), 5000);
    } finally {
      for (const p of prefs) Zotero.Prefs.set(p, 'on');
      zs.uninstall();
      restoreSeekBook();
    }
  }],

  ['tool chat: update_item changes type, fields and tags after confirmation (mapped fields kept, dropped ones reported); read_document reads pages; search pages with fields', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const lib = Zotero.Libraries.userLibraryID;
    const make = async (type: string, title: string, fields: Record<string, string>, tags: string[]) => {
      const item = new Zotero.Item(type);
      item.setField('title', title);
      for (const [k, v] of Object.entries(fields)) item.setField(k, v);
      for (const tag of tags) item.addTag(tag);
      await item.saveTx();
      return item;
    };
    const one = await make('journalArticle', 'E2E Typprüfung Buch', { publicationTitle: 'Zeitschrift Z', volume: '3', DOI: '10.1000/e2e-typ' }, ['E2E-Typ', 'E2E-Weg']);
    const two = await make('journalArticle', 'E2E Typprüfung Kapitel', { publicationTitle: 'Sammelband S' }, ['E2E-Typ']);
    const att = await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${ctx.fixturesDir}/seekchat-long.pdf`), parentItemID: two.id });
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    view.setTarget(`l${lib}`);
    const session = getToolSession();
    session.clear();
    try {
      const doc = toolsWin.document;
      const lastTool = async () => {
        const req = await mockLastRequest();
        const msg = [...req.messages].reverse().find((m: any) => m.role === 'tool');
        try { return JSON.parse(msg.content); } catch { return { text: msg.content }; }
      };
      const call = async (name: string, args: object) => {
        view.input.value = `TOOL ${name} ${JSON.stringify(args)}`;
        await view.send();
        const turn = session.turns[session.turns.length - 1];
        assert(!turn.error, `${name}: ${turn.content}`);
        return { run: turn.toolRuns![0], result: await lastTool() };
      };

      // Search with chosen fields and paging.
      const page = await call('search_library', { tags: ['E2E-Typ'], sources: ['zotero'], fields: ['DOI', 'publicationTitle', 'volume'], limit: 1 });
      assert(page.result.total === 2 && page.result.shown === 1, `paging ${JSON.stringify(page.result).slice(0, 300)}`);
      const page2 = await call('search_library', { tags: ['E2E-Typ'], sources: ['zotero'], fields: ['DOI'], limit: 1, offset: 1 });
      const both = [page.result.results[0], page2.result.results[0]];
      assert(both.map((r: any) => r.key).sort().join() === [one.key, two.key].sort().join(), `offset ${JSON.stringify(both.map((r: any) => r.key))}`);
      assert(page.result.results[0].key === one.key ? page.result.results[0].fields.DOI === '10.1000/e2e-typ' && page.result.results[0].fields.volume === '3' : true, 'fields missing');

      // Preview: one to book (fields, tag, dropped fields), one to bookSection (mapped title kept), an unknown key.
      view.input.value = `TOOL update_item ${JSON.stringify({ changes: [
        { key: one.key, item_type: 'book', fields: { publisher: 'Springer', place: 'Berlin' }, remove_tags: ['E2E-Weg'], add_tags: ['E2E-Neu'] },
        { key: two.key, item_type: 'book_section', fields: { publicationTitle: 'Sammelband S' } },
        { key: 'NOSUCHKY', item_type: 'book' },
      ] })}`;
      const sending = view.send();
      const run = await waitFor('update preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(run.items!.length === 3, `preview ${JSON.stringify(run.items)}`);
      assert(run.items![0].checked && /→/.test(run.items![0].detail!) && /publicationTitle/.test(run.items![0].detail!) && /E2E-Neu/.test(run.items![0].detail!) && /Springer/.test(run.items![0].detail!), `first ${run.items![0].detail}`);
      assert(run.items![1].checked && !/Sammelband/.test(run.items![1].detail!.split('\n').slice(1).join(' ')), `second ${run.items![1].detail}`);
      assert(!run.items![2].selectable && run.items![2].badge === 'nicht möglich', `third ${JSON.stringify(run.items![2])}`);
      assert(one.itemType === 'journalArticle', 'changed before confirmation');
      await delay(200);
      await screenshot(ctx, 'tools-update-preview', toolsWin);
      // The user takes the second one out.
      run.items![1].checked = false;
      const ok = await waitFor('confirm button', () => doc.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000);
      assert(ok.textContent === 'Änderungen übernehmen', `button ${ok.textContent}`);
      ok.click();
      await sending;
      const done = await lastTool();
      assert(one.itemType === 'book' && one.getField('publisher') === 'Springer' && one.getField('place') === 'Berlin', `one: ${one.itemType} ${one.getField('publisher')}`);
      
      assert(one.hasTag('E2E-Neu') && !one.hasTag('E2E-Weg') && one.hasTag('E2E-Typ'), 'tags');
      assert(two.itemType === 'journalArticle', 'unchecked item changed');
      await delay(200);
      await screenshot(ctx, 'tools-update-done', toolsWin);
      assert(done.changed.length === 1 && done.changed[0].before.item_type === 'journalArticle' && done.changed[0].before.droppedFields.publicationTitle === 'Zeitschrift Z', `result ${JSON.stringify(done)}`);

      // The second one for real: the mapped title survives as the book title.
      const second = call('update_item', { changes: [{ key: two.key, item_type: 'book_section' }] });
      const run2 = await waitFor('second preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(!/Dropped|verloren/.test(run2.items![0].detail!), `mapped field reported as lost: ${run2.items![0].detail}`);
      (await waitFor('ok', () => doc.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000)).click();
      await second;
      assert(two.itemType === 'bookSection' && two.getField('bookTitle') === 'Sammelband S', `two: ${two.itemType} / ${two.getField('bookTitle')}`);

      // Cancelling changes nothing; a field the type does not have is refused without a preview.
      const cancelled = call('update_item', { changes: [{ key: two.key, item_type: 'report' }] });
      await waitFor('third preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      (doc.querySelector('.seekchat-tool-cancel') as HTMLButtonElement).click();
      await cancelled;
      assert(two.itemType === 'bookSection', 'changed despite cancel');
      const bad = await call('update_item', { changes: [{ key: two.key, fields: { nosuchfield: 'x' } }] });
      assert(bad.run.state === 'error' && /nosuchfield/.test(bad.result.problems[0].problem), `bad field ${JSON.stringify(bad.result)}`);

      // read_document: first three pages, then one chosen page; the item key finds the PDF.
      const read = await call('read_document', { key: two.key });
      await delay(200);
      await screenshot(ctx, 'tools-read-document', toolsWin);
      assert(read.result.kind === 'pdf' && read.result.key === att.key && read.result.pages >= 4 && read.result.from === 1 && read.result.to === 3 && read.result.next === 4 && read.result.text.length === 3, `read ${JSON.stringify(read.result).slice(0, 300)}`);
      const one3 = await call('read_document', { key: att.key, from_page: 2, to_page: 2 });
      assert(one3.result.text.length === 1 && one3.result.text[0].page === 2, `page 2 ${JSON.stringify(one3.result).slice(0, 200)}`);
      const none = await call('read_document', { key: one.key });
      assert(none.run.state === 'error', 'item without file not reported');
    } finally {
      toolsWin.close();
    }
  }],

  ['tool chat: tool calls sit in one closed block that opens only while the user is asked; create_note writes a child note after confirmation', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const lib = Zotero.Libraries.userLibraryID;
    const item = new Zotero.Item('book');
    item.setField('title', 'E2E Notizbuch');
    await item.saveTx();
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    view.setTarget(`l${lib}`);
    const session = getToolSession();
    session.clear();
    try {
      const doc = toolsWin.document;
      const block = () => Array.from(doc.querySelectorAll('.seekchat-tools-block') as NodeListOf<HTMLDetailsElement>).pop();
      view.input.value = `TOOL create_note ${JSON.stringify({ key: item.key, title: 'Zusammenfassung', text: '- Punkt **eins**\n- Punkt zwei' })}`;
      const sending = view.send();
      const run = await waitFor('note preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(/Punkt \*\*eins\*\*/.test(run.items![0].detail!) && /E2E Notizbuch/.test(run.items![0].label), `preview ${JSON.stringify(run.items)}`);
      await waitFor('block open while asking', () => block()?.open === true, 5000);
      await screenshot(ctx, 'tools-note-preview', toolsWin);
      assert(item.getNotes().length === 0, 'note created before confirmation');
      const ok = await waitFor('confirm button', () => doc.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000);
      assert(ok.textContent === 'Notiz anlegen', `button ${ok.textContent}`);
      ok.click();
      await sending;
      const notes = Zotero.Items.get(item.getNotes());
      assert(notes.length === 1 && /<h1>Zusammenfassung<\/h1>/.test(notes[0].getNote()) && /<strong>eins<\/strong>/.test(notes[0].getNote()), `note ${notes[0]?.getNote()}`);
      // Done: the block is a single closed line; a click on it opens it, and it stays open.
      await waitFor('block closed after the answer', () => block() && block()!.open === false, 5000);
      const summary = block()!.querySelector('summary') as HTMLElement;
      assert(/Notiz/.test(summary.textContent || '') && !summary.textContent!.includes('\n'), `summary ${summary.textContent}`);
      await screenshot(ctx, 'tools-block-closed', toolsWin);
      summary.click();
      await waitFor('block opened by the user', () => block()?.open === true, 5000);
      await screenshot(ctx, 'tools-block-opened', toolsWin);

      // Without key and collection the note goes to the library root; a missing parent is refused.
      view.input.value = `TOOL create_note ${JSON.stringify({ key: 'NOSUCHKY', text: 'x' })}`;
      await view.send();
      assert(session.turns[session.turns.length - 1].toolRuns![0].state === 'error', 'unknown parent not refused');
    } finally {
      toolsWin.close();
    }
  }],

  ['tool chat: subagent works through a collection in packages with read-only tools, returns only its result; its stop button keeps the results so far', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const lib = Zotero.Libraries.userLibraryID;
    const col = new Zotero.Collection({ libraryID: lib, name: 'E2E Subagent' });
    await col.saveTx();
    const keys: string[] = [];
    for (let i = 0; i < 45; i++) {
      const item = new Zotero.Item('journalArticle');
      item.setField('title', `E2E Paket-Eintrag ${i + 1}`);
      item.setCollections([col.id]);
      await item.saveTx();
      keys.push(item.key);
    }
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    view.setTarget(`l${lib}`);
    const session = getToolSession();
    session.clear();
    try {
      const doc = toolsWin.document;
      const before = (await mockRequests()).length;
      view.input.value = `TOOL delegate_task ${JSON.stringify({ task: 'Prüfe den Eintragstyp jedes Eintrags.', result_format: 'JSON-Liste {key, item_type, reason}', collection: 'E2E Subagent' })}`;
      await view.send();
      const turn = session.turns[session.turns.length - 1];
      const run = turn.toolRuns![0];
      assert(run.state === 'done' && run.items!.length === 3 && run.items!.every((i) => i.badge === 'fertig'), `run ${run.state} ${JSON.stringify(run.items?.map((i) => i.badge))} ${run.status}`);
      await delay(200);
      await screenshot(ctx, 'tools-subagent-done', toolsWin);
      const block0 = Array.from(doc.querySelectorAll('.seekchat-tools-block') as NodeListOf<HTMLDetailsElement>).pop()!;
      block0.open = true;
      await delay(200);
      await screenshot(ctx, 'tools-subagent-done-opened', toolsWin);
      const all = (await mockRequests()).slice(before);
      const sub = all.filter((r: any) => (r.messages?.[0]?.content || '').includes('You are a subagent'));
      assert(sub.length === 6, `${sub.length} subagent requests (2 per package expected)`);
      const offered = new Set(sub.flatMap((r: any) => (r.tools || []).map((x: any) => x.function.name)));
      assert(offered.has('get_item') && offered.has('read_document') && !['update_item', 'create_note', 'save_to_collection', 'import_references', 'delegate_task'].some((n) => offered.has(n)), `subagent tools ${[...offered]}`);
      assert(sub.every((r: any) => (r.messages[1].content.match(/^- \w{8}:/gm) || []).length <= 20), 'package larger than 20');
      // The main chat sees only the joined result, none of the subagent's reading.
      const main = all.filter((r: any) => !(r.messages?.[0]?.content || '').includes('You are a subagent')).pop();
      const toolMsg = [...main.messages].reverse().find((m: any) => m.role === 'tool');
      const result = JSON.parse(toolMsg.content);
      assert(result.packages === 3 && result.finished === 3 && Array.isArray(result.result) && result.result.length === 45, `result ${toolMsg.content.slice(0, 300)}`);
      assert(result.result.map((r: any) => r.key).sort().join() === [...keys].sort().join(), 'keys of the joined result');
      assert(!main.messages.some((m: any) => m.role === 'tool' && /E2E Paket-Eintrag/.test(m.content) && m !== toolMsg), 'subagent reading leaked into the main chat');

      // Slow subagent: stop it in the closed block during package 1; the chat goes on with what is there.
      view.input.value = `TOOL delegate_task ${JSON.stringify({ task: 'Prüfe langsam jeden Eintrag.', collection: 'E2E Subagent' })}`;
      const slow = view.send();
      const running = await waitFor('subagent running', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'running' && r.cancellable), 10000);
      const stop = await waitFor('stop button in the block line', () => doc.querySelector('.seekchat-tools-block > summary .seekchat-tool-stop') as HTMLButtonElement, 5000);
      const block = stop.closest('details') as HTMLDetailsElement;
      assert(!block.open, 'block opened for a running subagent');
      // Slow answers (real models take up to a minute): the closed line shows where the subagent is.
      await waitFor('progress in the status line', () => /Paket 1 von 3 · \d+ Werkzeugaufrufe/.test(running.status || ''), 8000);
      await screenshot(ctx, 'tools-subagent-running', toolsWin);
      stop.click();
      await slow;
      assert(running.state === 'cancelled' && !running.cancellable, `after stop ${running.state}`);
      assert(!block.open, 'stop opened the block');
      await delay(200);
      await screenshot(ctx, 'tools-subagent-stopped', toolsWin);
      const stopped = JSON.parse([...(await mockLastRequest()).messages].reverse().find((m: any) => m.role === 'tool').content);
      assert(/cancelled by the user/.test(stopped.status) && stopped.notWorkedThrough.length >= 25, `stopped ${JSON.stringify(stopped).slice(0, 300)}`);
      const answer = session.turns[session.turns.length - 1];
      assert(!answer.cancelled && !answer.error && /Ergebnis delegate_task/.test(answer.content), `chat did not go on: ${answer.content}`);
    } finally {
      toolsWin.close();
    }
  }],

  ['tool chat: patterns of real models – several calls per answer, two confirmations in a row, long subagent reading shortened, JSON with words around it, field names Zotero does not use', async (ctx) => {
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    const lib = Zotero.Libraries.userLibraryID;
    const make = async (title: string, col?: number, pdf = false) => {
      const item = new Zotero.Item('journalArticle');
      item.setField('title', title);
      if (col) item.setCollections([col]);
      await item.saveTx();
      if (pdf) await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${ctx.fixturesDir}/seekchat-long.pdf`), parentItemID: item.id });
      return item;
    };
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    view.setTarget(`l${lib}`);
    const session = getToolSession();
    session.clear();
    const toolResults = (req: any) => req.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    try {
      // 1. Several calls in one answer run in order, each its own run.
      const a = await make('E2E Muster A');
      const b = await make('E2E Muster B');
      view.input.value = `TOOLS ${JSON.stringify([['get_item', { key: a.key }], ['get_item', { key: b.key }]])}`;
      await view.send();
      let turn = session.turns[session.turns.length - 1];
      assert(turn.toolRuns!.length === 2 && turn.toolRuns!.every((r) => r.state === 'done') && turn.toolRuns![1].items![0].itemID === b.id, `runs ${JSON.stringify(turn.toolRuns?.map((r) => [r.name, r.state]))}`);
      const sent = toolResults(await mockLastRequest());
      assert(sent.length === 2 && JSON.parse(sent[0]).key === a.key && JSON.parse(sent[1]).key === b.key, 'results not in call order');

      // Two changes as two calls in one answer: two confirmations one after the other; cancelling the first keeps the second.
      view.input.value = `TOOLS ${JSON.stringify([['update_item', { changes: [{ key: a.key, item_type: 'book' }] }], ['update_item', { changes: [{ key: b.key, item_type: 'report' }] }]])}`;
      const twice = view.send();
      const first = await waitFor('first confirmation', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      await delay(200);
      await screenshot(ctx, 'tools-patterns-first-confirm', toolsWin);
      (await waitFor('cancel', () => toolsWin.document.querySelector('.seekchat-tool-cancel') as HTMLButtonElement, 5000)).click();
      const second = await waitFor('second confirmation', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm' && r !== first), 10000);
      (await waitFor('ok', () => toolsWin.document.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000)).click();
      await twice;
      assert(first.state === 'cancelled' && second.state === 'done', `states ${first.state} / ${second.state}`);
      assert(a.itemType === 'journalArticle' && b.itemType === 'report', `types ${a.itemType} / ${b.itemType}`);

      // 5. A subagent that reads a lot: old tool results are shortened and say not to read them again.
      const big = new Zotero.Collection({ libraryID: lib, name: 'E2E Grosse Dokumente' });
      await big.saveTx();
      for (let i = 0; i < 6; i++) await make(`E2E Langes Dokument ${i + 1}`, big.id, true);
      const before = (await mockRequests()).length;
      view.input.value = `TOOL delegate_task ${JSON.stringify({ task: 'Lies groß jedes Dokument.', collection: 'E2E Grosse Dokumente' })}`;
      await view.send();
      turn = session.turns[session.turns.length - 1];
      assert(turn.toolRuns![0].state === 'done', `subagent ${turn.toolRuns![0].state} ${turn.toolRuns![0].status}`);
      const sub = (await mockRequests()).slice(before).filter((r: any) => (r.messages?.[0]?.content || '').includes('You are a subagent'));
      const lastSub = sub[sub.length - 1];
      const shortened = toolResults(lastSub).filter((c: string) => /do not call it again/.test(c));
      assert(shortened.length >= 1, `nothing shortened (${toolResults(lastSub).map((c: string) => c.length)})`);
      const reads = sub.flatMap((r: any) => r.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => (m.tool_calls || []).map((c: any) => c.function.arguments.key)));
      assert(new Set(reads).size === 6, `documents read: ${reads.length} calls, ${new Set(reads).size} different`);
      const all = lastSub.messages.reduce((n: number, m: any) => n + (m.content || '').length, 0);
      assert(all < 60000, `subagent conversation ${all} chars`);

      // 6. JSON with words around it in two packages, joined; fields named like the model does (year, degree).
      const many = new Zotero.Collection({ libraryID: lib, name: 'E2E Vorrede' });
      await many.saveTx();
      const items = [];
      for (let i = 0; i < 25; i++) items.push(await make(`E2E Vorrede ${i + 1}`, many.id));
      view.input.value = `TOOL delegate_task ${JSON.stringify({ task: 'Prüfe mit vorrede und felder.', collection: 'E2E Vorrede' })}`;
      await view.send();
      const joined = JSON.parse(toolResults(await mockLastRequest()).pop());
      assert(joined.packages === 2 && Array.isArray(joined.result) && joined.result.length === 25, `joined ${JSON.stringify(joined).slice(0, 300)}`);
      // The main chat applies the first proposal as it comes: year becomes the date, degree is left out for a book.
      view.input.value = `TOOL update_item ${JSON.stringify({ changes: [joined.result[0]] })}`;
      const applying = view.send();
      const prev = await waitFor('preview', () => session.turns[session.turns.length - 1]?.toolRuns?.find((r) => r.state === 'confirm'), 10000);
      assert(/2020/.test(prev.items![0].detail!) && /Ausgelassen \(kein Feld von Book\): degree/.test(prev.items![0].detail!), `detail ${prev.items![0].detail}`);
      await delay(200);
      await screenshot(ctx, 'tools-patterns-fields-preview', toolsWin);
      (await waitFor('ok', () => toolsWin.document.querySelector('.seekchat-tool-ok') as HTMLButtonElement, 5000)).click();
      await applying;
      const changed = items.find((x) => x.key === joined.result[0].key)!;
      assert(changed.itemType === 'book' && changed.getField('date') === '2020', `applied ${changed.itemType} ${changed.getField('date')}`);
    } finally {
      toolsWin.close();
    }
  }],

  ['only the OpenAI interface: no request sets num_ctx or Ollama options (Ollama would reload the model)', async () => {
    const all = await mockRequests();
    assert(all.length > 10, `only ${all.length} requests`);
    const withCtx = all.filter((r) => JSON.stringify(r).includes('num_ctx') || 'options' in r);
    assert(!withCtx.length, `${withCtx.length} of ${all.length} requests set num_ctx`);
  }],

  ['portal: Zotero accepts the certificate and serves updates.json', async () => {
    let json: any;
    try {
      const resp = await Zotero.getMainWindow().fetch('https://zotero.ils.local/downloads/seekchat/updates.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (e: any) {
      if (/Unable to connect|NetworkError|Failed to fetch/i.test(String(e?.message)) && !Zotero.Prefs.get('seekchat.e2e.portal')) {
        throw new SkipError(`portal not reachable in this run: ${e.message}`);
      }
      throw e;
    }
    const updates = Object.values<any>(json.addons)[0].updates;
    // Since 1.0.0rc1 the portal copy of updates.json points at the releases on gitlab.com (old installations update there).
    assert(updates.length && /^https:\/\/(zotero\.ils\.local|gitlab\.com)\//.test(updates[updates.length - 1].update_link), JSON.stringify(json).slice(0, 200));
  }],

  ['certificates: a self-signed server is refused until trusted, pinned, refused again when not trusted', async () => {
    const url = 'https://127.0.0.1:11443';
    const probe = await probeCertificate(new URL(url));
    if (probe.state === 'unreachable') throw new SkipError('no https mock in this image');
    assert(probe.state === 'invalid', `probe: ${probe.state}`);
    const info = probe.info;
    assert(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(info.sha256) && info.der.length > 500 && info.commonName === 'seekchat-e2e',
      JSON.stringify({ ...info, der: info.der.length }));
    const saved = { baseUrl: String(getPref('baseUrl') || ''), certs: String(getPref('certificates') || '') };
    const models = async () => {
      try {
        return (await createClient(readPrefs()).listModels()).join(',');
      } catch (e: any) {
        return `error: ${e?.message || e}`;
      }
    };
    setPref('baseUrl', url);
    writeCerts([]);
    resetTlsChecks();
    try {
      let out = await models();
      assert(/noch nicht entschieden|not decided/.test(out), `unknown certificate: ${out}`);
      decideCertificate(info, probe.cert, true);
      out = await models();
      assert(out.includes('mock-model'), `trusted: ${out}`);
      const stored = readCerts();
      assert(stored.length === 1 && stored[0].trusted && stored[0].der === info.der && stored[0].sha256 === info.sha256, JSON.stringify(stored).slice(0, 300));
      // Switched to "not trusted" in the list: the exception is taken back, requests are refused.
      writeCerts(upsertCert(readCerts(), info, false));
      forgetServer('127.0.0.1', 11443);
      out = await models();
      assert(/nicht vertrauen|not trusted/.test(out), `not trusted: ${out}`);
      // Old setting "Accept invalid certificate": the current certificate is entered as trusted once.
      writeCerts([]);
      forgetServer('127.0.0.1', 11443);
      setPref('allowInvalidCerts', true);
      out = await models();
      assert(out.includes('mock-model') && getPref('allowInvalidCerts') === false && readCerts()[0]?.trusted === true, `migration: ${out}`);
    } finally {
      setPref('baseUrl', saved.baseUrl);
      setPref('certificates', saved.certs);
      setPref('allowInvalidCerts', false);
      forgetServer('127.0.0.1', 11443);
    }
  }],

  ['logging reaches the Browser Console ([SeekChat:<module>] [INFO])', async () => {
    const seen: string[] = [];
    // What the Browser Console shows is what the console service gets.
    const listener = { observe: (m: any) => { if (String(m?.message).includes('[SeekChat:')) seen.push(String(m.message)); } };
    Services.console.registerListener(listener);
    try {
      logger('E2E').info('console check');
      await waitFor('console message', () => seen.some((x) => x.includes('[SeekChat:E2E] [INFO] console check')), 3000);
    } finally {
      Services.console.unregisterListener(listener);
    }
  }],

  ['live tools: subagent checks the item types of real documents in a collection, corrections applied after confirmation', async (ctx) => {
    useLiveServer(ctx);
    const lib = Zotero.Libraries.userLibraryID;
    const col = new Zotero.Collection({ libraryID: lib, name: 'E2E Live Typen' });
    await col.saveTx();
    // Four with a wrong type, two right.
    const docs = [
      { type: 'journalArticle', title: 'Überörtliche Raumplanung', file: 'tud-diss-ueberoertliche-raumplanung.pdf', right: ['thesis'] },
      { type: 'book', title: 'GIS and green infrastructure', file: 'plos-gis-green-infrastructure-2025.pdf', right: ['journalArticle'] },
      { type: 'journalArticle', title: 'Forschungsdatenmanagement – Eine praxisorientierte Einführung', file: 'Schlenz et al. - 2026 - Forschungsdatenmanagement - Eine praxisorientierte Einführung.pdf', right: ['book'] },
      { type: 'book', title: 'Attention Is All You Need', file: 'arxiv-attention-2017.pdf', right: ['conferencePaper', 'preprint', 'journalArticle', 'report'] },
      { type: 'journalArticle', title: 'The FAIR Guiding Principles', file: 'scidata-fair-principles-2016.pdf', right: ['journalArticle'] },
      { type: 'journalArticle', title: 'Küpper 2024 (Raumforschung und Raumordnung)', file: 'rur-kuepper-2024-de.pdf', right: ['journalArticle'] },
    ];
    const made = [];
    for (const d of docs) made.push({ ...d, ...(await liveDoc(d.type, d.title, d.file, col.id)) });
    await openLiveToolChat();
    const t0 = Date.now();
    const turn = await liveToolAsk(ctx, 'live-types',
      'Prüfe in der Sammlung „E2E Live Typen“ für jeden Eintrag anhand der ersten Seiten seines Dokuments, ob der Eintragstyp stimmt. '
      + 'Lass das den Subagenten (delegate_task) erledigen und schlage danach die nötigen Korrekturen mit update_item vor.');
    const after = made.map((d) => ({ file: d.file, before: d.type, after: d.item.itemType, right: d.right }));
    await reportLive(ctx, { step: 'tools-subagent-types', ms: Date.now() - t0, answer: turn.content, runs: runsReport(turn), types: after });
    assert(!turn.error, `error: ${turn.content}`);
    const delegate = turn.toolRuns?.find((r) => r.name === 'delegate_task');
    assert(delegate && delegate.state === 'done', `subagent not run: ${JSON.stringify(runsReport(turn)).slice(0, 500)}`);
    const fixed = after.filter((d) => d.before !== d.after && d.right.includes(d.after)).length;
    const broken = after.filter((d) => d.right.includes(d.before) && d.after !== d.before).length;
    assert(fixed >= 1, `no wrong type corrected: ${JSON.stringify(after)}`);
    assert(broken === 0, `a right type was changed: ${JSON.stringify(after)}`);
  }],

  ['live tools: reference list of a real paper through Find Online References, related sources linked', async (ctx) => {
    useLiveServer(ctx);
    if (!(Zotero as any).FindOnlineReferences?.api?.getReferences) throw new SkipError('Find Online References not installed (E2E_PLUGINS)');
    const { item } = await liveDoc('journalArticle', 'Green infrastructure planning with GIS', 'plos-gis-green-infrastructure-2025.pdf');
    await openLiveToolChat();
    const t0 = Date.now();
    const turn = await liveToolAsk(ctx, 'live-refs',
      `Lies die Literaturliste des Dokuments mit dem Schlüssel ${item.key} und zeige mir mit Links die Quellen daraus, die sich mit Stadtklima, Hitze oder Grünflächen befassen.`);
    await reportLive(ctx, { step: 'tools-references', ms: Date.now() - t0, answer: turn.content, runs: runsReport(turn) });
    assert(!turn.error, `error: ${turn.content}`);
    const list = turn.toolRuns?.find((r) => r.name === 'get_document_references');
    const shown = turn.toolRuns?.find((r) => r.name === 'show_references');
    assert(list?.state === 'done', `reference list not read: ${JSON.stringify(runsReport(turn)).slice(0, 500)}`);
    assert(shown?.state === 'done' && shown.items!.length >= 1 && shown.items!.every((i) => i.url || i.itemID), `no linked sources: ${JSON.stringify(runsReport(turn)).slice(0, 500)}`);
  }],

  ['live tools: reads the first pages of a real paper and writes a note about it after confirmation', async (ctx) => {
    useLiveServer(ctx);
    const { item } = await liveDoc('journalArticle', 'Tent 2024 (Raumforschung und Raumordnung)', 'rur-tent-2024-en.pdf');
    await openLiveToolChat();
    const t0 = Date.now();
    const turn = await liveToolAsk(ctx, 'live-note',
      `Lies die ersten zwei Seiten des Dokuments mit dem Schlüssel ${item.key} und lege an diesem Eintrag eine Notiz mit den drei wichtigsten Aussagen an.`);
    const notes = Zotero.Items.get(item.getNotes());
    await reportLive(ctx, { step: 'tools-read-note', ms: Date.now() - t0, answer: turn.content, runs: runsReport(turn), note: notes[0]?.getNote() });
    assert(!turn.error, `error: ${turn.content}`);
    assert(turn.toolRuns?.some((r) => r.name === 'read_document' && r.state === 'done'), `document not read: ${JSON.stringify(runsReport(turn)).slice(0, 400)}`);
    assert(notes.length === 1 && noteText(notes[0].getNote()).length > 80, `no note: ${notes.length}`);
  }],

  ['live tools: library search with the installed search plugins', async (ctx) => {
    useLiveServer(ctx);
    await liveDoc('book', 'Forschungsdaten-Policies für Forschungsprojekte', 'Schmiederer und Kuberek - 2022 - Forschungsdaten-Policies für Forschungsprojekte ein strukturierter Leitfaden.pdf');
    await liveDoc('journalArticle', 'Bausteine Forschungsdatenmanagement (Düvel 2025)', 'bausteine-fdm-duevel-2025-de.pdf');
    await openLiveToolChat();
    const t0 = Date.now();
    const turn = await liveToolAsk(ctx, 'live-search', 'Welche Einträge in meiner Bibliothek behandeln Forschungsdatenmanagement? Nenne sie kurz.');
    await reportLive(ctx, {
      step: 'tools-search', ms: Date.now() - t0, answer: turn.content, runs: runsReport(turn),
      plugins: { zotseek: !!(Zotero as any).ZotSeek, seekbook: !!(Zotero as any).SeekBook, findOnlineReferences: !!(Zotero as any).FindOnlineReferences },
    });
    assert(!turn.error, `error: ${turn.content}`);
    const search = turn.toolRuns?.find((r) => r.name === 'search_library');
    assert(search?.state === 'done' && (search.items?.length || 0) >= 1, `no search hits: ${JSON.stringify(runsReport(turn)).slice(0, 400)}`);
    getToolsChatWindow()?.close();
  }],

  // ---- Tutorial screenshots (docs/tutorial.ipynb): a small realistic library, each use case with a real model. ----
  // Run: E2E_ONLY=tutorial with E2E_LIVE_URL and E2E_PLUGINS (see CLAUDE.md); pictures: e2e/out/screenshot-tut-*.png.

  ['tutorial: seed library with real documents (collections, tags, two wrong item types)', async (ctx) => {
    useLiveServer(ctx);
    const lib = Zotero.Libraries.userLibraryID;
    // A big window for the tutorial pictures: more of the item list and the side pane is visible.
    Zotero.getMainWindow().moveTo(0, 0);
    Zotero.getMainWindow().resizeTo(1560, 960);
    await delay(800);
    // A wider item pane, so that the chat in it is readable.
    const itemPaneEl = Zotero.getMainWindow().document.getElementById('zotero-item-pane') as any;
    if (itemPaneEl) { itemPaneEl.setAttribute('width', '640'); itemPaneEl.style.width = '640px'; }
    await delay(500);
    const col = async (name: string) => { const c = new Zotero.Collection({ libraryID: lib, name }); await c.saveTx(); return c; };
    const fdm = await col('Forschungsdaten');
    const typen = await col('Typen prüfen');
    const docs: [string, string, string, string, string, string, number[], string[]][] = [
      // type, title, author, year, file, venue, collections, tags
      ['book', 'Forschungsdatenmanagement – eine praxisorientierte Einführung', 'Schlenz', '2026', 'Schlenz et al. - 2026 - Forschungsdatenmanagement - Eine praxisorientierte Einführung.pdf', '', [fdm.id], ['FDM']],
      ['book', 'Forschungsdaten-Policies für Forschungsprojekte', 'Schmiederer', '2022', 'Schmiederer und Kuberek - 2022 - Forschungsdaten-Policies für Forschungsprojekte ein strukturierter Leitfaden.pdf', '', [fdm.id], ['fdm', 'Policy']],
      ['journalArticle', 'Bausteine Forschungsdatenmanagement', 'Düvel', '2025', 'bausteine-fdm-duevel-2025-de.pdf', 'Bausteine FDM', [fdm.id], ['Forschungsdaten']],
      ['journalArticle', 'Digitales Publizieren', 'Kollektiv', '2021', 'zfdg-2021-digitales-publizieren-de.pdf', 'ZfdG', [fdm.id], ['Publizieren']],
      ['journalArticle', 'The FAIR Guiding Principles for scientific data management and stewardship', 'Wilkinson', '2016', 'scidata-fair-principles-2016.pdf', 'Scientific Data', [fdm.id, typen.id], ['FDM', 'FAIR']],
      ['journalArticle', 'Nahversorgung in ländlichen Räumen', 'Küpper', '2024', 'rur-kuepper-2024-de.pdf', 'Raumforschung und Raumordnung', [typen.id], ['RuR', 'ländlicher Raum']],
      ['book', 'GIS and green infrastructure', 'Wu', '2025', 'plos-gis-green-infrastructure-2025.pdf', '', [typen.id], ['Grünflächen']],
      ['journalArticle', 'Überörtliche Raumplanung', 'Kießling', '2022', 'tud-diss-ueberoertliche-raumplanung.pdf', '', [typen.id], ['Raumplanung']],
      ['journalArticle', 'Attention Is All You Need', 'Vaswani', '2017', 'arxiv-attention-2017.pdf', '', [typen.id], ['KI']],
    ];
    ctx.tut = {};
    for (const [type, title, author, year, file, venue, cols, tags] of docs) {
      const item = new Zotero.Item(type);
      item.setField('title', title);
      item.setField('date', year);
      if (venue) item.setField(type === 'journalArticle' ? 'publicationTitle' : 'publisher', venue);
      item.setCreators([{ creatorType: 'author', firstName: '', lastName: author }]);
      item.setCollections(cols);
      for (const tag of tags) item.addTag(tag);
      await item.saveTx();
      await Zotero.Attachments.importFromFile({ file: Zotero.File.pathToFile(`${refAssets()}/${file}`), parentItemID: item.id });
      ctx.tut[file] = item;
    }
    const win = Zotero.getMainWindow();
    win.Zotero_Tabs.select('zotero-pane');
    await win.ZoteroPane.collectionsView.selectLibrary(lib);
    await delay(800);
    await screenshot(ctx, 'tut-library');
  }],

  ['tutorial: build the indexes (SeekBook on the model server, ZotSeek with its built-in model) before the use cases', async (ctx) => {
    useLiveServer(ctx);
    const t0 = Date.now();
    const report: Record<string, unknown> = {};
    const sb = (Zotero as any).SeekBook;
    if (sb?.indexer) {
      const url: string = Zotero.Prefs.get('seekchat.e2e.liveUrl');
      Zotero.Prefs.set('seekbook.provider', 'ollama');
      Zotero.Prefs.set('seekbook.baseUrl', url);
      Zotero.Prefs.set('seekbook.model', 'qwen3-embedding:8b');
      Zotero.Prefs.set('seekbook.allowedRemoteHosts', new URL(url).hostname);
      // Books and long documents (30 pages and more), as SeekBook selects them.
      const books = Object.values<any>(ctx.tut).filter((i) => i.itemType === 'book' || /ueberoertliche/.test(i.getField('title')) || i.getField('title') === 'Überörtliche Raumplanung');
      await sb.indexer.indexBooks(books, true);
      try {
        await waitFor('books indexed', async () => {
          for (const b of books) if (!(await sb.isIndexed('user', b.key))) return false;
          return true;
        }, 1500000);
        report.seekbook = `${books.length} books in ${Math.round((Date.now() - t0) / 1000)} s`;
      } catch (e: any) {
        report.seekbook = `not finished: ${e.message}`;
      }
    } else report.seekbook = 'not installed';
    if ((Zotero as any).ZotSeek) {
      // ZotSeek (ILS version) embeds with qwen3-embedding on the model server instead of its built-in CPU model.
      const url: string = Zotero.Prefs.get('seekchat.e2e.liveUrl');
      Zotero.Prefs.set('zotseek.server.allowedRemoteHosts', new URL(url).hostname, true);
      Zotero.Prefs.set('zotseek.serverModels', JSON.stringify([{
        id: 'server:qwen3-embedding-8b', label: 'qwen3-embedding:8b (ollama.ils.local)', baseUrl: url,
        serverModelName: 'qwen3-embedding:8b', dimensions: 4096, queryPrefix: '', docPrefix: '',
      }]), true);
      Zotero.Prefs.set('zotseek.embeddingModel', 'server:qwen3-embedding-8b', true);
      report.zotseekModel = 'qwen3-embedding:8b on the model server';
      const t1 = Date.now();
      try {
        // "Ready" is true after the first paper: wait until all seeded papers are in, or the count stops growing for 3 minutes.
        const want = Object.keys(ctx.tut).length;
        let last = -1;
        let lastChange = Date.now();
        await waitFor('ZotSeek index complete', async () => {
          const st = await getZotSeekStatus();
          const n = st.available ? st.stats.indexedPapers : 0;
          if (n !== last) { last = n; lastChange = Date.now(); }
          return n >= want || (n > 0 && Date.now() - lastChange > 180000);
        }, 2400000);
        report.zotseek = `${last} of ${want} papers after ${Math.round((Date.now() - t1) / 1000)} s`;
      } catch (e: any) {
        report.zotseek = `not ready: ${e.message}`;
      }
    } else report.zotseek = 'not installed';
    await reportLive(ctx, { step: 'tutorial-indexes', ...report });
    await screenshot(ctx, 'tut-library-indexed');
    // The settings panes for the set-up chapter of the tutorial.
    for (const [name, part] of [['zotseek', 'zotseek'], ['seekbook', 'seekbook'], ['seekchat', 'seekchat']] as const) {
      try {
        const pane = (Zotero.PreferencePanes?.pluginPanes || []).find((p: any) => String(p.pluginID || p.id).toLowerCase().includes(part));
        if (!pane) continue;
        Zotero.Utilities.Internal.openPreferences(pane.id);
        const pw = await waitFor(`${name} settings`, () => Services.wm.getMostRecentWindow('zotero:pref'), 15000);
        await delay(1500);
        await screenshot(ctx, `tut-settings-${name}`, pw);
        pw.close();
        await delay(500);
      } catch (e: any) {
        Zotero.debug(`[SeekChat E2E] settings screenshot ${name} failed: ${e}`);
      }
    }
  }],

  ['tutorial: simple PDF chat in the item pane', async (ctx) => {
    useLiveServer(ctx);
    const item = ctx.tut['rur-kuepper-2024-de.pdf'];
    const win = Zotero.getMainWindow();
    const section = await openSectionInLibrary(item.id);
    await delay(500);
    await screenshot(ctx, 'tut-pdf-1-section');
    const answer = await askThroughUi(section, 'Was sind die wichtigsten Ergebnisse dieses Beitrags? Antworte in drei Stichpunkten.', 240000);
    await (section.closest('item-details') as any)?.scrollToPane(section.getAttribute('data-pane'), 'instant');
    await delay(500);
    await screenshot(ctx, 'tut-pdf-2-answer');
    await reportLive(ctx, { step: 'tutorial-pdf-chat', answer: answer.textContent });
    // A long document: SeekChat picks the pages that fit the question and says which ones it read.
    const long = ctx.tut['tud-diss-ueberoertliche-raumplanung.pdf'];
    const longSection = await openSectionInLibrary(long.id);
    await waitFor('strategy panel of the long document', () => /zu groß|too large/i.test(longSection.textContent || '') || null, 90000);
    await delay(500);
    await screenshot(ctx, 'tut-pdf-3-long-document');
    const longAnswer = await askThroughUi(longSection,
      'Was versteht die Arbeit unter überörtlicher Raumplanung, und welche Aufgaben ordnet sie ihr zu? Nenne die Seiten.', 420000);
    await (longSection.closest('item-details') as any)?.scrollToPane(longSection.getAttribute('data-pane'), 'instant');
    await delay(500);
    await screenshot(ctx, 'tut-pdf-4-long-document-answer');
    await reportLive(ctx, { step: 'tutorial-pdf-long', answer: longAnswer.textContent });
    win.Zotero_Tabs.select('zotero-pane');
  }],

  ['tutorial: tool chat window and tool list', async (ctx) => {
    useLiveServer(ctx);
    await openLiveToolChat();
    const toolsWin = getToolsChatWindow();
    await delay(500);
    await screenshot(ctx, 'tut-window-1-empty', toolsWin);
    (toolsWin.document.querySelector('.seekchat-tools-list') as HTMLDetailsElement).open = true;
    await delay(400);
    await screenshot(ctx, 'tut-window-2-tool-list', toolsWin);
    toolsWin.close();
  }],

  ['tutorial: import references from text', async (ctx) => {
    useLiveServer(ctx);
    await openLiveToolChat();
    const turn = await liveToolAsk(ctx, 'tut-import',
      'Importiere bitte diese Quellen:\n\n'
      + 'Oke, T. R. (1982): The energetic basis of the urban heat island. Quarterly Journal of the Royal Meteorological Society 108, 1-24. https://doi.org/10.1002/qj.49710845502\n'
      + 'Kuttler, W. (2011): Klimawandel im urbanen Bereich. Teil 1, Wirkungen. Environmental Sciences Europe 23, 1-12.\n'
      + 'Wilkinson, M. D. et al. (2016): The FAIR Guiding Principles for scientific data management and stewardship. Scientific Data 3, 160018.');
    await reportLive(ctx, { step: 'tutorial-import', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: ask the library, selection, tags', async (ctx) => {
    useLiveServer(ctx);
    await openLiveToolChat();
    let turn = await liveToolAsk(ctx, 'tut-ask', 'Welche Einträge in meiner Bibliothek behandeln Forschungsdatenmanagement? Nenne sie mit Jahr.');
    await reportLive(ctx, { step: 'tutorial-ask', answer: turn.content, runs: runsReport(turn) });
    turn = await liveToolAsk(ctx, 'tut-tags', 'Welche Schlagwörter verwende ich für Forschungsdaten? Gibt es doppelte Schreibweisen?');
    await reportLive(ctx, { step: 'tutorial-tags', answer: turn.content, runs: runsReport(turn) });
    const win = Zotero.getMainWindow();
    win.Zotero_Tabs.select('zotero-pane');
    await win.ZoteroPane.selectItems([ctx.tut['scidata-fair-principles-2016.pdf'].id, ctx.tut['bausteine-fdm-duevel-2025-de.pdf'].id]);
    turn = await liveToolAsk(ctx, 'tut-selection', 'Fasse die beiden markierten Einträge in je einem Satz zusammen.');
    await reportLive(ctx, { step: 'tutorial-selection', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: read a document, write a note, collect into a collection', async (ctx) => {
    useLiveServer(ctx);
    const item = ctx.tut['rur-kuepper-2024-de.pdf'];
    await openLiveToolChat();
    let turn = await liveToolAsk(ctx, 'tut-read', `Lies die ersten beiden Seiten des Eintrags „${item.getField('title')}“ und sag mir in zwei Sätzen, worum es geht.`);
    await reportLive(ctx, { step: 'tutorial-read', answer: turn.content, runs: runsReport(turn) });
    turn = await liveToolAsk(ctx, 'tut-note', `Lege an diesem Eintrag („${item.getField('title')}“) eine Notiz mit den drei wichtigsten Aussagen an.`);
    await reportLive(ctx, { step: 'tutorial-note', answer: turn.content, runs: runsReport(turn), note: Zotero.Items.get(item.getNotes())[0]?.getNote() });
    turn = await liveToolAsk(ctx, 'tut-collect', 'Lege alle Einträge aus der Sammlung „Forschungsdaten“, die ein Schlagwort mit FDM tragen, in eine neue Sammlung „Projekt A / FDM-Grundlagen“.');
    await reportLive(ctx, { step: 'tutorial-collect', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: check and correct item types, with and without the subagent', async (ctx) => {
    useLiveServer(ctx);
    await openLiveToolChat();
    let turn = await liveToolAsk(ctx, 'tut-fix-one', 'Der Eintrag „GIS and green infrastructure“ ist als Buch angelegt. Prüfe anhand der ersten Seite, ob der Typ stimmt, und korrigiere ihn nur, wenn nötig. Ändere sonst nichts.');
    await reportLive(ctx, { step: 'tutorial-fix-one', answer: turn.content, runs: runsReport(turn) });
    turn = await liveToolAsk(ctx, 'tut-subagent',
      'Prüfe in der Sammlung „Typen prüfen“ für jeden Eintrag anhand der ersten Seiten, ob der Eintragstyp stimmt. Lass das den Subagenten erledigen und ändere danach nur die Typen, die falsch sind.');
    await reportLive(ctx, { step: 'tutorial-subagent', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: reference list and related sources', async (ctx) => {
    useLiveServer(ctx);
    if (!(Zotero as any).FindOnlineReferences?.api?.getReferences) throw new SkipError('Find Online References not installed (E2E_PLUGINS)');
    const item = ctx.tut['plos-gis-green-infrastructure-2025.pdf'];
    await openLiveToolChat();
    const turn = await liveToolAsk(ctx, 'tut-refs', `Lies die Literaturliste des Eintrags „${item.getField('title')}“ und zeige mir mit Links die Quellen, die sich mit Hitze oder Stadtklima befassen. Prüfe auch, welche davon schon in meiner Bibliothek sind.`);
    await reportLive(ctx, { step: 'tutorial-refs', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: chain – search, read, correct, collect, note in one request', async (ctx) => {
    useLiveServer(ctx);
    await openLiveToolChat();
    const turn = await liveToolAsk(ctx, 'tut-chain',
      'Suche in meiner Bibliothek die Einträge zu Forschungsdatenmanagement, prüfe bei jedem anhand des Titelblatts, ob Eintragstyp und Jahr stimmen, '
      + 'lege sie in die Sammlung „Literatur / FDM“ und schreibe zum Schluss eine Notiz in diese Sammlung mit einer Übersicht der Einträge in einem Satz je Eintrag.');
    await reportLive(ctx, { step: 'tutorial-chain', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['tutorial: questions that work on the literature itself (one book, two books compared)', async (ctx) => {
    useLiveServer(ctx);
    const win = Zotero.getMainWindow();
    // One book in the PDF chat: a question about its argument, answered with page links.
    const book = ctx.tut['Schlenz et al. - 2026 - Forschungsdatenmanagement - Eine praxisorientierte Einführung.pdf'];
    const section = await openSectionInLibrary(book.id);
    await delay(500);
    const answer = await askThroughUi(section,
      'Aus welchen Teilen soll nach dem Buch ein Datenmanagementplan bestehen? Stelle für jeden Teil dar, was er festlegen soll, '
      + 'und gib an, welche Beispielformulierungen das Buch dazu nennt. Belege jede Angabe mit der Seite.', 420000);
    await (section.closest('item-details') as any)?.scrollToPane(section.getAttribute('data-pane'), 'instant');
    await delay(500);
    await screenshot(ctx, 'tut-deep-1-book');
    // The pane shows the end of the answer already; scroll to its start for a second picture.
    answer.scrollIntoView({ block: 'start' });
    await delay(500);
    await screenshot(ctx, 'tut-deep-1-book-start');
    await reportLive(ctx, { step: 'tutorial-deep-book', answer: answer.textContent });
    win.Zotero_Tabs.select('zotero-pane');
    // Two books against each other in the tool chat (search through SeekBook, reading the passages).
    await openLiveToolChat();
    const turn = await liveToolAsk(ctx, 'tut-deep-2',
      'Vergleiche, was „Forschungsdatenmanagement – eine praxisorientierte Einführung“ und „Forschungsdaten-Policies für Forschungsprojekte“ dazu sagen, '
      + 'wie ein Projekt seine Regeln zum Umgang mit Forschungsdaten festlegen soll. Wo ergänzen sich die Bücher, wo setzen sie unterschiedliche Schwerpunkte? '
      + 'Belege jede Aussage mit Buch und Seite.');
    await reportLive(ctx, { step: 'tutorial-deep-compare', answer: turn.content, runs: runsReport(turn) });
    getToolsChatWindow()?.close();
  }],

  ['live: model server lists the configured model', async (ctx) => {
    useLiveServer(ctx);
    const prefs = readPrefs();
    const models = await createClient(prefs).listModels();
    // Only whether a key was set, never the key itself.
    await reportLive(ctx, { step: 'models', url: prefs.baseUrl, apiKey: prefs.apiKey ? `gesetzt (${prefs.apiKey.length} Zeichen)` : 'keiner', models });
    assert(prefs.model, `no model set; server offers: ${models.join(', ')}`);
    assert(models.includes(prefs.model), `model ${prefs.model} not on server; offers: ${models.join(', ')}`);
  }],

  ['live: short PDF is answered with a page citation', async (ctx) => {
    useLiveServer(ctx);
    const session = getSession(new PdfContextProvider(ctx.attachment));
    session.clear();
    const t0 = Date.now();
    await session.ask('Was steht im Dokument zu Starkregen? Antworte in zwei Sätzen.');
    const answer = session.turns[session.turns.length - 1];
    const cited = [...answer.content.matchAll(CITED_PAGES)].map((m) => Number(m[1]));
    await reportLive(ctx, { step: 'short', ms: Date.now() - t0, meta: answer.meta, cited, answer: answer.content });
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(!answer.content.includes('<think>'), 'thinking block not stripped');
    assert(cited.length > 0, `answer lacks a [S. N] citation: ${answer.content}`);
    assert(cited.every((p) => p >= 1 && p <= 3), `citation outside the 3-page PDF: ${cited}`);
    session.clear();
  }],

  ['live: long PDF gets model keywords and an answer', async (ctx) => {
    useLiveServer(ctx);
    // An earlier scenario set the (German) book's language to en-GB; undo so keywords come in German.
    const parent = Zotero.Items.get(ctx.longParentID);
    parent.setField('language', 'de');
    await parent.saveTx();
    // With automatic limits (~100k tokens) the 40-page book fits whole; small manual limits force the keyword search.
    setPref('limitsMode', 'manual');
    setPref('contextChars', 40000);
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    session.clear();
    const t0 = Date.now();
    await session.ask('Was sagt das Buch zum Stadtklima?').finally(() => setPref('limitsMode', 'auto'));
    const answer = session.turns[session.turns.length - 1];
    await reportLive(ctx, { step: 'long', ms: Date.now() - t0, meta: answer.meta, answer: answer.content });
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(/Suchbegriffe: \S/.test(answer.meta || ''), `model produced no keywords: ${answer.meta}`);
    // Page 27 is the only page on urban heat ("Waermeinseln"); the model's keywords must reach it.
    const ranges = (answer.meta || '').match(/Auszüge: S\. ([^\n]*?) von/)?.[1] || '';
    const sent = ranges.split(',').some((r) => {
      const [a, b = a] = r.trim().split('–').map(Number);
      return a <= 27 && 27 <= b;
    });
    assert(sent, `page 27 not sent: ${answer.meta}`);
    assert(answer.content.trim().length > 20, `answer too short: ${answer.content}`);
    session.clear();
  }],

  ['live: books are pre-read and answered together (library chat without ZotSeek)', async (ctx) => {
    useLiveServer(ctx);
    const b = Zotero.Items.get(ctx.longParentID);
    const session = getSession(new LibraryContextProvider(itemsScope([b])));
    session.clear();
    const t0 = Date.now();
    await session.ask('Was sagt das Buch zum Stadtklima?', { zotseek: false, books: [{ attachment: ctx.longAttachment, label: 'SeekChat E2E Langes Buch' }] });
    const book = session.turns[session.turns.length - 1];
    await session.ask('Was steht im Buch über Vulkane?', { zotseek: false, books: [{ attachment: ctx.longAttachment, label: 'SeekChat E2E Langes Buch' }] });
    const none = session.turns[session.turns.length - 1];
    await reportLive(ctx, {
      step: 'books', ms: Date.now() - t0, meta: book.meta, answer: book.content, books: book.bookProgress, sources: book.sources,
      noMatch: { meta: none.meta, answer: none.content, books: none.bookProgress },
    });
    assert(!book.error && book.sources?.some((s) => s.origin === 'book') && /\[\d+, S\. \d+\]/.test(book.content), `book answer: ${book.content}`);
    assert(!none.error, `no-match question failed: ${none.content}`);
    session.clear();
  }],
  ['live: follow-up discusses the result (no new search) and is faster than the first question', async (ctx) => {
    useLiveServer(ctx);
    const b = Zotero.Items.get(ctx.longParentID);
    const books = [{ attachment: ctx.longAttachment, label: 'SeekChat E2E Langes Buch', itemKey: b.key }];
    const session = getSession(new LibraryContextProvider(itemsScope([b])));
    session.clear();
    let t0 = Date.now();
    await session.ask('Was sagt das Buch zum Stadtklima?', { zotseek: false, books });
    const first = session.turns[session.turns.length - 1];
    const firstMs = Date.now() - t0;
    t0 = Date.now();
    await session.ask('Fasse das bitte in drei Stichpunkten zusammen.', { zotseek: false, books });
    const follow = session.turns[session.turns.length - 1];
    const followMs = Date.now() - t0;
    const prompt = follow.requests?.[follow.requests.length - 1]?.messages?.[0]?.content || '';
    await reportLive(ctx, { step: 'followup', firstMs, followMs, meta: follow.meta, answer: follow.content, promptChars: prompt.length, firstPromptChars: first.requests?.[first.requests.length - 1]?.messages?.[0]?.content.length });
    assert(!first.error && !follow.error, `errors: ${first.content} / ${follow.content}`);
    assert(follow.meta?.includes('keine neue Suche') && !follow.bookProgress, `follow-up searched again: ${follow.meta}`);
    assert(followMs < firstMs, `follow-up ${followMs} ms not faster than first ${firstMs} ms`);
    session.clear();
  }],
  // Needs E2E_SEEKBOOK_XPI (SeekBook sideloaded) and test/assets/JIRASOFTWARESERVER071-290216.pdf (CC BY 2.5).
  // The two questions of the user's report: prompt sizes and times go to live-report.json.
  ['live: JIRA book through SeekBook – first question, then a follow-up on a new aspect stays small', async (ctx) => {
    useLiveServer(ctx);
    const sb = (Zotero as any).SeekBook;
    if (!sb?.indexer) throw new SkipError('SeekBook not sideloaded (E2E_SEEKBOOK_XPI)');
    const file = `${Zotero.Prefs.get('seekchat.e2e.assetsDir')}/JIRASOFTWARESERVER071-290216.pdf`;
    if (!(await Zotero.getMainWindow().IOUtils.exists(file))) throw new SkipError('JIRA PDF not in test/assets');
    const host = new URL(Zotero.Prefs.get('seekchat.e2e.liveUrl')).hostname;
    Zotero.Prefs.set('seekbook.provider', 'ollama');
    Zotero.Prefs.set('seekbook.baseUrl', Zotero.Prefs.get('seekchat.e2e.liveUrl'));
    Zotero.Prefs.set('seekbook.model', 'qwen3-embedding:8b');
    Zotero.Prefs.set('seekbook.allowedRemoteHosts', host);
    const { parentID } = await importFixture('JIRA-Dokumentation', file);
    const book = Zotero.Items.get(parentID);
    let t0 = Date.now();
    await sb.indexer.indexBooks([book], true);
    await waitFor('JIRA book indexed', async () => sb.isIndexed("user", book.key), 1500000);
    const indexMs = Date.now() - t0;

    const session = getSession(new LibraryContextProvider(libraryScope(Zotero.Libraries.userLibraryID)));
    session.clear();
    const lastPrompt = (turn: any) => turn.requests?.[turn.requests.length - 1]?.messages?.map((m: any) => m.content).join('\n') || '';
    const repeated = (prompt: string) => {
      const seen = new Set<string>();
      let dup = 0;
      for (const sentence of prompt.split(/(?<=[.!?])\s+/).filter((x) => x.length > 60)) {
        if (seen.has(sentence)) dup += sentence.length;
        seen.add(sentence);
      }
      return dup;
    };
    t0 = Date.now();
    await session.ask('Bitte sag mir wie man issues in jira anlegt', { zotseek: false, seekbook: true });
    const q1 = session.turns[session.turns.length - 1];
    const q1Ms = Date.now() - t0;
    t0 = Date.now();
    await session.ask('Was ist denn ein Backlog in Jira und wie kann ich es anlegen?', { zotseek: false, seekbook: true });
    const q2 = session.turns[session.turns.length - 1];
    const q2Ms = Date.now() - t0;
    const p1 = lastPrompt(q1);
    const p2 = lastPrompt(q2);
    await reportLive(ctx, {
      step: 'jira-seekbook', indexMs, q1Ms, q2Ms, q1PromptChars: p1.length, q2PromptChars: p2.length,
      q1RepeatedChars: repeated(p1), q2RepeatedChars: repeated(p2), q1Meta: q1.meta, q2Meta: q2.meta, q1: q1.content, q2: q2.content,
    });
    assert(!q1.error && !q2.error, `errors: ${q1.content} / ${q2.content}`);
    assert(/\[\d+, S\. \d+/.test(q1.content) && /\[\d+, S\. \d+/.test(q2.content), 'answers without page citations');
    assert(p2.length < p1.length, `follow-up prompt ${p2.length} not smaller than first ${p1.length}`);
    assert(repeated(p1) < p1.length * 0.05 && repeated(p2) < p2.length * 0.1, `repeated text: ${repeated(p1)} / ${repeated(p2)}`);
    session.clear();

    // PDF chat on the same book with the semantic strategy (SeekBook pages, no keyword call).
    const att = Zotero.Items.get(book.getAttachments())[0];
    const pdf = getSession(new PdfContextProvider(att));
    pdf.clear();
    pdf.setStrategy('vector');
    t0 = Date.now();
    await pdf.ask('Wie lege ich einen Sprint an und starte ihn?');
    const pa = pdf.turns[pdf.turns.length - 1];
    await reportLive(ctx, { step: 'jira-pdf-semantic', ms: Date.now() - t0, meta: pa.meta, answer: pa.content, requests: pa.requests?.length });
    assert(!pa.error && pa.meta?.includes('Semantische Suche (SeekBook)') && pa.requests?.length === 1 && /\[S\. \d+/.test(pa.content), `pdf semantic: ${pa.meta} / ${pa.content.slice(0, 300)}`);
    pdf.setStrategy('keywords');
    pdf.clear();
  }],
];
