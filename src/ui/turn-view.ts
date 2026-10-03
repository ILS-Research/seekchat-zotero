/**
 * One chat turn as DOM, shared by the PDF section and the library chat window.
 * Answers are rendered as a small Markdown subset (markdown.ts). PDF answers
 * cite pages ([S. 12]); library answers cite numbered sources ([2, S. 12]) and
 * get a source list below the text.
 */
import { t, tn, type Key } from '../i18n';
import { citedSourceNumbers, splitCitations, splitSourceCitations } from '../core/citations';
import { pageGroups, type LibrarySource } from '../core/library/sources';
import { SKIPPABLE, type BookProgress, type ToolRun, type Turn } from '../core/turn';
import { renderMarkdown, type CitationSplitter } from './markdown';
import { compressRanges } from '../core/prompt';
import { bookDetails, bookStateText } from '../core/book-report';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface CitationHandlers {
  /** PDF chat: open the document on this page. */
  onPage?: (page: number, turn: Turn) => void;
  /** Library chat: follow a source citation (page if given). */
  onSource?: (source: LibrarySource, page?: number, attachmentID?: number) => void;
  /** Library chat: skip one book of the running question. */
  onSkipBook?: (turn: Turn, index: number) => void;
  /** Save one finished answer (with its question) as a Zotero note. */
  onSaveAnswer?: (turn: Turn, button: HTMLButtonElement) => void;
  /** Tool chat: the user's answer to a run waiting for confirmation. */
  onToolConfirm?: (run: ToolRun, ok: boolean) => void;
  /** Tool chat: an item of a run waiting for confirmation was checked or unchecked. */
  onToolToggle?: (run: ToolRun, index: number, checked: boolean) => void;
  /** Tool chat: show a Zotero item (saved or already present). */
  onShowItem?: (itemID: number) => void;
}

