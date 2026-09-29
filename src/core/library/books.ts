/**
 * Books in a library chat scope for the source "books (keyword search)":
 * regular items of type "book" with a PDF. No index needed: per question each
 * book is asked like in the PDF chat (session.readBook, book-excerpts.ts); the
 * statements of its answer join the sources of the one joint answer.
 */
import { describeItem } from '../context/pdf-context';
import type { LibraryScope } from './library-context';

/** A book for the library chat's "books" source: its PDF and a label. */
export interface BookTarget {
  attachment: any;
  label: string;
  /** The book item's key (SeekBook names books by it). */
  itemKey?: string;
}

/**
 * Books that SeekBook can search go to its index; the others stay with the
 * keyword reading (if chosen). Unknown coverage (old SeekBook): nothing moves.
 */
export function splitBooks(books: BookTarget[], searchable: Set<string> | null): { indexed: BookTarget[]; keyword: BookTarget[] } {
  if (!searchable) return { indexed: [], keyword: books };
  const indexed = books.filter((b) => b.itemKey && searchable.has(b.itemKey));
  return { indexed, keyword: books.filter((b) => !indexed.includes(b)) };
}

/** At most this many books get the answering call per question (the others: state "limit"). */
export const MAX_BOOKS_READ = 8;

async function pdfOf(item: any): Promise<any | null> {
  const best = await item.getBestAttachment();
  if (best?.isPDFAttachment?.()) return best;
  return Zotero.Items.get(item.getAttachments()).find((a: any) => a?.isPDFAttachment?.()) || null;
}

export async function booksInScope(scope: LibraryScope): Promise<BookTarget[]> {
  // getAll is async (the whole-library scope found no books before 0.9.2 because it was not awaited).
  const items: any[] = scope.itemIDs
    ? Zotero.Items.get(Array.from(scope.itemIDs))
    : await Zotero.Items.getAll(scope.libraryID, true, false);
  const books: BookTarget[] = [];
  for (const item of items) {
    if (!item || item.deleted || !item.isRegularItem?.() || item.itemType !== 'book') continue;
    const attachment = await pdfOf(item);
    if (attachment) books.push({ attachment, label: describeItem(attachment), itemKey: item.key });
  }
  return books.sort((a, b) => a.label.localeCompare(b.label));
}

/** Keys of the books in a collection or selection scope; undefined for a whole library (no filter needed). */
export function bookKeysInScope(scope: LibraryScope): string[] | undefined {
  if (!scope.itemIDs) return undefined;
  return Zotero.Items.get(Array.from(scope.itemIDs))
    .filter((i: any) => i && !i.deleted && i.isRegularItem?.() && i.itemType === 'book')
    .map((i: any) => i.key as string);
}
