/**
 * Zotero side of the library tools: item summaries, Zotero's own search, ZotSeek and SeekBook passage searches
 * (through their clients; never assumed present), item details, the current selection, collections and tags.
 * Everything read-only.
 */
import { docKind } from '../../context/document';
import { noteText } from '../../context/notes';
import { libraryKeyOf } from '../../library/zotero-items';
import { readZotSeekSettings, zotseekBookMode } from '../../library/coverage';
import { getZotSeekStatus, searchPassages } from '../../zotseek/client';
import { getSeekBookStatus, searchBooks } from '../../seekbook/client';
import { logger } from '../../../util/log';
import {
  clampLimit, collectionPaths, countTags, cut, inYearRange, itemLabel, mergeHits, MAX_COLLECTIONS_PER_ITEM,
  MAX_TAGS_PER_ITEM, stringArg, yearOf, findCollection,
  type CollectionNode, type ItemSummary, type MergedHit, type SourceHit, type SourceID, type SourceStatus,
} from './summary';

const L = logger('Library');

export function itemByKey(libraryID: number, key: string): any | null {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, String(key || '').trim());
  return item && !item.deleted ? item : null;
}

/** The regular item a hit stands for (attachments and notes count for their parent). */
function topItem(item: any): any | null {
  if (!item || item.deleted) return null;
  if (item.isRegularItem?.()) return item;
  const parent = item.parentItem;
  return parent?.isRegularItem?.() && !parent.deleted ? parent : null;
}

function names(item: any): string[] {
  const creators: any[] = item.getCreators?.() || [];
  const authors = creators.filter((c) => Zotero.CreatorTypes.getName(c.creatorTypeID) !== 'editor');
  return (authors.length ? authors : creators).map((c) => c.lastName || c.name).filter(Boolean);
}

function field(item: any, name: string): string {
  try {
    return String(item.getField(name, false, true) || '');
  } catch {
    return '';
  }
}

export function summarize(item: any): ItemSummary {
  const year = yearOf(field(item, 'date'));
  const venue = field(item, 'publicationTitle') || field(item, 'bookTitle') || field(item, 'proceedingsTitle')
    || field(item, 'websiteTitle') || field(item, 'publisher') || field(item, 'institution') || field(item, 'university');
  const atts = Zotero.Items.get(item.getAttachments?.() || []).filter((a: any) => a && !a.deleted);
  const files = [...new Set(atts.map((a: any) => docKind(a)).filter(Boolean))] as string[];
  const collections = Zotero.Collections.get(item.getCollections?.() || []).map((c: any) => c.name);
  return {
    key: item.key,
    type: item.itemType,
    label: itemLabel(names(item), year, field(item, 'title')),
    year,
    venue: venue || undefined,
    files,
    tags: (item.getTags?.() || []).map((t: any) => t.tag).slice(0, MAX_TAGS_PER_ITEM),
    collections: collections.slice(0, MAX_COLLECTIONS_PER_ITEM),
  };
}

export interface SearchArgs {
  query?: string;
  author?: string;
  title?: string;
  year_from?: number;
  year_to?: number;
  item_type?: string;
  tags?: string[] | string;
  collection?: string;
  has_pdf?: boolean;
  fulltext?: boolean;
  added_after?: string;
  sources?: string[] | string;
  limit?: number;
}

export interface SearchSettings {
  zotseek: boolean;
  seekbook: boolean;
}

export interface SearchOutcome {
  scope: string;
  status: Record<SourceID, SourceStatus>;
  total: number;
  hits: (MergedHit & { item: any })[];
}

/** All collections of a library as nodes (for paths and lookups). */
export function collectionNodes(libraryID: number): CollectionNode[] {
  return Zotero.Collections.getByLibrary(libraryID, true).filter((c: any) => !c.deleted).map((c: any) => ({
    key: c.key,
    name: c.name,
    parentKey: c.parentKey || undefined,
    items: c.getChildItems(true, false).length,
  }));
}

/** IDs of the items in a collection and its subcollections. */
function collectionItemIDs(libraryID: number, key: string): Set<number> {
  const root = Zotero.Collections.getByLibraryAndKey(libraryID, key);
  const all = [root, ...root.getDescendents(false, 'collection').map((d: any) => Zotero.Collections.get(d.id))];
  return new Set<number>(all.flatMap((c: any) => c.getChildItems(true, false)));
}

