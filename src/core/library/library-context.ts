/**
 * Context provider for the library chat: ZotSeek passages as numbered sources.
 *
 * Needs ZotSeek's REST search; without it build() fails with a hint, there is
 * no fallback. ZotSeek filters by library only, so collection and item scopes
 * fetch the maximum number of passages and keep those of the allowed items.
 */
import { t, tn } from '../../i18n';
import { analyzeFit, type FitInfo } from '../context/fit';
import type { Outline } from '../context/outline';
import type { BuildOptions, ContextBlock, ContextProvider } from '../context/types';
import { UserFacingError } from '../errors';
import { readPrefs } from '../../prefs';
import { searchPassages, type ZotSeekPassage } from '../zotseek/client';
import { searchBooks } from '../seekbook/client';
import { buildSources, formatSources, fromSeekBook, fromZotSeek, interleave, type Evidence } from './sources';
import { libraryIDOf, libraryKeyOf } from './zotero-items';

/** ZotSeek's upper limit for topK. */
const MAX_TOP_K = 100;

export interface LibraryScope {
  /** Stable part of the session key. */
  key: string;
  /** For meta line and prompt, e.g. "Collection „Stadtklima“". */
  label: string;
  /** Zotero library the scope lies in. */
  libraryID: number;
  /** ZotSeek library key; omitted = all indexed libraries. */
  libraryKey?: string;
  /** Collection scope: the collection's ID (a saved chat note goes there). */
  collectionID?: number;
  /** Allowed regular items (IDs); omitted = everything in the library. */
  itemIDs?: Set<number>;
}

function libraryName(libraryID: number): string {
  return Zotero.Libraries.get(libraryID)?.name || t('lib.libraryDefault');
}

/** The regular item behind a selected attachment or note. */
function topLevelID(item: any): number {
  return item.isTopLevelItem?.() === false && item.parentItemID ? item.parentItemID : item.id;
}

export function libraryScope(libraryID: number): LibraryScope {
  const libraryKey = libraryKeyOf(libraryID);
  if (!libraryKey) throw new UserFacingError(t('error.librarySearch'));
  return { key: `lib:${libraryKey}`, label: t('lib.library', { name: libraryName(libraryID) }), libraryID, libraryKey };
}

/** A collection including its subcollections. */
export function collectionScope(collection: any): LibraryScope {
  const libraryKey = libraryKeyOf(collection.libraryID);
  if (!libraryKey) throw new UserFacingError(t('error.librarySearch'));
  const itemIDs = new Set<number>();
  const collect = (c: any) => {
    for (const item of c.getChildItems(false)) itemIDs.add(topLevelID(item));
    for (const child of c.getChildCollections(false)) collect(child);
  };
  collect(collection);
  return { key: `col:${collection.libraryID}:${collection.key}`, label: t('lib.collection', { name: collection.name }), libraryID: collection.libraryID, collectionID: collection.id, libraryKey, itemIDs };
}

export function itemsScope(items: any[]): LibraryScope {
  if (!items.length) throw new UserFacingError(t('error.noItems'));
  const libraryKey = libraryKeyOf(items[0].libraryID);
  if (!libraryKey) throw new UserFacingError(t('error.librarySearch'));
  if (items.some((i) => i.libraryID !== items[0].libraryID)) {
    throw new UserFacingError(t('error.mixedLibraries'));
  }
  const itemIDs = new Set(items.map(topLevelID));
  const ids = Array.from(itemIDs).sort((a, b) => a - b);
  return {
    key: `items:${ids.join(',')}`,
    label: tn('lib.items', itemIDs.size),
    libraryID: items[0].libraryID,
    libraryKey,
    itemIDs,
  };
}

/** Keeps passages of allowed items (the whole scope if it has no item list). */
export function filterPassages(passages: ZotSeekPassage[], scope: LibraryScope): ZotSeekPassage[] {
  if (!scope.itemIDs) return passages;
  return passages.filter((p) => {
    const libraryID = libraryIDOf(p.libraryKey);
    if (libraryID === null) return false;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, p.itemKey);
    return !!item && scope.itemIDs!.has(topLevelID(item));
  });
}

export class LibraryContextProvider implements ContextProvider {
  readonly key: string;

  constructor(readonly scope: LibraryScope) {
    this.key = `library:${scope.key}`;
  }

