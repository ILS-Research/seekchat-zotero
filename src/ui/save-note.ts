/**
 * "Verlauf als Notiz speichern": the chat as a Zotero note.
 * PDF chat: child note of the PDF's item (standalone PDF: standalone note in its collections).
 * Library chat: standalone note – in the collection for a collection scope, related to the
 * selected items for an item scope, else in the library root.
 */
import type { LibraryScope } from '../core/library/library-context';
import { attachmentFor } from '../core/library/sources';
import { itemOfSource, libraryKeyOf } from '../core/library/zotero-items';
import type { ChatSession } from '../core/session';
import { readPrefs } from '../prefs';
import { chatToNoteHtml, type NoteLinks } from './note-html';

/** "library" or "groups/<id>" for zotero:// links. */
function linkLibrary(libraryID: number): string | null {
  const key = libraryKeyOf(libraryID);
  if (key === 'user') return 'library';
  return key ? `groups/${key.slice('group:'.length)}` : null;
}

export function openPdfLink(attachment: any, page?: number): string | null {
  const lib = linkLibrary(attachment.libraryID);
  return lib ? `zotero://open-pdf/${lib}/items/${attachment.key}${page ? `?page=${page}` : ''}` : null;
}

export function selectLink(item: any): string | null {
  const lib = linkLibrary(item.libraryID);
  return lib ? `zotero://select/${lib}/items/${item.key}` : null;
}

async function save(note: any, html: string): Promise<any> {
  note.setNote(html);
  await note.saveTx();
  return note;
}

export async function savePdfChatAsNote(session: ChatSession, subject: string, attachment: any): Promise<any> {
  const links: NoteLinks = { page: (p) => openPdfLink(attachment, p) };
  const html = chatToNoteHtml(session.turns, { subject, model: readPrefs().model, date: new Date() }, links);
  const note = new Zotero.Item('note');
  note.libraryID = attachment.libraryID;
  if (attachment.parentItemID) {
    note.parentID = attachment.parentItemID;
  } else {
    note.setCollections(attachment.getCollections());
  }
  return save(note, html);
}

export async function saveLibraryChatAsNote(session: ChatSession, scope: LibraryScope): Promise<any> {
  const links: NoteLinks = {
    source: (s, p, attachmentID) => {
      const item = itemOfSource(s);
      if (!item) return null;
      if (p) {
        const id = attachmentID ?? attachmentFor(s, p);
        const att = (id && Zotero.Items.get(id))
          || (item.isAttachment?.() ? item : Zotero.Items.get(item.getAttachments()).find((a: any) => a.isPDFAttachment?.()));
        if (att) return openPdfLink(att, p);
      }
      return selectLink(item);
    },
  };
  const html = chatToNoteHtml(session.turns, { subject: scope.label, model: readPrefs().model, date: new Date() }, links);
  const note = new Zotero.Item('note');
  note.libraryID = scope.libraryID;
  if (scope.collectionID) note.setCollections([scope.collectionID]);
  const related = scope.collectionID ? [] : Zotero.Items.get(Array.from(scope.itemIDs || []));
  await save(note, html);
  if (related.length) {
    await Zotero.DB.executeTransaction(async () => {
      for (const item of related) {
        note.addRelatedItem(item);
        item.addRelatedItem(note);
        await item.save();
      }
      await note.save();
    });
  }
  return note;
}
