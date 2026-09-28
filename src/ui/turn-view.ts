/**
 * One chat turn as DOM, shared by the PDF section and the library chat window.
 * PDF answers cite pages ([S. 12]); library answers cite numbered sources ([2, S. 12]).
 */
import { splitCitations, splitSourceCitations } from '../core/citations';
import type { LibrarySource } from '../core/library/sources';
import type { Turn } from '../core/session';

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
  if (sources) {
    for (const seg of splitSourceCitations(t.content, sources.length)) {
      if (seg.type === 'text') {
        box.append(doc.createTextNode(seg.text));
        continue;
      }
      const source = sources[seg.n - 1];
      const title = seg.page ? `${source.label}, S. ${seg.page} öffnen` : `${source.label} in der Bibliothek zeigen`;
      box.append(cite(doc, seg.text, title, () => handlers.onSource?.(source, seg.page)));
    }
    return box;
  }
  for (const seg of splitCitations(t.content)) {
    if (seg.type === 'text') box.append(doc.createTextNode(seg.text));
    else box.append(cite(doc, seg.text, `Seite ${seg.page} im PDF öffnen`, () => handlers.onPage?.(seg.page)));
  }
  return box;
}
