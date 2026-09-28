/**
 * Books in a library chat scope for the source "books (keyword search)":
 * regular items of type "book" with a PDF. No index needed: per question the
 * books are ranked by keyword hits, and the best ones are pre-read by the model
 * (book-excerpts.ts); their passages join the sources of the one answer.
 */
import { describeItem, getPdfPages } from '../context/pdf-context';
import { countMatchingPages, selectPagesByTerms, type WeightedTerm } from '../context/page-selection';
import type { Page } from '../context/types';
import type { LibraryScope } from './library-context';

/** A book for the library chat's "books" source: its PDF and a label. */
export interface BookTarget {
  attachment: any;
  label: string;
}

/** At most this many books are pre-read per question (those with the most keyword hits). */
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

/** The pages of one book to pre-read, and how many pages matched at all. */
export interface BookPages {
  pages: Page[];
  totalPages: number;
  matchedPages: number;
}

/**
 * Cheap local prefilter with the planning keywords (both languages): books
 * without any hit are not read. Pages: the whole book if it fits the budget,
 * else the plan's best pages (the reading step replaces them with its own selection).
 */
export async function bookPages(book: BookTarget, terms: WeightedTerm[], budgetChars: number): Promise<BookPages> {
  const all = await getPdfPages(book.attachment);
  const matchedPages = countMatchingPages(all, terms);
  if (!matchedPages) return { pages: [], totalPages: all.length, matchedPages };
  const selection = selectPagesByTerms(all, terms, budgetChars);
  return { pages: selection.pages, totalPages: all.length, matchedPages };
}
