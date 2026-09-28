/**
 * One chat turn as DOM, shared by the PDF section and the library chat window.
 * Answers are rendered as a small Markdown subset (markdown.ts). PDF answers
 * cite pages ([S. 12]); library answers cite numbered sources ([2, S. 12]) and
 * get a source list below the text.
 */
import { t, tn, type Key } from '../i18n';
import { citedSourceNumbers, splitCitations, splitSourceCitations } from '../core/citations';
import { sourcePages, type LibrarySource } from '../core/library/sources';
import { SKIPPABLE, type BookProgress, type Turn } from '../core/session';
import { renderMarkdown, type CitationSplitter } from './markdown';
import { compressRanges } from '../core/prompt';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface CitationHandlers {
  /** PDF chat: open the document on this page. */
  onPage?: (page: number, turn: Turn) => void;
  /** Library chat: follow a source citation (page if given). */
  onSource?: (source: LibrarySource, page?: number) => void;
  /** Library chat: skip one book of the running question. */
  onSkipBook?: (turn: Turn, index: number) => void;
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


export { bookDetails, bookStateText } from '../core/book-report';
import { bookDetails, bookStateText } from '../core/book-report';

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

function sourceList(doc: Document, sources: LibrarySource[], cited: Set<number>, handlers: CitationHandlers): HTMLElement {
  const box = el(doc, 'div', 'seekchat-sources');
  box.append(el(doc, 'div', 'seekchat-sources-title', t('lib.sourceList', { cited: cited.size, total: sources.length })));
  const list = el(doc, 'ol', 'seekchat-sources-list');
  for (const s of sources) {
    const li = el(doc, 'li', cited.has(s.n) ? 'cited' : 'uncited') as HTMLLIElement;
    li.value = s.n;
    if (s.origin === 'book') li.append(doc.createTextNode('📖 '));
    li.append(cite(doc, s.label, t('lib.showInLibrary'), () => handlers.onSource?.(s)));
    const pages = sourcePages(s);
    if (pages.length) {
      li.append(doc.createTextNode(` – ${t('cite.page')} `));
      pages.forEach((p, i) => {
        if (i) li.append(doc.createTextNode(', '));
        li.append(cite(doc, String(p), t('pdf.openPage', { page: p }), () => handlers.onSource?.(s, p)));
      });
    } else if (s.excerpts.some((e) => e.textSource === 'note')) {
      li.append(doc.createTextNode(` – ${t('lib.note')}`));
    }
    list.append(li);
  }
  box.append(list);
  return box;
}

export function renderTurn(doc: Document, turn: Turn, handlers: CitationHandlers, pendingText = t('pdf.reading')): HTMLElement {
  const box = el(doc, 'div', `seekchat-msg ${turn.role}${turn.error ? ' error' : ''}`);
  if (turn.role === 'user') {
    box.append(doc.createTextNode(turn.content));
    return box;
  }
  if (turn.bookProgress?.length) box.append(bookList(doc, turn, handlers));
  if (turn.error) {
    box.append(doc.createTextNode(turn.content));
    return box;
  }
  if (turn.meta) box.append(el(doc, 'span', 'seekchat-meta', turn.meta));
  if (turn.pending && !turn.content) {
    box.append(doc.createTextNode(turn.meta ? '…' : pendingText));
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
  return box;
}
