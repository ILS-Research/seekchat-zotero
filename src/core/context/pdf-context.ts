import { t } from '../../i18n';
import { formatPages } from '../prompt';
import { analyzeFit, type FitInfo } from './fit';
import { buildOutline, type Outline } from './outline';
import { readPageLabels, readPdfOutline } from './pdf-outline';
import { content, logError, logger } from '../../util/log';
import { UserFacingError } from '../errors';
import { stripRunningLines } from './clean';
import { buildTerms, selectPagesByTerms, selectRankedPages } from './page-selection';
import { LruMap } from '../../util/lru';
import type { BuildOptions, ContextBlock, ContextProvider, Page } from './types';

/**
 * Extracted pages per attachment, invalidated when the attachment item changes. The 100 most recently used PDFs
 * (a 1000-page book is a few MB of text).
 */
const pageCache = new LruMap<number, { version: string; pages: Page[] }>(100);

export { UserFacingError };

/** Page texts of a PDF attachment via Zotero's PDF worker (form feed = page break). */
const L = logger('PDF');
/** Pages on each side of the page open in the reader that always go along. */
export const CURRENT_PAGE_SPAN = 2;

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
  const raw = text.split('\f').map((t, i) => ({ pageNumber: i + 1, text: t.trim() }));
  if (!raw.some((p) => p.text)) {
    throw new UserFacingError(t('pdf.noText'));
  }
  // Running headers/footers out (they cost budget on every page and hide headings).
  const { pages, removed } = stripRunningLines(raw);
  if (removed.length) L.info(`${attachment.key}: removed ${removed.length} running lines: ${content(removed.join(' | '), 300)}`);
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
    // Budget left for the pages after the notes the user added as context.
    const notes = opts.notes || [];
    budgetChars = Math.max(2000, budgetChars - notes.reduce((n, x) => n + x.text.length + x.title.length + 20, 0));
    // The page open in the reader and two on each side always go along (they are what the user looks at).
    const around = opts.currentPage ? pages.filter((p) => Math.abs(p.pageNumber - opts.currentPage!) <= CURRENT_PAGE_SPAN && p.text) : [];
    const aroundChars = around.reduce((n, p) => n + p.text.length, 0);
    const aroundSet = new Set(around.map((p) => p.pageNumber));
    const rest = around.length ? pool.filter((p) => !aroundSet.has(p.pageNumber)) : pool;
    const restBudget = Math.max(0, budgetChars - aroundChars);
    let selection = opts.rankedPages
      ? selectRankedPages(rest, opts.rankedPages, restBudget)
      : selectPagesByTerms(rest, buildTerms(query, opts.keywords), restBudget);
    if (around.length) {
      const merged = [...around, ...selection.pages].sort((a, b) => a.pageNumber - b.pageNumber);
      // Everything fits anyway: keep "full"; else it is an excerpt.
      const full = selection.mode === 'full' && rest.length + around.length === pages.filter((p) => p.text).length;
      selection = { ...selection, pages: merged, mode: full ? 'full' : 'excerpt' };
    }
    return {
      title: this.describe(),
      body: formatPages(selection.pages, await pageLabelsOf(this.attachment)),
      notes: notes.length ? notes : undefined,
      currentPage: opts.currentPage,
      aroundPages: around.map((p) => p.pageNumber),
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

const labelCache = new LruMap<number, { version: string; labels: (string | null)[] | null }>(500);

/** Printed page labels of a PDF (null if it defines none or they cannot be read), cached per version. */
export async function pageLabelsOf(attachment: any): Promise<(string | null)[] | null> {
  const version = `${attachment.version}:${attachment.dateModified}`;
  const hit = labelCache.get(attachment.id);
  if (hit && hit.version === version) return hit.labels;
  let labels: (string | null)[] | null = null;
  try {
    labels = await readPageLabels(attachment);
  } catch (e: any) {
    L.info(`page labels of ${attachment.key}: ${e?.message || e}`);
  }
  labelCache.set(attachment.id, { version, labels });
  return labels;
}

/**
 * Page (1-based) the user has open in a reader tab of this PDF, preferring the selected tab; null if it is not open.
 * The reader's live view state first, else the page Zotero stored for the attachment.
 */
export function currentReaderPage(attachment: any): number | null {
  try {
    const win = Zotero.getMainWindow();
    const readers: any[] = (Zotero.Reader as any)._readers || [];
    const selected = Zotero.Reader.getByTabID(win?.Zotero_Tabs?.selectedID);
    const reader = selected?.itemID === attachment.id ? selected : readers.find((r) => r?.itemID === attachment.id);
    if (!reader) return null;
    const live = reader._internalReader?._state?.primaryViewStats?.pageIndex;
    const index = typeof live === 'number' ? live : attachment.getAttachmentLastPageIndex?.();
    return typeof index === 'number' && index >= 0 ? index + 1 : null;
  } catch {
    return null;
  }
}
