/**
 * Books in a library chat scope for the source "books (keyword search)":
 * regular items of type "book" with a PDF (every PDF of a book is read). No index needed: per question each
 * book is asked like in the PDF chat (session.readBook, book-excerpts.ts); the
 * statements of its answer join the sources of the one joint answer.
 */
import { describeItem } from '../context/pdf-context';
import type { LibraryScope } from './library-context';
import { pdfTitle } from './zotero-items';

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

/**
 * All PDFs of a book, best one first, without exact copies (same file hash). A book can consist of
 * several PDFs (one per chapter, appendices); the keyword reading asks each of them.
 */
async function pdfsOf(item: any): Promise<any[]> {
  const all: any[] = Zotero.Items.get(item.getAttachments()).filter((a: any) => a?.isPDFAttachment?.() && !a.deleted);
  const best = await item.getBestAttachment();
  const ordered = [...(best?.isPDFAttachment?.() ? [best] : []), ...all.filter((a) => a.id !== best?.id)];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of ordered) {
    // attachmentHash is async (md5 of the file); unreadable file: keep the PDF.
    let hash = '';
    try {
      hash = String((await a.attachmentHash) || '');
    } catch {
      hash = '';
    }
    if (hash && seen.has(hash)) continue;
    if (hash) seen.add(hash);
    out.push(a);
  }
  return out;
}

export async function booksInScope(scope: LibraryScope): Promise<BookTarget[]> {
  // getAll is async (the whole-library scope found no books before 0.9.2 because it was not awaited).
  const items: any[] = scope.itemIDs
    ? Zotero.Items.get(Array.from(scope.itemIDs))
    : await Zotero.Items.getAll(scope.libraryID, true, false);
  const books: BookTarget[] = [];
  for (const item of items) {
    if (!item || item.deleted || !item.isRegularItem?.() || item.itemType !== 'book') continue;
    const pdfs = await pdfsOf(item);
    for (const attachment of pdfs) {
      // Several PDFs: the label names the PDF ("… – Teil 3"), so the progress list tells them apart.
      const label = pdfs.length > 1 ? `${describeItem(attachment)} · ${pdfTitle(attachment)}` : describeItem(attachment);
      books.push({ attachment, label, itemKey: item.key });
    }
  }
  return books.sort((a, b) => a.label.localeCompare(b.label));
}

/** Books of the scope (item keys) that SeekBook cannot search: what the keyword reading or a later index run has to cover. */
export function unindexedBooks(books: BookTarget[], searchable: Set<string> | null): BookTarget[] {
  if (!searchable) return [];
  const seen = new Set<string>();
  return books.filter((b) => {
    if (!b.itemKey || searchable.has(b.itemKey) || seen.has(b.itemKey)) return false;
    seen.add(b.itemKey);
    return true;
  });
}

/** Keys of the books in a collection or selection scope; undefined for a whole library (no filter needed). */
export function bookKeysInScope(scope: LibraryScope): string[] | undefined {
  if (!scope.itemIDs) return undefined;
  return Zotero.Items.get(Array.from(scope.itemIDs))
    .filter((i: any) => i && !i.deleted && i.isRegularItem?.() && i.itemType === 'book')
    .map((i: any) => i.key as string);
}
