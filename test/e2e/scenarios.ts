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
import { assert, screenshot, SkipError, waitFor, type E2EContext } from './harness';

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
  setPref('provider', Zotero.Prefs.get('seekchat.e2e.liveProvider') || 'ollama');
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

async function askThroughUi(section: Element, question: string): Promise<Element> {
  const doc = section.ownerDocument!;
  const textarea = await waitFor('chat input enabled', () => {
    const t = section.querySelector('textarea.seekchat-input') as HTMLTextAreaElement | null;
    return t && !t.disabled ? t : null;
  });
  const before = section.querySelectorAll('.seekchat-msg.assistant:not(.notice)').length;
  textarea.value = question;
  textarea.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return waitFor('assistant answer with citation', () => {
    const answers = section.querySelectorAll('.seekchat-msg.assistant:not(.notice)');
    const last = answers[answers.length - 1];
    return answers.length > before && last?.querySelector('.seekchat-cite') ? last : null;
  }, 20000);
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
    setPref('provider', 'ollama');
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
    // Auto limits from the mock's /api/show: 80 % of 20480 -> 16384, answer 1638, text (16384-1638-1500)*3.5 -> 46000 chars.
    assert(req.options?.num_ctx === 16384 && req.options?.num_predict === 1638, `auto limits not applied: ${JSON.stringify(req.options)}`);
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

  ['library window: the button appears only next to ZotSeek\'s', async () => {
    const doc = Zotero.getMainWindow().document;
    assert(!getToolbarButton(), 'SeekChat button shown without ZotSeek');
    const zs = installZotSeek();
    try {
      zs.addButton();
      const ours = await waitFor('SeekChat button', () => getToolbarButton(), 5000);
      assert(ours.previousElementSibling?.id === 'zotseek-toolbar-button', `placed after ${ours.previousElementSibling?.id}`);
      doc.getElementById('zotseek-toolbar-button').remove();
      await waitFor('SeekChat button removed', () => !getToolbarButton(), 5000);
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
      const button = await waitFor('SeekChat button', () => getToolbarButton(), 5000);
      button.doCommand();
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
      button.doCommand();
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
      && doc.getElementById('seekchat-auto-detail')?.textContent?.includes('Maximum des Modells'), 10000);
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
    // Zotero 10 has MenuManager: the entries come from there, not from the DOM fallback.
    assert((Zotero as any).MenuManager, 'MenuManager missing in Zotero 10');
    const popup = win.document.getElementById('zotero-itemmenu');
    popup.openPopup(null, 'overlap', 0, 0, true, false);
    const file = await waitFor('file entry', () => popup.querySelector('[data-l10n-id="seekchat-menu-chat-file"]'), 5000);
    assert(!file.hidden, 'file entry hidden for one item with PDF');
    assert(popup.querySelector('[data-l10n-id="seekchat-menu-chat-selection"]')?.hidden, 'selection entry shown for one item');
    popup.hidePopup();

    await win.ZoteroPane.selectItems([a.id, b.id]);
    let state = menuState();
    assert(!state.file && state.selection && !state.selectionEnabled, `two items without ZotSeek: ${JSON.stringify(state)}`);
    const zs = installZotSeek();
    try {
      zs.addButton();
      state = menuState();
      assert(state.selectionEnabled, 'selection entry not enabled with ZotSeek');
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
      registerMenus(Zotero.SeekChat.info.id, `${Zotero.SeekChat.info.rootURI}content/icons/seekchat.svg`);
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

  // Zotero's own connection (NSS store of the profile) must accept the portal's certificate, signed by the in-house CA:
  // otherwise the plugin's automatic update check fails.
  ['tool chat: button without ZotSeek, references imported after confirmation, duplicates offered unchecked', async (ctx) => {
    const win = Zotero.getMainWindow();
    setPref('provider', 'ollama');
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
    setPref('provider', 'ollama');
    setPref('baseUrl', MOCK);
    setPref('model', 'mock-model');
    openToolsChat();
    const toolsWin = await waitFor('tool chat window', () => getToolsChatWindow(), 10000);
    const view = await waitFor('tool chat view', () => getToolsChatView(), 10000);
    const doc = toolsWin.document;
    const session = getToolSession();
    session.clear();
    const list = doc.querySelector('.seekchat-tools-list') as HTMLDetailsElement;
    assert(list && /1 von 1/.test(list.querySelector('summary')!.textContent!), `summary ${list?.querySelector('summary')?.textContent}`);
    list.open = true;
    const item = () => doc.querySelector('.seekchat-tools-item[data-tool="import_references"]') as HTMLElement;
    const select = () => item().querySelector('select[data-option="parser"]') as HTMLSelectElement;
    const findrefsOption = () => Array.from(select().options).find((o) => o.value === 'zotero-reference')!;
    assert(findrefsOption().disabled, 'zotero-reference offered without the plugin');

    // Off: no tools sent, the model just answers.
    const box = item().querySelector('input[type=checkbox]') as HTMLInputElement;
    box.click();
    assert(Zotero.Prefs.get('seekchat.tools.disabled') === 'import_references', `pref ${Zotero.Prefs.get('seekchat.tools.disabled')}`);
    assert(/0 von 1/.test(doc.querySelector('.seekchat-tools-list summary')!.textContent!), 'summary not updated');
    view.input.value = 'Bitte importiere das';
    await view.send();
    const req = await mockLastRequest();
    assert(!req.tools && !session.turns[1].toolRuns?.length, `tools sent while off: ${JSON.stringify(req.tools)}`);
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
    assert(updates.length && updates[updates.length - 1].update_link.startsWith('https://zotero.ils.local/'), JSON.stringify(json).slice(0, 200));
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
