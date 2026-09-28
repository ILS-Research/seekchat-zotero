/**
 * One chat turn as DOM, shared by the PDF section and the library chat window.
 * Answers are rendered as a small Markdown subset (markdown.ts). PDF answers
 * cite pages ([S. 12]); library answers cite numbered sources ([2, S. 12]) and
 * get a source list below the text.
 */
import { splitCitations, splitSourceCitations } from '../core/citations';
import type { LibrarySource } from '../core/library/sources';
import type { Turn } from '../core/session';
import { renderMarkdown, type CitationSplitter } from './markdown';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface CitationHandlers {
  /** PDF chat: open the document on this page. */
  onPage?: (page: number) => void;
  /** Library chat: follow a source citation (page if given). */
  onSource?: (source: LibrarySource, page?: number) => void;
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

/** Numbers of the sources an answer cites. */
export function citedSources(content: string, sourceCount: number): Set<number> {
  const cited = new Set<number>();
  for (const seg of splitSourceCitations(content, sourceCount)) if (seg.type === 'source') cited.add(seg.n);
  return cited;
}

function sourceList(doc: Document, sources: LibrarySource[], cited: Set<number>, handlers: CitationHandlers): HTMLElement {
  const box = el(doc, 'div', 'seekchat-sources');
  box.append(el(doc, 'div', 'seekchat-sources-title', `Quellen (${cited.size} von ${sources.length} zitiert)`));
  const list = el(doc, 'ol', 'seekchat-sources-list');
  for (const s of sources) {
    const li = el(doc, 'li', cited.has(s.n) ? 'cited' : 'uncited') as HTMLLIElement;
    li.value = s.n;
    li.append(cite(doc, s.label, 'In der Bibliothek zeigen', () => handlers.onSource?.(s)));
    const pages = Array.from(new Set(s.excerpts.map((e) => e.page).filter((p): p is number => !!p))).sort((a, b) => a - b);
    if (pages.length) {
      li.append(doc.createTextNode(' – S. '));
      pages.forEach((p, i) => {
        if (i) li.append(doc.createTextNode(', '));
        li.append(cite(doc, String(p), `Seite ${p} im PDF öffnen`, () => handlers.onSource?.(s, p)));
      });
    } else if (s.excerpts.some((e) => e.textSource === 'note')) {
      li.append(doc.createTextNode(' – Notiz'));
    }
    list.append(li);
  }
  box.append(list);
  return box;
}

export function renderTurn(doc: Document, t: Turn, handlers: CitationHandlers, pendingText = 'Lese PDF …'): HTMLElement {
  const box = el(doc, 'div', `seekchat-msg ${t.role}${t.error ? ' error' : ''}`);
  if (t.role === 'user' || t.error) {
    box.textContent = t.content;
    return box;
  }
  if (t.meta) box.append(el(doc, 'span', 'seekchat-meta', t.meta));
  if (t.pending && !t.content) {
    box.append(doc.createTextNode(t.meta ? '…' : pendingText));
    return box;
  }
  const sources = t.sources;
  let split: CitationSplitter;
  if (sources) {
    split = (text) => splitSourceCitations(text, sources.length).map((seg) => {
      if (seg.type === 'text') return seg;
      const source = sources[seg.n - 1];
      const title = seg.page ? `${source.label}, S. ${seg.page} öffnen` : `${source.label} in der Bibliothek zeigen`;
      return { type: 'cite' as const, node: cite(doc, seg.text, title, () => handlers.onSource?.(source, seg.page)) };
    });
  } else {
    split = (text) => splitCitations(text).map((seg) => seg.type === 'text' ? seg
      : { type: 'cite' as const, node: cite(doc, seg.text, `Seite ${seg.page} im PDF öffnen`, () => handlers.onPage?.(seg.page)) });
  }
  const body = el(doc, 'div', 'seekchat-md');
  body.append(renderMarkdown(doc, t.content, split));
  box.append(body);
  if (sources?.length && !t.pending) box.append(sourceList(doc, sources, citedSources(t.content, sources.length), handlers));
  return box;
}
