/**
 * Documents other than PDFs the chat can read: web page snapshots (HTML), EPUB and plain text files. Their
 * text comes from Zotero's full-text cache (Zotero extracts HTML and EPUB itself) or the file, and is cut into
 * sections of about a page so the long-document selection works as for PDFs. Sections are internal only:
 * like a reference list cites a web page or e-book as a whole, answers cite no locations in these documents.
 */
import { t } from '../../i18n';
import { UserFacingError } from '../errors';
import type { Page } from './types';
import { decodeEntities } from './notes';

export type DocKind = 'pdf' | 'html' | 'epub' | 'text';

/** Characters per section, about one printed page. */
export const SECTION_CHARS = 3000;

/** Text types read directly from the file (HTML has its own kind). */
const TEXT_TYPES = /^text\/(plain|markdown|x-markdown|csv|tab-separated-values|x-tex|xml)$|^application\/(json|xml)$/;

/** Which kind of document an attachment is, or null if the chat cannot read it (links, images, Word …). */
export function docKind(att: any): DocKind | null {
  if (!att?.isAttachment?.() || att.deleted) return null;
  if (att.attachmentLinkMode === Zotero.Attachments?.LINK_MODE_LINKED_URL) return null;
  if (att.isPDFAttachment?.()) return 'pdf';
  const type = String(att.attachmentContentType || '').toLowerCase();
  if (att.isEPUBAttachment?.() || type === 'application/epub+zip') return 'epub';
  if (type === 'text/html' || type === 'application/xhtml+xml' || att.isSnapshotAttachment?.()) return 'html';
  if (TEXT_TYPES.test(type)) return 'text';
  return null;
}

export function isChatDocument(att: any): boolean {
  return docKind(att) !== null;
}

/** Preference among an item's attachments when none is chosen: PDF, then EPUB, web page, text. */
export const KIND_ORDER: DocKind[] = ['pdf', 'epub', 'html', 'text'];

/**
 * Cuts text into sections of at most `size` characters at paragraph borders (blank lines, else lines);
 * a longer paragraph is split at sentence ends, else at spaces. Pure (unit-tested).
 */
export function splitSections(text: string, size = SECTION_CHARS): Page[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paragraphs = (clean.includes('\n\n') ? clean.split(/\n\n/) : clean.split(/\n/)).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= size) {
      pieces.push(p);
      continue;
    }
    let rest = p;
    while (rest.length > size) {
      const window = rest.slice(0, size);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      const at = cut > size / 2 ? cut + 1 : window.lastIndexOf(' ') > size / 2 ? window.lastIndexOf(' ') : size;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const sections: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      sections.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) sections.push(current);
  return sections.map((s, i) => ({ pageNumber: i + 1, text: s }));
}

/** Visible text of an HTML document (no scripts, styles, navigation markup), with paragraph breaks. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|header|footer|table|ul|ol|dd|dt)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
  return decodeEntities(text);
}

/** Zotero's extracted full text of the attachment (.zotero-ft-cache), indexing it first if needed. */
async function fulltextCache(att: any): Promise<string> {
  const read = async () => {
    const file = Zotero.Fulltext.getItemCacheFile(att);
    return file.exists() ? String(await Zotero.File.getContentsAsync(file.path)) : '';
  };
  let text = await read();
  if (!text.trim()) {
    await Zotero.Fulltext.indexItems([att.id], { complete: true, ignoreErrors: true });
    text = await read();
  }
  return text;
}

/** Text of a non-PDF document, cut into sections. */
export async function getDocumentSections(att: any, kind: Exclude<DocKind, 'pdf'>): Promise<Page[]> {
  const path = await att.getFilePathAsync();
  if (!path) throw new UserFacingError(t('pdf.missingFile'));
  let text = '';
  if (kind === 'text') {
    text = String(await Zotero.File.getContentsAsync(path));
  } else {
    text = await fulltextCache(att);
    // HTML not indexed (e.g. indexing switched off): read the snapshot itself.
    if (!text.trim() && kind === 'html') text = htmlToText(String(await Zotero.File.getContentsAsync(path)));
  }
  const sections = splitSections(text);
  if (!sections.length) throw new UserFacingError(t('doc.noText'));
  return sections;
}
