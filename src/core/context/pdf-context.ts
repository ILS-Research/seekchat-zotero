import { t } from '../../i18n';
import { formatPages } from '../prompt';
import { analyzeFit, type FitInfo } from './fit';
import { buildOutline, type Outline } from './outline';
import { readPdfOutline } from './pdf-outline';
import { logError } from '../../util/log';
import { UserFacingError } from '../errors';
import { buildTerms, selectPagesByTerms, selectRankedPages } from './page-selection';
import type { BuildOptions, ContextBlock, ContextProvider, Page } from './types';

/** Extracted pages per attachment, invalidated when the attachment item changes. */
const pageCache = new Map<number, { version: string; pages: Page[] }>();

export { UserFacingError };

/** Page texts of a PDF attachment via Zotero's PDF worker (form feed = page break). */
export async function getPdfPages(attachment: any): Promise<Page[]> {
  const version = `${attachment.version}:${attachment.dateModified}`;
  const cached = pageCache.get(attachment.id);
  if (cached && cached.version === version) return cached.pages;

  const path = await attachment.getFilePathAsync();
  if (!path) {
    throw new UserFacingError(t('pdf.missingFile'));
  }
  const result = await Zotero.PDFWorker.getFullText(attachment.id, null, true);
  const text: string = result?.text || '';
  const pages = text.split('\f').map((t, i) => ({ pageNumber: i + 1, text: t.trim() }));
  if (!pages.some((p) => p.text)) {
    throw new UserFacingError(t('pdf.noText'));
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
  const title = parent.getField?.('title') || attachment.getField?.('title') || t('common.untitledDoc');
  const creators: any[] = parent.getCreators?.() || [];
  const names = creators.slice(0, 3).map((c) => c.lastName || c.name).filter(Boolean);
  const authors = names.length ? names.join(', ') + (creators.length > 3 ? t('common.etAl') : '') : '';
  const year = String(parent.getField?.('date', true, true) || '').slice(0, 4);
  const head = [authors, /^\d{4}$/.test(year) ? year : ''].filter(Boolean).join(' ');
  return head ? `${head} – ${title}` : title;
}

export class PdfContextProvider implements ContextProvider {
  readonly key: string;

  constructor(readonly attachment: any) {
    this.key = `pdf:${attachment.id}`;
  }

  describe(): string {
    return describeItem(this.attachment);
  }

  metadataLanguage(): string {
    const item = this.attachment.parentItem || this.attachment;
    try {
      return String(item.getField('language') || '');
    } catch {
      // item type without a language field
      return '';
    }
  }

  async sampleText(maxChars: number): Promise<string> {
    const pages = (await getPdfPages(this.attachment)).filter((p) => p.text).slice(0, 3);
    const perPage = Math.floor(maxChars / Math.max(1, pages.length));
    return pages.map((p) => p.text.slice(0, perPage)).join('\n\n');
  }

  async analyze(budgetChars: number): Promise<FitInfo> {
    return analyzeFit(await getPdfPages(this.attachment), budgetChars);
  }

  async outline(): Promise<Outline> {
    const pages = await getPdfPages(this.attachment);
    let bookmarks = null;
    try {
      bookmarks = await readPdfOutline(this.attachment);
    } catch (e) {
      // Fall back to headings / page blocks; the tree says which source it used.
      logError(e);
    }
    return buildOutline(pages, bookmarks);
  }

  async build(query: string, budgetChars: number, opts: BuildOptions = {}): Promise<ContextBlock> {
    const pages = await getPdfPages(this.attachment);
    const allowed = opts.chapters && new Set(opts.chapters.pages);
    const pool = allowed ? pages.filter((p) => allowed.has(p.pageNumber)) : pages;
    const selection = opts.rankedPages
      ? selectRankedPages(pool, opts.rankedPages, budgetChars)
      : selectPagesByTerms(pool, buildTerms(query, opts.keywords), budgetChars);
    return {
      title: this.describe(),
      body: formatPages(selection.pages),
      // Whole chapters are still only part of the document.
      mode: allowed ? 'excerpt' : selection.mode,
      includedPages: selection.pages.map((p) => p.pageNumber),
      totalPages: pages.length,
      matchedPages: selection.matchedPages,
      noMatches: selection.noMatches,
      chapters: opts.chapters && { titles: opts.chapters.titles, complete: selection.mode === 'full' },
    };
  }
}
