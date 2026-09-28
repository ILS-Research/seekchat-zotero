/**
 * E2E scenarios, run in order inside a real Zotero against the mock LLM
 * (e2e/mock-llm.mjs). Later scenarios use what earlier ones put in ctx.
 * Add new scenarios at the end of the list.
 */
import { getPdfPages, PdfContextProvider } from '../../src/core/context/pdf-context';
import { analyzeFit } from '../../src/core/context/fit';
import { buildOutline, type OutlineNode } from '../../src/core/context/outline';
import { readPrefs } from '../../src/prefs';
import { getSession } from '../../src/core/session';
import { setPref } from '../../src/prefs';
import { getRegisteredPaneID } from '../../src/ui/chat-section';
import { createClient } from '../../src/core/llm';
import { getZotSeekStatus, searchPassages, ZotSeekUnavailableError } from '../../src/core/zotseek/client';
import { collectionScope, itemsScope, libraryScope, LibraryContextProvider } from '../../src/core/library/library-context';
import { openSourceCitation } from '../../src/core/library/zotero-items';
import { getLibraryChatWindow, getPrefsPaneID } from '../../src/ui/library-window';
import { getToolbarButton } from '../../src/ui/toolbar-button';
import { setSaveChatTestPath } from '../../src/ui/save-chat';
import { splitSourceCitations } from '../../src/core/citations';
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

/** Page numbers marked [Seite N] in a system prompt. */
function sentPages(system: string): number[] {
  return [...system.matchAll(/\[Seite (\d+)\]/g)].map((m) => Number(m[1]));
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
  const before = section.querySelectorAll('.seekchat-msg.assistant').length;
  textarea.value = question;
  textarea.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return waitFor('assistant answer with citation', () => {
    const answers = section.querySelectorAll('.seekchat-msg.assistant');
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
    assert(req.messages[0].content.includes('[Seite 2]'), 'document pages missing in system prompt');
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
    assert(strategies[0].querySelector('.seekchat-badge') && !strategies[1].querySelector('.seekchat-badge') && !strategies[2].querySelector('.seekchat-badge'),
      'placeholder badges wrong');
    ctx.longSection = section;
  }],

  ['long PDF: unimplemented strategy is greyed out and cannot be picked', async (ctx) => {
    const section: Element = ctx.longSection;
    for (const id of ['vector']) {
      const row = section.querySelector(`.seekchat-strategy[data-strategy="${id}"]`) as HTMLElement;
      const radio = row.querySelector('input') as HTMLInputElement;
      assert(radio.disabled && row.classList.contains('disabled'), `${id} is not disabled`);
      row.click();
      radio.click();
      assert(!radio.checked, `${id} could be selected`);
      assert(row.textContent!.includes(' noch ohne Funktion'), `badge text not separated: ${row.textContent}`);
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
    assert(reqs[0].messages[0].content.includes('Sprache des folgenden Textauszugs'), 'first request is not the language request');
    assert(reqs[0].messages[1].content.includes('Kapitel 1') || reqs[0].messages[1].content.includes('Langes Buch'), 'language sample lacks the first pages');
    assert(reqs[1].messages[0].content.includes('ausschließlich auf Deutsch'), 'keyword request not restricted to the document language');
    const system: string = reqs[2].messages[0].content;
    assert(system.includes('[Seite 27]') && system.includes('Waermeinseln'), 'matching page 27 not sent');
    const pagesSent = (system.match(/\[Seite \d+\]/g) || []).length;
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
    assert(reqs[0].messages[0].content.includes('ausschließlich auf Englisch'), 'metadata language not used for keywords');
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
      assert(system.includes('<quellen>') && system.includes('[1] Muster 2021 – SeekChat E2E Testdokument') && system.includes('(S. 27)'),
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

  ['library chat: no usable ZotSeek result means a hint and no model call', async () => {
    const session = getSession(new LibraryContextProvider(libraryScope(Zotero.Libraries.userLibraryID)));
    const ask = async () => {
      session.clear();
      const before = (await mockRequests()).length;
      await session.ask('Was steht zu Starkregen?');
      const answer = session.turns[session.turns.length - 1];
      assert(answer.error, `expected a hint, got: ${answer.content}`);
      assert((await mockRequests()).length === before, 'model was called anyway');
      return answer.content;
    };
    let msg = await ask();
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
      assert(doc.querySelector('.seekchat-library-note:not(.seekchat-library-coverage)')?.textContent?.includes('Literaturverzeichnis'), 'note on ZotSeek limits missing');
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
        const msgs = doc.querySelectorAll('.seekchat-msg.assistant');
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
        && exported.includes('Anfrage 1 an das Modell: Antwort') && exported.includes('<quellen>'), `export: ${exported.slice(0, 400)}`);
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
      await waitFor('earlier chat back', () => scopeText() === '2 ausgewählte Einträge' && doc.querySelectorAll('.seekchat-msg.assistant').length === 1, 5000);
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
  ['live: model server lists the configured model', async (ctx) => {
    useLiveServer(ctx);
    const prefs = readPrefs();
    const models = await createClient(prefs).listModels();
    await reportLive(ctx, { step: 'models', url: prefs.baseUrl, models });
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
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    session.clear();
    const t0 = Date.now();
    await session.ask('Was sagt das Buch zum Stadtklima?');
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
];
