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
import { assert, screenshot, waitFor, type E2EContext } from './harness';

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
    assert(req.options?.num_ctx > 0, 'num_ctx not sent');
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
    assert(strategies[0].querySelector('.seekchat-badge') && strategies[2].querySelector('.seekchat-badge') && !strategies[1].querySelector('.seekchat-badge'),
      'placeholder badges wrong');
    ctx.longSection = section;
  }],

  ['long PDF: chapter picker shows a tree with token sum', async (ctx) => {
    const section: Element = ctx.longSection;
    const radio = section.querySelector('.seekchat-strategy[data-strategy="chapters"] input') as HTMLInputElement;
    radio.click();
    const tree = await waitFor('chapter tree', () => section.querySelector('.seekchat-chapters'));
    const boxes = Array.from(tree.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    assert(boxes.length >= 2, `expected chapters, got ${boxes.length}: ${tree.textContent}`);
    const sum = section.querySelector('.seekchat-chapter-sum')!;
    const before = sum.textContent;
    boxes[1].click();
    await waitFor('sum updates', () => sum.textContent !== before);
    assert(!sum.textContent!.includes('~0 von'), `sum still zero: ${sum.textContent}`);
    ctx.chapterSource = section.querySelector('.seekchat-strategy-panel .seekchat-hint')?.textContent;
    Zotero.debug(`[SeekChat E2E] chapter source: ${ctx.chapterSource}`);
    const p5 = (await getPdfPages(ctx.longAttachment))[4].text;
    Zotero.debug(`[SeekChat E2E] page 5 starts: ${JSON.stringify(p5.slice(0, 160))}`);
    await screenshot(ctx, 'chapters');
    (section.querySelector('.seekchat-strategy[data-strategy="keywords"] input') as HTMLInputElement).click();
    await waitFor('chapter panel closed', () => !section.querySelector('.seekchat-chapters'));
  }],

  ['long PDF: model keywords find the matching page', async (ctx) => {
    const before = (await mockRequests()).length;
    const session = getSession(new PdfContextProvider(ctx.longAttachment));
    await session.ask('Was sagt das Buch zum Stadtklima?');
    const answer = session.turns[session.turns.length - 1];
    assert(!answer.error, `answer is an error: ${answer.content}`);
    assert(answer.meta?.includes('Suchbegriffe: Waermeinseln'), `keywords missing in meta: ${answer.meta}`);
    const reqs = (await mockRequests()).slice(before);
    assert(reqs.length === 2, `expected keyword + answer request, got ${reqs.length}`);
    assert(reqs[0].messages[0].content.includes('Suchbegriffe'), 'first request is not the keyword request');
    const system: string = reqs[1].messages[0].content;
    assert(system.includes('[Seite 27]') && system.includes('Waermeinseln'), 'matching page 27 not sent');
    assert(system.includes('Auszüge') || system.includes('zu lang'), 'excerpt note missing');
    const pagesSent = (system.match(/\[Seite \d+\]/g) || []).length;
    assert(pagesSent < 40, `whole book sent (${pagesSent} pages)`);
    session.clear();
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
      const reader = await Zotero.Reader.open(attachment.id);
      // Diagnostics: where does the reader keep the PDF outline?
      const probe = () => {
        const ir = reader?._internalReader;
        const st = ir?._state;
        const o = st?.outline;
        return {
          internalReader: typeof ir,
          stateType: typeof st,
          stateKeys: st ? Object.keys(st).slice(0, 60).join(',') : null,
          outlineType: o === null ? 'null' : typeof o,
          outlineIsArray: Array.isArray(o),
          outlineLength: o?.length,
          baseViewOutline: typeof ir?._baseViewOutline,
          primaryViewOutline: typeof ir?._primaryView?._outline,
          primaryViewOutlineLen: ir?._primaryView?._outline?.length,
          firstItem: o?.[0] ? JSON.stringify(o[0]).slice(0, 300) : null,
        };
      };
      await waitFor('2s', () => false, 2000).catch(() => {});
      Zotero.debug(`[SeekChat E2E] outline probe before activation: ${JSON.stringify(probe())}`);
      // The reader loads the outline only while its sidebar shows the outline view;
      // trigger the loading directly, without touching the visible UI.
      reader?._internalReader?._primaryView?._documentData?.setOutlineActive(true);
      for (const t of [2, 10]) {
        await waitFor(`${t}s`, () => false, t * 1000).catch(() => {});
        Zotero.debug(`[SeekChat E2E] outline probe after +${t}s: ${JSON.stringify(probe())}`);
      }
      const o = reader?._internalReader?._state?.outline;
      const readerItems = o && o.length !== undefined ? Array.from(o as any[]) : null;
      const pdfOutline = buildOutline(pages, readerItems);
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
        readerOutlineItems: readerItems?.length ?? null,
        outline: { source: pdfOutline.source, count: pdfOutline.nodes.length, nodes: brief(pdfOutline.nodes) },
        textOutline: { source: textOutline.source, count: textOutline.nodes.length, nodes: brief(textOutline.nodes) },
        keywordSelection: { ms: Date.now() - t1, mode: sel.mode, pages: sel.includedPages, matched: sel.matchedPages, noMatches: sel.noMatches },
      });
      win.Zotero_Tabs.close(reader.tabID);
    }
    await Zotero.File.putContentsAsync(`${ctx.outDir}/assets-report.json`, JSON.stringify(report, null, 2));
  }],
];
