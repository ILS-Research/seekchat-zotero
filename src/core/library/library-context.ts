/**
 * Context provider for the library chat: ZotSeek passages as numbered sources.
 *
 * Needs ZotSeek's REST search; without it build() fails with a hint, there is
 * no fallback. ZotSeek filters by library only, so collection and item scopes
 * fetch the maximum number of passages and keep those of the allowed items.
 */
import { analyzeFit, type FitInfo } from '../context/fit';
import type { Outline } from '../context/outline';
import type { BuildOptions, ContextBlock, ContextProvider } from '../context/types';
import { UserFacingError } from '../errors';
import { readPrefs } from '../../prefs';
import { searchPassages, type ZotSeekPassage } from '../zotseek/client';
import { buildSources, formatSources } from './sources';
import { libraryIDOf, libraryKeyOf } from './zotero-items';

/** ZotSeek's upper limit for topK. */
const MAX_TOP_K = 100;

export interface LibraryScope {
  /** Stable part of the session key. */
  key: string;
  /** For meta line and prompt, e.g. "Collection „Stadtklima“". */
  label: string;
  /** ZotSeek library key; omitted = all indexed libraries. */
  libraryKey?: string;
  /** Allowed regular items (IDs); omitted = everything in the library. */
  itemIDs?: Set<number>;
}

function libraryName(libraryID: number): string {
  return Zotero.Libraries.get(libraryID)?.name || 'Bibliothek';
}

/** The regular item behind a selected attachment or note. */
function topLevelID(item: any): number {
  return item.isTopLevelItem?.() === false && item.parentItemID ? item.parentItemID : item.id;
}

export function libraryScope(libraryID: number): LibraryScope {
  const libraryKey = libraryKeyOf(libraryID);
  if (!libraryKey) throw new UserFacingError('Diese Bibliothek kann ZotSeek nicht durchsuchen.');
  return { key: `lib:${libraryKey}`, label: `Bibliothek „${libraryName(libraryID)}“`, libraryKey };
}

/** A collection including its subcollections. */
export function collectionScope(collection: any): LibraryScope {
  const libraryKey = libraryKeyOf(collection.libraryID);
  if (!libraryKey) throw new UserFacingError('Diese Bibliothek kann ZotSeek nicht durchsuchen.');
  const itemIDs = new Set<number>();
  const collect = (c: any) => {
    for (const item of c.getChildItems(false)) itemIDs.add(topLevelID(item));
    for (const child of c.getChildCollections(false)) collect(child);
  };
  collect(collection);
  return { key: `col:${collection.libraryID}:${collection.key}`, label: `Collection „${collection.name}“`, libraryKey, itemIDs };
}

export function itemsScope(items: any[]): LibraryScope {
  if (!items.length) throw new UserFacingError('Keine Einträge ausgewählt.');
  const libraryKey = libraryKeyOf(items[0].libraryID);
  if (!libraryKey) throw new UserFacingError('Diese Bibliothek kann ZotSeek nicht durchsuchen.');
  if (items.some((i) => i.libraryID !== items[0].libraryID)) {
    throw new UserFacingError('Die ausgewählten Einträge liegen in verschiedenen Bibliotheken.');
  }
  const itemIDs = new Set(items.map(topLevelID));
  const ids = Array.from(itemIDs).sort((a, b) => a - b);
  return {
    key: `items:${ids.join(',')}`,
    label: `${itemIDs.size} ausgewählte${itemIDs.size === 1 ? 'r Eintrag' : ' Einträge'}`,
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

  async build(query: string, budgetChars: number, _opts: BuildOptions = {}): Promise<ContextBlock> {
    const topK = this.scope.itemIDs ? MAX_TOP_K : readPrefs().libraryTopK;
    const passages = filterPassages(await searchPassages(query, { topK, libraryKey: this.scope.libraryKey }), this.scope);
    const set = buildSources(passages, budgetChars);
    if (!set.sources.length) {
      throw new UserFacingError(set.withoutText
        ? `ZotSeek fand in ${this.scope.label} nur Treffer ohne Textauszug. Ist der Indexierungsmodus auf „full“ gestellt?`
        : `ZotSeek fand in ${this.scope.label} keine passenden Textstellen.`);
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
