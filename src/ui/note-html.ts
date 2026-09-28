/**
 * Chat history as a Zotero note (HTML). Citations become zotero:// links that
 * open the PDF on the cited page or select the cited item. The model requests
 * of the Markdown export are left out – they are too long for a note.
 */
import { splitCitations, splitSourceCitations } from '../core/citations';
import { formatDateTime, type ExportInfo } from '../core/export';
import type { LibrarySource } from '../core/library/sources';
import type { Turn } from '../core/session';
import { escapeHtml, markdownToHtml, type HtmlPiece } from './markdown';

export interface NoteLinks {
  /** Link for a page citation (book answers: in the turn's book). */
  page?: (page: number, turn: Turn) => string | null;
  /** Library chat: link for a source citation (page if given). */
  source?: (source: LibrarySource, page?: number) => string | null;
}

function link(text: string, href: string | null): string {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

export function chatToNoteHtml(turns: Turn[], info: ExportInfo, links: NoteLinks): string {
  const out: string[] = [
    `<h1>SeekChat – ${escapeHtml(info.subject)}</h1>`,
    `<p><em>${escapeHtml(formatDateTime(info.date))}${info.model ? ` · Modell: ${escapeHtml(info.model)}` : ''}</em></p>`,
  ];
  let n = 0;
  for (const t of turns) {
    if (t.pending) continue;
    if (t.role === 'user') {
      n++;
      out.push(`<h2>Frage ${n}</h2>`, `<blockquote><p>${escapeHtml(t.content.trim()).replace(/\n/g, '<br>')}</p></blockquote>`);
      continue;
    }
    if (t.book) out.push(`<h3>Buch: ${escapeHtml(t.book.label)}</h3>`);
    if (t.error) {
      out.push(`<p><strong>${escapeHtml(t.content.trim())}</strong></p>`);
      continue;
    }
    const sources = t.sources;
    const split = (text: string): HtmlPiece[] => sources
      ? splitSourceCitations(text, sources.length).map((seg) => seg.type === 'text' ? seg
        : { type: 'cite' as const, html: link(seg.text, links.source?.(sources[seg.n - 1], seg.page) ?? null) })
      : splitCitations(text).map((seg) => seg.type === 'text' ? seg
        : { type: 'cite' as const, html: link(seg.text, links.page?.(seg.page, t) ?? null) });
    out.push(markdownToHtml(t.content.trim(), split));
    if (t.meta) out.push(`<p><em>${escapeHtml(t.meta.trim()).replace(/\n/g, '<br>')}</em></p>`);
    if (sources?.length) {
      const items = sources.map((s) => {
        const pages = Array.from(new Set(s.excerpts.map((e) => e.page).filter((p): p is number => !!p))).sort((a, b) => a - b);
        const pageLinks = pages.map((p) => link(String(p), links.source?.(s, p) ?? null)).join(', ');
        return `<li>${link(s.label, links.source?.(s) ?? null)}${pages.length ? ` – S. ${pageLinks}` : ''}</li>`;
      });
      out.push('<p>Quellen:</p>', `<ol>${items.join('')}</ol>`);
    }
  }
  return `<div data-schema-version="9">${out.join('\n')}</div>`;
}
