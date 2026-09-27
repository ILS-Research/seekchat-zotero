import { formatPages } from '../prompt';
import { analyzeFit, type FitInfo } from './fit';
import { buildOutline, type Outline, type ReaderOutlineItem } from './outline';
import { buildTerms, selectPagesByTerms } from './page-selection';
import type { BuildOptions, ContextBlock, ContextProvider, Page } from './types';

/** Extracted pages per attachment, invalidated when the attachment item changes. */
const pageCache = new Map<number, { version: string; pages: Page[] }>();

export class UserFacingError extends Error {}

/** Page texts of a PDF attachment via Zotero's PDF worker (form feed = page break). */
export async function getPdfPages(attachment: any): Promise<Page[]> {
  const version = `${attachment.version}:${attachment.dateModified}`;
  const cached = pageCache.get(attachment.id);
  if (cached && cached.version === version) return cached.pages;

  const path = await attachment.getFilePathAsync();
  if (!path) {
    throw new UserFacingError('Die PDF-Datei ist auf diesem Rechner nicht vorhanden (noch nicht synchronisiert/heruntergeladen).');
  }
  const result = await Zotero.PDFWorker.getFullText(attachment.id, null, true);
  const text: string = result?.text || '';
  const pages = text.split('\f').map((t, i) => ({ pageNumber: i + 1, text: t.trim() }));
  if (!pages.some((p) => p.text)) {
    throw new UserFacingError('Das PDF enthält keinen Text (gescannt?). Bitte zuerst OCR ausführen.');
  }
  pageCache.set(attachment.id, { version, pages });
  return pages;
}

export function clearPageCache(): void {
  pageCache.clear();
}

/** "Müller, Schmidt 2021 – Titel" from the parent item, falling back to the attachment title. */
export function describeItem(attachment: any): string {
  const parent = attachment.parentItem || attachment;
  const title = parent.getField?.('title') || attachment.getField?.('title') || 'Unbenanntes Dokument';
  const creators: any[] = parent.getCreators?.() || [];
  const names = creators.slice(0, 3).map((c) => c.lastName || c.name).filter(Boolean);
  const authors = names.length ? names.join(', ') + (creators.length > 3 ? ' u. a.' : '') : '';
  const year = String(parent.getField?.('date', true, true) || '').slice(0, 4);
  const head = [authors, /^\d{4}$/.test(year) ? year : ''].filter(Boolean).join(' ');
  return head ? `${head} – ${title}` : title;
}

/**
 * The PDF outline (bookmarks) from an open reader tab for this attachment.
 * Zotero exposes no public API for it; the reader's internal state holds it
 * once the PDF has loaded. Null if no reader is open or the PDF has no outline.
 */
function readerOutline(attachmentID: number): ReaderOutlineItem[] | null {
  try {
    const reader = (Zotero.Reader._readers || []).find((r: any) => r.itemID === attachmentID);
    const outline = reader?._internalReader?._state?.outline;
    return Array.isArray(outline) ? outline : null;
  } catch {
    return null;
  }
}

export class PdfContextProvider implements ContextProvider {
  readonly key: string;

  constructor(private attachment: any) {
    this.key = `pdf:${attachment.id}`;
  }

  describe(): string {
    return describeItem(this.attachment);
  }

  async analyze(budgetChars: number): Promise<FitInfo> {
    return analyzeFit(await getPdfPages(this.attachment), budgetChars);
  }

  async outline(): Promise<Outline> {
    return buildOutline(await getPdfPages(this.attachment), readerOutline(this.attachment.id));
  }

  async build(query: string, budgetChars: number, opts: BuildOptions = {}): Promise<ContextBlock> {
    const pages = await getPdfPages(this.attachment);
    const selection = selectPagesByTerms(pages, buildTerms(query, opts.keywords), budgetChars);
    return {
      title: this.describe(),
      body: formatPages(selection.pages),
      mode: selection.mode,
      includedPages: selection.pages.map((p) => p.pageNumber),
      totalPages: pages.length,
      matchedPages: selection.matchedPages,
      noMatches: selection.noMatches,
    };
  }
}
