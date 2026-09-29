/**
 * What ZotSeek cannot see in a scope, derived from Zotero and ZotSeek's own
 * settings (ZotSeek's API does not say per item whether it is indexed):
 * PDFs without a parent item are never indexed, books only when ZotSeek's
 * "exclude books" is off, PDF contents only in indexing mode "full".
 * ZotSeek reads its prefs globally ("zotseek.*", not "extensions.zotero.zotseek.*").
 */
import { t, tn } from '../../i18n';
import type { LibraryScope } from './library-context';

export interface ZotSeekSettings {
  excludeBooks: boolean;
  fullText: boolean;
  /** ZotSeek (ILS fork) mixes in book passages from SeekBook ("Include book results from SeekBook"). */
  includeSeekBook?: boolean;
}

/**
 * How ZotSeek treats books: not at all, in its own index, or through SeekBook.
 * ZotSeek only uses SeekBook while SeekBook is ready; then that wins over its own books.
 */
export type ZotSeekBookMode = 'excluded' | 'native' | 'seekbook';

export function zotseekBookMode(s: ZotSeekSettings, seekBookReady: boolean): ZotSeekBookMode {
  if (s.includeSeekBook && seekBookReady) return 'seekbook';
  return s.excludeBooks ? 'excluded' : 'native';
}

export interface Coverage {
  standalonePdfs: number;
  /** Top-level regular items that are not books. */
  papers: number;
  books: number;
  /** Books ZotSeek does not see (bookMode 'excluded'). */
  excludedBooks: number;
  fullText: boolean;
  bookMode: ZotSeekBookMode;
}

export function readZotSeekSettings(): ZotSeekSettings {
  return {
    excludeBooks: Zotero.Prefs.get('zotseek.excludeBooks', true) !== false,
    fullText: Zotero.Prefs.get('zotseek.indexingMode', true) === 'full',
    includeSeekBook: Zotero.Prefs.get('zotseek.includeSeekBook', true) === true,
  };
}

/** ZotSeek prefs that change what it covers (watched by the library window). */
export const ZOTSEEK_COVERAGE_PREFS = ['zotseek.excludeBooks', 'zotseek.indexingMode', 'zotseek.includeSeekBook'];

/** Pure counting over top-level items; unit-tested. */
export function countCoverage(
  items: { isPdfAttachment: boolean; isRegular: boolean; itemType: string }[],
  settings: ZotSeekSettings,
  seekBookReady = false,
): Coverage {
  const bookMode = zotseekBookMode(settings, seekBookReady);
  let standalonePdfs = 0;
  let papers = 0;
  let books = 0;
  for (const i of items) {
    if (i.isPdfAttachment) standalonePdfs++;
    else if (i.isRegular && i.itemType === 'book') books++;
    else if (i.isRegular) papers++;
  }
  return { standalonePdfs, papers, books, excludedBooks: bookMode === 'excluded' ? books : 0, fullText: settings.fullText, bookMode };
}

/** What ZotSeek searches in the scope, then what it cannot see (German/English per UI). */
export function describeCoverage(c: Coverage): string {
  const hints: string[] = [];
  const searched = c.papers + (c.bookMode === 'excluded' ? 0 : c.books);
  hints.push(tn('cov.searches', searched));
  if (c.books && c.bookMode === 'native') hints.push(tn('cov.booksNative', c.books));
  if (c.books && c.bookMode === 'seekbook') hints.push(tn('cov.booksSeekBook', c.books));
  const parts: string[] = [];
  if (c.standalonePdfs) parts.push(tn('cov.pdfs', c.standalonePdfs));
  if (c.excludedBooks) parts.push(tn('cov.books', c.excludedBooks));
  if (parts.length) hints.push(t('cov.notSearchable', { parts: parts.join(', ') }));
  if (!c.fullText) hints.push(t('cov.abstractOnly'));
  return hints.join(' ');
}

/** Top-level items of a scope (collection and item scopes carry their item IDs; library: all). */
async function topLevelItems(scope: LibraryScope): Promise<any[]> {
  if (scope.itemIDs) return Zotero.Items.get(Array.from(scope.itemIDs));
  return Zotero.Items.getAll(scope.libraryID, true, false);
}

export async function scopeCoverage(scope: LibraryScope, seekBookReady = false): Promise<Coverage> {
  const items = await topLevelItems(scope);
  return countCoverage(
    items.filter((i) => i && !i.deleted && i.isTopLevelItem()).map((i) => ({
      isPdfAttachment: !!i.isPDFAttachment?.(),
      isRegular: !!i.isRegularItem?.(),
      itemType: i.itemType,
    })),
    readZotSeekSettings(),
    seekBookReady,
  );
}