  describe(): string {
    return this.scope.label;
  }

  /** Always "fits": the library chat selects passages itself, long-document strategies do not apply. */
  async analyze(budgetChars: number): Promise<FitInfo> {
    return analyzeFit([], budgetChars);
  }

  metadataLanguage(): string {
    return '';
  }

  async sampleText(): Promise<string> {
    return '';
  }

  async outline(): Promise<Outline> {
    return { source: 'blocks', nodes: [] };
  }

  /**
   * ZotSeek passages for one or more queries (in the scope), as evidence. Several
   * queries are interleaved by rank, so each aspect of the question gets its best hits.
   */
  async searchEvidence(queries: string[], signal?: AbortSignal, topKLimit?: number): Promise<Evidence[]> {
    // Item and collection scopes filter afterwards, so they fetch the maximum; the limit is applied after filtering.
    const wanted = topKLimit ?? readPrefs().libraryTopK;
    const topK = this.scope.itemIDs ? MAX_TOP_K : wanted;
    const lists: Evidence[][] = [];
    for (const q of queries) {
      const passages = await searchPassages(q, { topK, libraryKey: this.scope.libraryKey, signal });
      lists.push(filterPassages(passages, this.scope).slice(0, wanted).map(fromZotSeek));
    }
    return interleave(...lists);
  }

  /**
   * SeekBook passages (own book index) for the queries, interleaved by rank.
   * `itemKeys`: only these books (a collection or selection); omitted = the whole library.
   */
  async searchBookIndex(queries: string[], itemKeys: string[] | undefined, signal?: AbortSignal, topK?: number): Promise<Evidence[]> {
    if (itemKeys && !itemKeys.length) return [];
    const libraryID = this.scope.libraryID;
    const lists: Evidence[][] = [];
    for (const q of queries) {
      const passages = await searchBooks(q, { topK: topK ?? readPrefs().libraryTopK, libraryKey: this.scope.libraryKey, itemKeys, signal });
      lists.push(passages.map((p) => {
        const att = p.attachmentKey ? Zotero.Items.getByLibraryAndKey(libraryID, p.attachmentKey) : null;
        return fromSeekBook(p, att ? att.id : undefined);
      }));
    }
    return interleave(...lists);
  }

  /** 7e-2: ZotSeek passages of one item only (the scope's library, filtered by item). */
  async searchInItem(query: string, item: { itemKey: string; libraryKey: string | null }, signal?: AbortSignal): Promise<Evidence[]> {
    const passages = await searchPassages(query, { topK: MAX_TOP_K, libraryKey: item.libraryKey ?? this.scope.libraryKey, signal });
    return passages.filter((p) => p.itemKey === item.itemKey).map(fromZotSeek);
  }

  /** 7e-2: a regular item of the scope whose title or creators contain all words of `name`. */
  findItem(name: string): any | null {
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return null;
    const items: any[] = this.scope.itemIDs
      ? Zotero.Items.get(Array.from(this.scope.itemIDs))
      : Zotero.Items.getAll(this.scope.libraryID, true, false);
    let best: any = null;
    for (const item of items) {
      if (!item || item.deleted || !item.isRegularItem?.()) continue;
      const creators = (item.getCreators?.() || []).map((c: any) => c.lastName || c.name || '').join(' ');
      const hay = `${item.getField?.('title') || ''} ${creators} ${item.getField?.('date', true, true)?.slice(0, 4) || ''}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) {
        best = item;
        break;
      }
    }
    return best;
  }

  /** ZotSeek alone, one query (the library chat itself goes through ChatSession's pipeline). */
  async build(query: string, budgetChars: number, _opts: BuildOptions = {}): Promise<ContextBlock> {
    const set = buildSources(await this.searchEvidence([query]), budgetChars);
    if (!set.sources.length) {
      throw new UserFacingError(set.withoutText
        ? t('error.onlyNoText', { scope: this.scope.label })
        : t('error.noPassages', { scope: this.scope.label }));
    }
    return {
      title: this.scope.label,
      body: formatSources(set.sources),
      mode: 'excerpt',
      includedPages: [],
      totalPages: 0,
      library: {
        sources: set.sources,
        scope: this.scope.label,
        passagesUsed: set.passagesUsed,
        withoutText: set.withoutText,
        overBudget: set.overBudget,
      },
    };
  }
}