/** Zotero's search with the conditions of the arguments; results are top-level regular items (keys). */
async function zoteroSearch(libraryID: number, args: SearchArgs, collectionKey?: string): Promise<string[]> {
  const s = new Zotero.Search();
  s.libraryID = libraryID;
  s.addCondition('deleted', 'false');
  if (args.query?.trim()) s.addCondition(args.fulltext ? 'quicksearch-everything' : 'quicksearch-titleCreatorYear', 'contains', args.query.trim());
  if (args.author?.trim()) s.addCondition('creator', 'contains', args.author.trim());
  if (args.title?.trim()) s.addCondition('title', 'contains', args.title.trim());
  if (args.item_type?.trim()) s.addCondition('itemType', 'is', args.item_type.trim());
  for (const tag of stringArg(args.tags)) s.addCondition('tag', 'is', tag);
  if (collectionKey) {
    s.addCondition('collection', 'is', collectionKey);
    s.addCondition('recursive', 'true');
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(String(args.added_after || ''))) s.addCondition('dateAdded', 'isAfter', String(args.added_after).slice(0, 10));
  const ids: number[] = await s.search();
  const keys: string[] = [];
  for (const item of await Zotero.Items.getAsync(ids)) {
    const top = topItem(item);
    if (top && !keys.includes(top.key)) keys.push(top.key);
  }
  return keys;
}

/** Hits of a passage search: items in this library, with an excerpt and where it is. */
function passageHits(passages: any[], libraryKey: string | null, source: SourceID, pageWord: string): SourceHit[] {
  return passages
    .filter((p) => !p.libraryKey || p.libraryKey === libraryKey)
    .map((p) => ({
      key: p.itemKey,
      source,
      excerpt: p.text,
      where: [p.chapter, p.page ? `${pageWord} ${p.pageLabel || p.page}` : ''].filter(Boolean).join(', ') || undefined,
    }));
}

/**
 * Searches the library with Zotero's own search and – when switched on, installed and a free-text query is given –
 * ZotSeek and SeekBook; filters (year, type, tags, collection, PDF) apply to all hits; joined per item.
 */
export async function searchLibrary(libraryID: number, args: SearchArgs, settings: SearchSettings, pageWord: string, signal: AbortSignal): Promise<SearchOutcome> {
  const limit = clampLimit(args.limit);
  const wanted = stringArg(args.sources).map((s) => s.toLowerCase());
  const allowed = (s: SourceID) => !wanted.length || wanted.includes(s);
  const libName = Zotero.Libraries.getName(libraryID);
  let collection: { key: string; path: string } | undefined;
  if (args.collection) collection = findCollection(collectionPaths(collectionNodes(libraryID), 10000), args.collection);
  const scope = collection ? `${libName} / ${collection.path}` : libName;
  const query = String(args.query || '').trim();
  const status: Record<SourceID, SourceStatus> = { zotero: 0, zotseek: 'off', seekbook: 'off' };
  const lists: SourceHit[][] = [];
  const libraryKey = libraryKeyOf(libraryID);
  const topK = Math.min(60, limit * 3);

  const tasks: Promise<void>[] = [];
  if (settings.zotseek && allowed('zotseek')) {
    tasks.push((async () => {
      if (!query) { status.zotseek = 'skipped'; return; }
      const st = await getZotSeekStatus(signal);
      if (!st.available) { status.zotseek = st.reason === 'not-installed' ? 'missing' : { error: st.message }; return; }
      try {
        const hits = passageHits(await searchPassages(query, { topK, libraryKey: libraryKey || undefined, signal }), libraryKey, 'zotseek', pageWord);
        lists[1] = hits;
        status.zotseek = hits.length;
      } catch (e: any) {
        if (signal.aborted) throw e;
        status.zotseek = { error: String(e?.message || e) };
      }
    })());
  }
  if (settings.seekbook && allowed('seekbook')) {
    tasks.push((async () => {
      if (!query) { status.seekbook = 'skipped'; return; }
      const st = await getSeekBookStatus(signal);
      if (!st.available) { status.seekbook = st.reason === 'not-installed' ? 'missing' : { error: st.message }; return; }
      // ZotSeek that already brings SeekBook's passages: asking SeekBook too only repeats them.
      const viaZotSeek = settings.zotseek && allowed('zotseek') && !!(Zotero as any).ZotSeek
        && zotseekBookMode(readZotSeekSettings(), true) === 'seekbook';
      if (viaZotSeek) { status.seekbook = 'skipped'; return; }
      try {
        const hits = passageHits(await searchBooks(query, { topK, libraryKey: libraryKey || undefined, signal }), libraryKey, 'seekbook', pageWord);
        lists[2] = hits;
        status.seekbook = hits.length;
      } catch (e: any) {
        if (signal.aborted) throw e;
        status.seekbook = { error: String(e?.message || e) };
      }
    })());
  }
  if (allowed('zotero') || !tasks.length) {
    tasks.push((async () => {
      const keys = await zoteroSearch(libraryID, args, collection?.key);
      lists[0] = keys.map((key) => ({ key, source: 'zotero' as const }));
      status.zotero = keys.length;
    })());
  } else {
    status.zotero = 'skipped';
  }
  await Promise.all(tasks);

  // Zotero's own search applied the conditions already; ZotSeek and SeekBook know nothing of years, types,
  // tags or collections, so their hits are filtered here. Year range and "has PDF" apply to all.
  const inCollection = collection ? collectionItemIDs(libraryID, collection.key) : null;
  const tags = stringArg(args.tags);
  const author = String(args.author || '').toLowerCase().trim();
  const hasPdf = (item: any) => Zotero.Items.get(item.getAttachments()).some((a: any) => a?.isPDFAttachment?.() && !a.deleted);
  const merged = mergeHits(lists.filter(Boolean)).map((m) => ({ ...m, item: itemByKey(libraryID, m.key) }))
    .filter(({ item, sources }) => {
      if (!item?.isRegularItem?.()) return false;
      if (!inYearRange(yearOf(field(item, 'date')), args.year_from, args.year_to)) return false;
      if (args.has_pdf && !hasPdf(item)) return false;
      if (sources.includes('zotero')) return true;
      if (args.item_type && item.itemType !== args.item_type) return false;
      if (inCollection && !inCollection.has(item.id)) return false;
      const own = new Set((item.getTags() || []).map((t: any) => t.tag));
      if (tags.some((t) => !own.has(t))) return false;
      if (author && !names(item).some((n) => n.toLowerCase().includes(author))) return false;
      if (args.title && !field(item, 'title').toLowerCase().includes(String(args.title).toLowerCase())) return false;
      return true;
    });
  L.info(`search in ${scope}: zotero ${status.zotero}, zotseek ${JSON.stringify(status.zotseek)}, seekbook ${JSON.stringify(status.seekbook)} → ${merged.length}`);
  return { scope, status, total: merged.length, hits: merged.slice(0, limit) };
}

