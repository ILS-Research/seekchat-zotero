/**
 * Zotero side of the library chat: ZotSeek library keys ('user', 'group:<id>')
 * to library IDs and back, items for sources, and the target of a citation.
 */
import { attachmentFor, type LibrarySource } from './sources';

/** ZotSeek's key for a Zotero library: 'user' or 'group:<groupID>'; null for other library types. */
export function libraryKeyOf(libraryID: number): string | null {
  if (libraryID === Zotero.Libraries.userLibraryID) return 'user';
  const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
  return groupID ? `group:${groupID}` : null;
}

export function libraryIDOf(libraryKey: string | null): number | null {
  if (libraryKey === 'user') return Zotero.Libraries.userLibraryID;
  const m = libraryKey?.match(/^group:(\d+)$/);
  if (!m) return null;
  const id = Zotero.Groups.getLibraryIDFromGroupID(Number(m[1]));
  return id === false ? null : id;
}

/** The regular item a source refers to, or null if it is not in this Zotero (anymore). */
/** Title of a PDF attachment for source lists and prompts: its title, else the file name without extension. */
export function pdfTitle(att: any): string {
  const title = String(att?.getField?.('title') || '').trim();
  const file = String(att?.attachmentFilename || '').replace(/\.pdf$/i, '');
  return title && title.toLowerCase() !== 'pdf' && title.toLowerCase() !== 'full text pdf' ? title : file || title;
}

export function itemOfSource(source: Pick<LibrarySource, 'itemKey' | 'libraryKey'>): any | null {
  const libraryID = libraryIDOf(source.libraryKey);
  if (libraryID === null) return null;
  return Zotero.Items.getByLibraryAndKey(libraryID, source.itemKey) || null;
}

/**
 * Follows a citation: with a page, the item's PDF opens on that page;
 * otherwise (or without PDF) the item – or the cited note – is selected in the library.
 */
export async function openSourceCitation(source: LibrarySource, page?: number, attachmentID?: number): Promise<void> {
  const item = itemOfSource(source);
  if (!item) throw new Error(`Eintrag ${source.itemKey} nicht gefunden.`);
  const win = Zotero.getMainWindow();
  if (page) {
    // Excerpts name the PDF they come from (a book can have several); ZotSeek passages only the item.
    const id = attachmentID ?? attachmentFor(source, page);
    const att = (id && Zotero.Items.get(id))
      || (item.isAttachment?.() ? item : await item.getBestAttachment());
    if (att?.isPDFAttachment?.()) {
      await Zotero.Reader.open(att.id, { pageIndex: page - 1 });
      return;
    }
  }
  const noteKey = !page ? source.excerpts.find((e) => e.noteKey)?.noteKey : undefined;
  const note = noteKey ? Zotero.Items.getByLibraryAndKey(item.libraryID, noteKey) : null;
  win.Zotero_Tabs.select('zotero-pane');
  await win.ZoteroPane.selectItem((note || item).id);
}
