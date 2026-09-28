/**
 * Chat history as a Zotero note (HTML). Citations become zotero:// links that
 * open the PDF on the cited page or select the cited item. The model requests
 * of the Markdown export are left out – they are too long for a note.
 */
import { splitCitations, splitSourceCitations } from '../core/citations';
import { formatDateTime, type ExportInfo } from '../core/export';
import { sourcePages, type LibrarySource } from '../core/library/sources';
import type { Turn } from '../core/session';
import { escapeHtml, markdownToHtml, type HtmlPiece } from './markdown';
import { t } from '../i18n';

export interface NoteLinks {
  /** PDF chat: link for a page citation. */
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
    `<p><em>${escapeHtml(formatDateTime(info.date))}${info.model ? escapeHtml(t('export.model', { model: info.model })) : ''}</em></p>`,
  ];
  let n = 0;
  for (const turn of turns) {
    if (turn.pending) continue;
    if (turn.role === 'user') {
      n++;
      out.push(`<h2>${escapeHtml(t('export.question', { n }))}</h2>`, `<blockquote><p>${escapeHtml(turn.content.trim()).replace(/\n/g, '<br>')}</p></blockquote>`);
      continue;
    }
    if (turn.error) {
      out.push(`<p><strong>${escapeHtml(turn.content.trim())}</strong></p>`);
      continue;
    }
    const sources = turn.sources;
    const byN = new Map((sources || []).map((s) => [s.n, s]));
    const split = (text: string): HtmlPiece[] => sources
      ? splitSourceCitations(text, (n) => byN.has(n)).map((seg) => seg.type === 'text' ? seg
        : { type: 'cite' as const, html: link(seg.text, links.source?.(byN.get(seg.n)!, seg.page) ?? null) })
      : splitCitations(text).map((seg) => seg.type === 'text' ? seg
        : { type: 'cite' as const, html: link(seg.text, links.page?.(seg.page, turn) ?? null) });
    out.push(markdownToHtml(turn.content.trim(), split));
    if (turn.meta) out.push(`<p><em>${escapeHtml(turn.meta.trim()).replace(/\n/g, '<br>')}</em></p>`);
    if (sources?.length) {
      const items = sources.map((s) => {
        const pages = sourcePages(s);
        const pageLinks = pages.map((p) => link(String(p), links.source?.(s, p) ?? null)).join(', ');
        const origin = s.origin === 'book' ? ` (${escapeHtml(t('lib.originBook'))})` : '';
        return `<li value="${s.n}">${link(s.label, links.source?.(s) ?? null)}${origin}${pages.length ? ` – ${escapeHtml(t('cite.page'))} ${pageLinks}` : ''}</li>`;
      });
      out.push(`<p>${escapeHtml(t('export.sources'))}</p>`, `<ol>${items.join('')}</ol>`);
    }
  }
  return `<div data-schema-version="9">${out.join('\n')}</div>`;
}