export type ItemPart = 'fields' | 'abstract' | 'notes' | 'attachments' | 'tags' | 'collections' | 'related';
export const DEFAULT_PARTS: ItemPart[] = ['fields', 'abstract', 'tags'];
const ABSTRACT_CHARS = 2000;
const NOTE_CHARS = 1500;
const MAX_NOTES = 5;

/** One item in detail, as far as asked (`parts`); long texts cut. */
export async function itemDetails(item: any, parts: ItemPart[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { key: item.key, type: item.itemType, label: summarize(item).label };
  if (parts.includes('fields')) {
    const fields: Record<string, string> = {};
    for (const id of Zotero.ItemFields.getItemTypeFields(item.itemTypeID)) {
      const name = Zotero.ItemFields.getName(id);
      if (name === 'abstractNote') continue;
      const v = field(item, name);
      if (v) fields[name] = cut(v, 500);
    }
    out.fields = fields;
    out.creators = (item.getCreators() || []).map((c: any) => ({
      role: Zotero.CreatorTypes.getName(c.creatorTypeID),
      name: c.name || [c.lastName, c.firstName].filter(Boolean).join(', '),
    }));
    out.dateAdded = String(item.dateAdded || '').slice(0, 10);
  }
  if (parts.includes('abstract')) {
    const a = field(item, 'abstractNote');
    if (a) out.abstract = cut(a, ABSTRACT_CHARS);
  }
  if (parts.includes('notes')) {
    const notes = Zotero.Items.get(item.getNotes()).filter((n: any) => n && !n.deleted);
    out.notes = notes.slice(0, MAX_NOTES).map((n: any) => ({ title: n.getNoteTitle(), text: cut(noteText(n.getNote()), NOTE_CHARS) }));
    if (notes.length > MAX_NOTES) out.moreNotes = notes.length - MAX_NOTES;
  }
  if (parts.includes('attachments')) {
    const atts = Zotero.Items.get(item.getAttachments()).filter((a: any) => a && !a.deleted);
    out.attachments = await Promise.all(atts.map(async (a: any) => ({
      key: a.key,
      title: field(a, 'title'),
      kind: docKind(a) || a.attachmentContentType || 'link',
      file: a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL ? 'link only' : (await a.fileExists().catch(() => false)) ? 'present' : 'missing',
    })));
  }
  if (parts.includes('tags')) out.tags = (item.getTags() || []).map((t: any) => t.tag);
  if (parts.includes('collections')) {
    const paths = collectionPaths(collectionNodes(item.libraryID), 10000);
    out.collections = Zotero.Collections.get(item.getCollections()).map((c: any) => paths.find((p) => p.key === c.key)?.path || c.name);
  }
  if (parts.includes('related')) {
    out.related = (item.relatedItems || []).map((key: string) => itemByKey(item.libraryID, key)).filter(Boolean)
      .map((r: any) => ({ key: r.key, label: summarize(r).label }));
  }
  return out;
}

const MAX_SELECTED = 50;

/** What the user has selected in Zotero: items, collection or library, and in the reader the open document and marked text. */
export function currentSelection(): Record<string, unknown> {
  const win = Zotero.getMainWindow();
  const pane = win?.ZoteroPane;
  const out: Record<string, unknown> = {};
  const tabType = win?.Zotero_Tabs?.selectedType;
  if (tabType === 'reader') {
    const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    const att = reader && Zotero.Items.get(reader.itemID);
    if (att) {
      const top = topItem(att);
      out.reader = { attachmentKey: att.key, kind: docKind(att), item: top ? summarize(top) : undefined, selectedText: readerSelection(reader) };
    }
  }
  const items: any[] = (pane?.getSelectedItems?.() || []).map(topItem).filter(Boolean);
  const unique = [...new Map(items.map((i) => [i.id, i])).values()];
  out.selectedItems = unique.slice(0, MAX_SELECTED).map(summarize);
  if (unique.length > MAX_SELECTED) out.moreSelected = unique.length - MAX_SELECTED;
  const collection = pane?.getSelectedCollection?.();
  const libraryID = pane?.getSelectedLibraryID?.();
  if (collection) {
    const paths = collectionPaths(collectionNodes(collection.libraryID), 10000);
    out.collection = { key: collection.key, path: paths.find((p) => p.key === collection.key)?.path || collection.name };
  }
  if (libraryID) out.library = Zotero.Libraries.getName(libraryID);
  return out;
}

/** Text marked in a reader tab (PDF, EPUB, web page); best effort across Zotero versions. */
function readerSelection(reader: any): string | undefined {
  try {
    const views = [reader?._internalReader?._primaryView, reader?._internalReader?._lastView].filter(Boolean);
    for (const v of views) {
      const text = v?._iframeWindow?.getSelection?.()?.toString?.()
        || v?._iframe?.contentWindow?.getSelection?.()?.toString?.();
      if (text?.trim()) return cut(text, 3000);
    }
    const text = reader?._iframeWindow?.getSelection?.()?.toString?.();
    return text?.trim() ? cut(text, 3000) : undefined;
  } catch {
    return undefined;
  }
}

/** Collections of a library as paths; `parent` (key, path or name) limits to its subtree. */
export function listCollections(libraryID: number, parent?: string): { key: string; path: string; items: number; subcollections: number }[] {
  const all = collectionPaths(collectionNodes(libraryID), 10000);
  if (!parent) return all.slice(0, 200);
  const root = findCollection(all, parent);
  return all.filter((p) => p.key === root.key || p.path.startsWith(`${root.path} / `)).slice(0, 200);
}

/** Tags in a library or collection with the number of items carrying them, and their colour if set. */
export async function listTags(libraryID: number, collection?: string, filter?: string, limit = 100): Promise<{ scope: string; tags: { tag: string; items: number; color?: string }[] }> {
  let items: any[];
  let scope = Zotero.Libraries.getName(libraryID);
  if (collection) {
    const c = findCollection(collectionPaths(collectionNodes(libraryID), 10000), collection);
    items = Zotero.Collections.getByLibraryAndKey(libraryID, c.key).getChildItems(false, false);
    scope += ` / ${c.path}`;
  } else {
    items = (await Zotero.Items.getAll(libraryID, true, false)).filter((i: any) => i.isRegularItem());
  }
  const colors: Map<string, { color: string }> = Zotero.Tags.getColors(libraryID);
  const tags = countTags(items.map((i: any) => (i.getTags() || []).map((t: any) => t.tag)), filter, clampLimit(limit, 100, 300))
    .map((t) => ({ ...t, ...(colors.get(t.tag) ? { color: colors.get(t.tag)!.color } : {}) }));
  return { scope, tags };
}
