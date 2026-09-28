/**
 * Books in a library chat scope for the source "Bücher (Stichwortsuche)":
 * regular items of type "book" with a PDF. Each is later asked like in the
 * PDF chat – no index needed, one answer per book.
 */
import { describeItem } from '../context/pdf-context';
import type { BookTarget } from '../session';
import type { LibraryScope } from './library-context';

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
