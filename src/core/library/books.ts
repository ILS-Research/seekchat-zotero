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
}

/** At most this many books get the answering call per question (the others: state "limit"). */
export const MAX_BOOKS_READ = 8;

async function pdfOf(item: any): Promise<any | null> {
  const best = await item.getBestAttachment();
  if (best?.isPDFAttachment?.()) return best;
  return Zotero.Items.get(item.getAttachments()).find((a: any) => a?.isPDFAttachment?.()) || null;
}

export async function booksInScope(scope: LibraryScope): Promise<BookTarget[]> {
  const items: any[] = scope.itemIDs
    ? Zotero.Items.get(Array.from(scope.itemIDs))
    : Zotero.Items.getAll(scope.libraryID, true, false);
  const books: BookTarget[] = [];
  for (const item of items) {
    if (!item || item.deleted || !item.isRegularItem?.() || item.itemType !== 'book') continue;
    const attachment = await pdfOf(item);
    if (attachment) books.push({ attachment, label: describeItem(attachment) });
  }
  return books.sort((a, b) => a.label.localeCompare(b.label));
}
