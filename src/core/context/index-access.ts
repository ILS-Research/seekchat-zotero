/**
 * Long-document strategy "semantic search" in the PDF chat, without an index of
 * SeekChat's own: a book PDF is searched in SeekBook, any other PDF in ZotSeek.
 * The hits pick the pages; the answer then sees whole pages as with the other
 * strategies (citations stay [S. N]).
 *
 * SeekBook has a JS API for "is it indexed" and "index it". ZotSeek has none for
 * single items: its plugin object (`Zotero.ZotSeek`) is used carefully, and when
 * those internals are missing the user gets a hint instead of a button.
 */
import { libraryKeyOf } from '../library/zotero-items';
import { diagnose as diagnoseSeekBook, readEnvironment as readSeekBookEnv, searchBooks } from '../seekbook/client';
import { diagnose as diagnoseZotSeek, readEnvironment as readZotSeekEnv, searchPassages } from '../zotseek/client';
import { logger } from '../../util/log';

const L = logger('IndexAccess');

export type IndexKind = 'seekbook' | 'zotseek';

export type IndexState =
  /** Searchable now. */
  | { kind: IndexKind; ready: true }
  /** The right index is there, but this document is not in it; `canAdd`: we can hand it over. */
  | { kind: IndexKind; ready: false; reason: 'notIndexed' | 'indexing'; canAdd: boolean }
  /** The right plugin is missing, off or not reachable. */
  | { kind: IndexKind; ready: false; reason: 'unavailable'; canAdd: false };

/** Books go to SeekBook, everything else to ZotSeek. */
export function indexKindFor(attachment: any): IndexKind {
  const parent = attachment?.parentItem;
  return parent?.itemType === 'book' ? 'seekbook' : 'zotseek';
}

function zotseekStore(): any {
  return (Zotero as any).ZotSeek?.vectorStore;
}

export async function indexState(attachment: any): Promise<IndexState> {
  const kind = indexKindFor(attachment);
  const item = attachment.parentItem || attachment;
  const libraryKey = libraryKeyOf(item.libraryID);
  if (kind === 'seekbook') {
    const sb = (Zotero as any).SeekBook;
    if (diagnoseSeekBook(readSeekBookEnv()) !== null || !sb || !libraryKey) return { kind, ready: false, reason: 'unavailable', canAdd: false };
    try {
      if (await sb.isIndexed(libraryKey, item.key)) return { kind, ready: true };
      const running = sb.indexer?.progress?.running && sb.indexer?.progress?.current?.itemKey === item.key;
      return { kind, ready: false, reason: running ? 'indexing' : 'notIndexed', canAdd: typeof sb.indexer?.indexBooks === 'function' };
    } catch (e: any) {
      L.warn(`SeekBook state: ${e?.message || e}`);
      return { kind, ready: false, reason: 'unavailable', canAdd: false };
    }
  }
  if (diagnoseZotSeek(readZotSeekEnv()) !== null || !libraryKey) return { kind, ready: false, reason: 'unavailable', canAdd: false };
  const store = zotseekStore();
  const canAdd = typeof (Zotero as any).ZotSeek?.indexItems === 'function';
  if (typeof store?.isIndexedByIdentity !== 'function') {
    // Unknown ZotSeek version: assume searchable; the search itself tells if nothing comes back.
    return { kind, ready: true };
  }
  try {
    return (await store.isIndexedByIdentity(libraryKey, item.key)) ? { kind, ready: true } : { kind, ready: false, reason: 'notIndexed', canAdd };
  } catch (e: any) {
    L.warn(`ZotSeek state: ${e?.message || e}`);
    return { kind, ready: true };
  }
}

/** Hands the document to its index (SeekBook: the book; ZotSeek: the item). False if that is not possible. */
export async function addToIndex(attachment: any): Promise<boolean> {
  const item = attachment.parentItem || attachment;
  try {
    if (indexKindFor(attachment) === 'seekbook') {
      const sb = (Zotero as any).SeekBook;
      if (typeof sb?.indexer?.indexBooks !== 'function') return false;
      await sb.indexer.indexBooks([item], false);
      return true;
    }
    const zs = (Zotero as any).ZotSeek;
    if (typeof zs?.indexItems !== 'function') return false;
    // Not awaited: ZotSeek shows its own progress window.
    void zs.indexItems([item]);
    return true;
  } catch (e: any) {
    L.warn(`add to index: ${e?.message || e}`);
    return false;
  }
}

export interface PageHit {
  /** 1-based physical page. */
  page: number;
  pageEnd?: number;
  score: number;
}

/**
 * Pages of this PDF that the index finds for the queries, best first (each query's
 * ranks interleaved). SeekBook searches the PDF itself; ZotSeek the library,
 * filtered to the item.
 */
export async function semanticPages(attachment: any, queries: string[], signal?: AbortSignal): Promise<PageHit[]> {
  const item = attachment.parentItem || attachment;
  const libraryKey = libraryKeyOf(item.libraryID) ?? undefined;
  const lists: PageHit[][] = [];
  for (const q of queries.filter((x) => x.trim())) {
    if (indexKindFor(attachment) === 'seekbook') {
      const hits = await searchBooks(q, { topK: 30, libraryKey, attachmentKeys: [attachment.key], signal });
      lists.push(hits.filter((h) => h.page).map((h) => ({ page: h.page!, pageEnd: h.pageEnd, score: h.score })));
    } else {
      const hits = await searchPassages(q, { topK: 100, libraryKey, signal });
      lists.push(hits.filter((h) => h.itemKey === item.key && h.page).map((h) => ({ page: h.page!, score: h.score })));
    }
  }
  const out: PageHit[] = [];
  const seen = new Set<number>();
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const h = l[i];
      if (!h || seen.has(h.page)) continue;
      seen.add(h.page);
      out.push(h);
    }
  }
  return out;
}