function el(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const e = doc.createElementNS(HTML_NS, tag) as HTMLElement;
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function cite(doc: Document, text: string, title: string, onClick: () => void): HTMLElement {
  const a = el(doc, 'span', 'seekchat-cite', text);
  a.title = title;
  a.addEventListener('click', onClick);
  return a;
}

/** Numbers of the sources an answer cites (1..count, or the numbers of the given sources). */
export function citedSources(content: string, sources: number | LibrarySource[]): Set<number> {
  if (typeof sources === 'number') return citedSourceNumbers(content, sources);
  const known = new Set(sources.map((s) => s.n));
  return citedSourceNumbers(content, (n) => known.has(n));
}


/** Books of a library question: state per book, "skip" while it is still open. */
function bookList(doc: Document, turn: Turn, handlers: CitationHandlers): HTMLElement {
  const progress = turn.bookProgress!;
  const done = progress.filter((b) => !SKIPPABLE.includes(b.state)).length;
  const box = el(doc, 'details', 'seekchat-books-progress') as HTMLDetailsElement;
  box.open = !!turn.pending;
  box.append(el(doc, 'summary', '', t('book.progress', { done, n: progress.length })));
  const list = el(doc, 'ul');
  progress.forEach((b, i) => {
    const li = el(doc, 'li', `state-${b.state}`);
    li.append(el(doc, 'span', 'seekchat-book-label', `📖 ${b.label}`), doc.createTextNode(' – '), el(doc, 'span', 'seekchat-book-state', bookStateText(b)));
    if (turn.pending && SKIPPABLE.includes(b.state) && handlers.onSkipBook) {
      const skip = el(doc, 'button', 'seekchat-book-skip', t('book.skip')) as HTMLButtonElement;
      skip.title = t('book.skipTitle');
      skip.addEventListener('click', () => handlers.onSkipBook!(turn, i));
      li.append(doc.createTextNode(' '), skip);
    }
    for (const line of bookDetails(b)) li.append(el(doc, 'div', 'seekchat-book-details', line));
    list.append(li);
  });
  box.append(list);
  return box;
}

/** One tool call: title and state, its items (checkboxes while it waits for confirmation), the buttons. */
function toolRunBox(doc: Document, run: ToolRun, handlers: CitationHandlers): HTMLElement {
  const box = el(doc, 'div', `seekchat-tool-run state-${run.state}`);
  const head = el(doc, 'div', 'seekchat-tool-head');
  head.append(el(doc, 'span', 'seekchat-tool-title', `🛠 ${run.title}`), doc.createTextNode(' – '), el(doc, 'span', 'seekchat-tool-state', t(`tools.state.${run.state}` as Key)));
  box.append(head);
  if (run.status) box.append(el(doc, 'div', 'seekchat-tool-status', run.status));
  if (run.items?.length) {
    const list = el(doc, 'ul', 'seekchat-tool-items');
    run.items.forEach((item, i) => {
      const li = el(doc, 'li');
      if (run.state === 'confirm' && item.selectable) {
        const box = el(doc, 'input') as HTMLInputElement;
        box.type = 'checkbox';
        box.checked = !!item.checked;
        box.addEventListener('change', () => handlers.onToolToggle?.(run, i, box.checked));
        li.append(box, doc.createTextNode(' '));
      }
      if (item.badge) li.append(el(doc, 'span', 'seekchat-tool-badge', item.badge), doc.createTextNode(' '));
      li.append(item.itemID && handlers.onShowItem
        ? cite(doc, item.label, t('lib.showInLibrary'), () => handlers.onShowItem!(item.itemID!))
        : el(doc, 'span', 'seekchat-tool-label', item.label));
      if (item.detail) li.append(el(doc, 'div', 'seekchat-tool-detail', item.detail));
      list.append(li);
    });
    box.append(list);
  }
  if (run.state === 'confirm' && handlers.onToolConfirm) {
    const row = el(doc, 'div', 'seekchat-tool-buttons');
    const ok = el(doc, 'button', 'seekchat-tool-ok', t('tools.confirm')) as HTMLButtonElement;
    ok.disabled = !run.items?.some((x) => x.selectable && x.checked);
    ok.addEventListener('click', () => handlers.onToolConfirm!(run, true));
    const cancel = el(doc, 'button', 'seekchat-tool-cancel', t('tools.cancel')) as HTMLButtonElement;
    cancel.addEventListener('click', () => handlers.onToolConfirm!(run, false));
    row.append(ok, cancel);
    box.append(row);
  }
  return box;
}

function sourceList(doc: Document, sources: LibrarySource[], cited: Set<number>, handlers: CitationHandlers): HTMLElement {
  const box = el(doc, 'div', 'seekchat-sources');
  box.append(el(doc, 'div', 'seekchat-sources-title', t('lib.sourceList', { cited: cited.size, total: sources.length })));
  const list = el(doc, 'ol', 'seekchat-sources-list');
  for (const s of sources) {
    const li = el(doc, 'li', cited.has(s.n) ? 'cited' : 'uncited') as HTMLLIElement;
    li.value = s.n;
    if (s.origin === 'book') li.append(doc.createTextNode('📖 '));
    li.append(cite(doc, s.label, t('lib.showInLibrary'), () => handlers.onSource?.(s)));
    // Pages per PDF: a book can have several ("Teil 1: S. 12, 15 · Teil 3: S. 204").
    const groups = pageGroups(s);
    if (groups.length) {
      li.append(doc.createTextNode(' – '));
      groups.forEach((g, gi) => {
        if (gi) li.append(doc.createTextNode(' · '));
        li.append(doc.createTextNode(`${g.title ? `${g.title}: ` : ''}${t('cite.page')} `));
        g.pages.forEach((p, i) => {
          if (i) li.append(doc.createTextNode(', '));
          li.append(cite(doc, String(p), t('pdf.openPage', { page: p }), () => handlers.onSource?.(s, p, g.attachmentID)));
        });
      });
    } else if (s.excerpts.some((e) => e.textSource === 'note')) {
      li.append(doc.createTextNode(` – ${t('lib.note')}`));
    }
    list.append(li);
  }
  box.append(list);
  return box;
}

/** One turn; an answer with a SeekChat notice comes as a fragment: the answer, then the notice as its own message. */
export function renderTurn(doc: Document, turn: Turn, handlers: CitationHandlers, pendingText = t('pdf.reading')): Node {
  const box = renderMessage(doc, turn, handlers, pendingText);
  if (!turn.notice || turn.pending) return box;
  const frag = doc.createDocumentFragment();
  frag.append(box, el(doc, 'div', 'seekchat-msg assistant notice', turn.notice));
  return frag;
}

function renderMessage(doc: Document, turn: Turn, handlers: CitationHandlers, pendingText: string): HTMLElement {
  const box = el(doc, 'div', `seekchat-msg ${turn.role}${turn.error ? ' error' : ''}`);
  if (turn.role === 'user') {
    box.append(doc.createTextNode(turn.content));
    return box;
  }
  if (turn.bookProgress?.length) box.append(bookList(doc, turn, handlers));
  for (const run of turn.toolRuns || []) box.append(toolRunBox(doc, run, handlers));
  if (turn.error) {
    box.append(doc.createTextNode(turn.content));
    return box;
  }
  if (turn.meta) box.append(el(doc, 'span', 'seekchat-meta', turn.meta));
  if (turn.pending && !turn.content) {
    if (!turn.toolRuns?.length) box.append(doc.createTextNode(turn.meta ? '…' : pendingText));
    return box;
  }
  const sources = turn.sources;
  let split: CitationSplitter;
  if (sources) {
    const byN = new Map(sources.map((s) => [s.n, s]));
    split = (text) => splitSourceCitations(text, (n) => byN.has(n)).map((seg) => {
      if (seg.type === 'text') return seg;
      const source = byN.get(seg.n)!;
      const title = seg.page ? t('lib.openSourcePage', { label: source.label, pageLabel: t('cite.page'), page: seg.page }) : t('lib.showSource', { label: source.label });
      return { type: 'cite' as const, node: cite(doc, seg.text, title, () => handlers.onSource?.(source, seg.page)) };
    });
  } else {
    split = (text) => splitCitations(text).map((seg) => seg.type === 'text' ? seg
      : { type: 'cite' as const, node: cite(doc, seg.text, t('pdf.openPage', { page: seg.page }), () => handlers.onPage?.(seg.page, turn)) });
  }
  const body = el(doc, 'div', 'seekchat-md');
  body.append(renderMarkdown(doc, turn.content, split));
  box.append(body);
  if (sources?.length && !turn.pending) box.append(sourceList(doc, sources, citedSources(turn.content, sources), handlers));
  if (!turn.pending && turn.content && handlers.onSaveAnswer) {
    const btn = el(doc, 'button', 'seekchat-answer-note', t(turn.noteSaved ? 'pdf.answerNoted' : 'pdf.answerNote')) as HTMLButtonElement;
    btn.disabled = !!turn.noteSaved;
    btn.title = t('pdf.answerNoteTitle');
    btn.addEventListener('click', () => handlers.onSaveAnswer!(turn, btn));
    box.append(btn);
  }
  return box;
}

/** What a turn's rendering depends on; a turn whose signature is unchanged keeps its DOM. */
export function turnSignature(turn: Turn): string {
  return JSON.stringify([
    turn.role, turn.content, turn.notice, turn.meta, !!turn.error, !!turn.pending, !!turn.noteSaved,
    turn.sources?.map((s) => s.n), turn.bookProgress, turn.toolRuns,
  ]);
}

/**
 * Keeps the rendered turns of one chat and redraws only turns that changed. While an answer
 * streams, the earlier messages stay untouched: text in them can be selected, and details
 * opened by the user stay open.
 */
export class TurnListView {
  private cache = new Map<Turn, { sig: string; nodes: Node[] }>();
  private owner: unknown = null;

  /** Renders `turns` into `container`; `owner` (the session) change drops everything cached. */
  update(container: HTMLElement, turns: Turn[], handlers: CitationHandlers, owner: unknown, pendingText?: string): void {
    if (owner !== this.owner) this.reset(owner);
    const doc = container.ownerDocument;
    const next = new Map<Turn, { sig: string; nodes: Node[] }>();
    const nodes: Node[] = [];
    for (const turn of turns) {
      const sig = turnSignature(turn);
      let entry = this.cache.get(turn);
      if (!entry || entry.sig !== sig) {
        const rendered = renderTurn(doc, turn, handlers, pendingText);
        const fresh = rendered.nodeType === 11 ? Array.from(rendered.childNodes) : [rendered];
        // Keep a book list the user opened or closed while the question runs.
        const old = entry?.nodes[0] as HTMLElement | undefined;
        const oldBox = old?.querySelector?.('.seekchat-books-progress') as HTMLDetailsElement | null | undefined;
        const newBox = (fresh[0] as HTMLElement).querySelector?.('.seekchat-books-progress') as HTMLDetailsElement | null;
        if (oldBox && newBox && turn.pending) newBox.open = oldBox.open;
        entry = { sig, nodes: fresh };
      }
      next.set(turn, entry);
      nodes.push(...entry.nodes);
    }
    this.cache = next;
    // Move only what differs, so unchanged nodes are never detached.
    let ref = container.firstChild;
    for (const n of nodes) {
      if (n === ref) {
        ref = ref.nextSibling;
        continue;
      }
      container.insertBefore(n, ref);
    }
    while (ref) {
      const after: ChildNode | null = ref.nextSibling;
      ref.remove();
      ref = after;
    }
  }

  reset(owner: unknown = null): void {
    this.cache.clear();
    this.owner = owner;
  }
}
