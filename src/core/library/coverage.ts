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
}

export interface Coverage {
  standalonePdfs: number;
  excludedBooks: number;
  fullText: boolean;
}

export function readZotSeekSettings(): ZotSeekSettings {
  return {
    excludeBooks: Zotero.Prefs.get('zotseek.excludeBooks', true) !== false,
    fullText: Zotero.Prefs.get('zotseek.indexingMode', true) === 'full',
  };
}

/** Pure counting over top-level items; unit-tested. */
export function countCoverage(
  items: { isPdfAttachment: boolean; isRegular: boolean; itemType: string }[],
  settings: ZotSeekSettings,
): Coverage {
  let standalonePdfs = 0;
  let excludedBooks = 0;
  for (const i of items) {
    if (i.isPdfAttachment) standalonePdfs++;
    else if (i.isRegular && i.itemType === 'book' && settings.excludeBooks) excludedBooks++;
  }
  return { standalonePdfs, excludedBooks, fullText: settings.fullText };
}

/** German hint, or '' if ZotSeek sees everything in the scope. */
export function describeCoverage(c: Coverage): string {
  const parts: string[] = [];
  if (c.standalonePdfs) {
    parts.push(tn('cov.pdfs', c.standalonePdfs));
  }
  if (c.excludedBooks) {
    parts.push(tn('cov.books', c.excludedBooks));
  }
  const hints: string[] = [];
  if (parts.length) hints.push(t('cov.notSearchable', { parts: parts.join(', ') }));
  if (!c.fullText) hints.push(t('cov.abstractOnly'));
  return hints.join(' ');
}

/** Top-level items of a scope (collection and item scopes carry their item IDs; library: all). */
async function topLevelItems(scope: LibraryScope): Promise<any[]> {
  if (scope.itemIDs) return Zotero.Items.get(Array.from(scope.itemIDs));
  return Zotero.Items.getAll(scope.libraryID, true, false);
}

export async function scopeCoverage(scope: LibraryScope): Promise<Coverage> {
  const items = await topLevelItems(scope);
  return countCoverage(
    items.filter((i) => i && !i.deleted && i.isTopLevelItem()).map((i) => ({
      isPdfAttachment: !!i.isPDFAttachment?.(),
      isRegular: !!i.isRegularItem?.(),
      itemType: i.itemType,
    })),
    readZotSeekSettings(),
  );
}
