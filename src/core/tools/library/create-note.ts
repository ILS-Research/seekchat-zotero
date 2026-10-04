/**
 * Tool create_note: writes a Zotero note – a child note of an item (key), else a standalone note in a collection or,
 * without either, in the chat's target (collection or library root). The text is Markdown (headings, lists, bold,
 * italics); the user sees it in a preview and confirms before the note exists.
 */
import { t } from '../../../i18n';
import { escapeHtml, markdownToHtml } from '../../../ui/markdown';
import { logger } from '../../../util/log';
import type { Tool } from '../types';
import { collectionPaths, cut, findCollection } from './summary';
import { collectionNodes, itemByKey, summarize } from './zotero-library';

const L = logger('Library');
const MAX_NOTE_CHARS = 20000;

/** Note HTML from the model's Markdown: an optional title as first heading. Pure (unit-tested). */
export function noteHtml(title: string, markdown: string): string {
  const body = markdownToHtml(markdown, (text) => [{ type: 'text', text }]);
  return `${title.trim() ? `<h1>${escapeHtml(title.trim())}</h1>\n` : ''}${body}`;
}

export const createNoteTool = (): Tool => ({
  spec: {
    name: 'create_note',
    description:
      'Create a Zotero note from Markdown text (headings, lists, **bold**, *italic*). With "key" (a regular item from '
      + 'search_library, get_item, get_selection) it becomes a child note of that item; with "collection" (name, path or key of an '
      + 'existing collection) a standalone note in it; with neither, a standalone note where the chat saves ("target"). '
      + 'Write the note content yourself from what you have read; never invent facts or sources. The user sees the text and confirms.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note text in Markdown.' },
        title: { type: 'string', description: 'Optional title, shown as the first heading.' },
        key: { type: 'string', description: 'Item key: make it a child note of this item.' },
        collection: { type: 'string', description: 'Existing collection (name, path or key) for a standalone note.' },
      },
      required: ['text'],
    },
  },
  label: () => t('note.label'),
  description: () => t('note.description'),
  title: (args) => t('note.title', { title: cut(String(args.title || args.text || ''), 40) }),
  async run(args, ctx) {
    const { run, target } = ctx;
    const libraryID = target.libraryID;
    const fail = (message: string) => {
      run.state = 'error';
      run.status = message;
      return `Error: ${message}`;
    };
    if (!Zotero.Libraries.get(libraryID)?.editable) return fail(t('collect.readOnly'));
    const text = String(args.text || '').trim();
    if (!text) return fail(t('note.empty'));
    if (text.length > MAX_NOTE_CHARS) return fail(t('note.tooLong', { max: MAX_NOTE_CHARS }));

    let parent: any = null;
    let collection: any = null;
    let where: string;
    if (args.key) {
      parent = itemByKey(libraryID, String(args.key));
      if (!parent?.isRegularItem?.()) return fail(t('note.noParent', { key: String(args.key) }));
      where = t('note.childOf', { item: summarize(parent).label });
    } else if (args.collection) {
      try {
        const found = findCollection(collectionPaths(collectionNodes(libraryID), 10000), String(args.collection));
        collection = Zotero.Collections.getByLibraryAndKey(libraryID, found.key);
        where = t('note.inCollection', { path: found.path });
      } catch (e: any) {
        return fail(String(e?.message || e));
      }
    } else {
      collection = target.collectionID ? Zotero.Collections.get(target.collectionID) : null;
      where = collection ? t('note.inCollection', { path: collection.name }) : t('note.inLibrary', { library: Zotero.Libraries.getName(libraryID) });
    }

    const html = noteHtml(String(args.title || ''), text);
    run.items = [{ label: where, badge: t('note.badge.new'), detail: cut(text, 900), selectable: true, checked: true, itemID: parent?.id }];
    run.status = t('note.confirm');
    run.confirmLabel = t('note.button');
    if (!(await ctx.confirm())) {
      run.state = 'cancelled';
      run.status = t('collect.cancelled');
      run.items[0].selectable = false;
      return JSON.stringify({ status: 'cancelled by the user', created: false });
    }
    run.items[0].selectable = false;
    if (!run.items[0].checked) {
      run.state = 'cancelled';
      run.status = t('collect.cancelled');
      return JSON.stringify({ status: 'cancelled by the user', created: false });
    }
    run.state = 'running';
    const note = new Zotero.Item('note');
    note.libraryID = libraryID;
    if (parent) note.parentID = parent.id;
    else if (collection) note.setCollections([collection.id]);
    note.setNote(html);
    await note.saveTx();
    run.items[0].badge = t('note.badge.created');
    run.items[0].itemID = note.id;
    run.state = 'done';
    run.status = t('note.done', { where });
    L.info(`note ${note.key} created (${parent ? `child of ${parent.key}` : collection ? `in ${collection.key}` : 'library root'})`);
    return JSON.stringify({ created: true, noteKey: note.key, where, parent: parent?.key, collection: collection?.key });
  },
});
