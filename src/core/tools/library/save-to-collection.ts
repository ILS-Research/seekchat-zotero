/**
 * Tool save_to_collection: puts items (by key, e.g. from search_library) into a collection of the chat's library,
 * creating the collection – also a nested path "A / B" – when it does not exist. Like the import it shows a preview
 * (target, items with checkboxes; items already in it unchecked) and changes nothing before the user confirms.
 */
import { t, tn } from '../../../i18n';
import { logger } from '../../../util/log';
import type { ToolRunItem } from '../../turn';
import type { Tool } from '../types';
import { collectionPaths, planCollectionPath, stringArg } from './summary';
import { collectionNodes, itemByKey, summarize } from './zotero-library';

const L = logger('Library');
/** More items in one call are refused (the model is asked to split them). */
export const MAX_SAVE_ITEMS = 100;

export const saveToCollectionTool = (): Tool => ({
  spec: {
    name: 'save_to_collection',
    description:
      'Put items of the library into a collection, creating the collection when it does not exist yet. "collection" is '
      + 'a name, a path for nested collections ("Project A / Heat") or a key; missing parts of a path are created. "keys" '
      + 'are item keys from search_library, get_selection or other results – never invent keys. Without keys it only '
      + 'creates the collection. The user sees a preview and confirms before anything changes.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name, path ("A / B") or key.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Item keys to put into the collection.' },
      },
      required: ['collection'],
    },
  },
  label: () => t('collect.label'),
  description: () => t('collect.description'),
  title: (args) => t('collect.title', { collection: String(args.collection || '?') }),
  async run(args, ctx) {
    const { run, target } = ctx;
    const libraryID = target.libraryID;
    if (!Zotero.Libraries.get(libraryID)?.editable) {
      run.state = 'error';
      run.status = t('collect.readOnly');
      return 'Error: this library is read-only.';
    }
    const keys = [...new Set(stringArg(args.keys))];
    if (keys.length > MAX_SAVE_ITEMS) return `Error: at most ${MAX_SAVE_ITEMS} items per call; split them into several calls.`;
    let plan: ReturnType<typeof planCollectionPath>;
    try {
      plan = planCollectionPath(collectionPaths(collectionNodes(libraryID), 10000), String(args.collection || ''));
    } catch (e: any) {
      run.state = 'error';
      run.status = String(e?.message || e);
      return `Error: ${run.status}`;
    }
    const newPath = [plan.existing?.path, ...plan.create].filter(Boolean).join(' / ');
    const existingCol = plan.create.length ? null : Zotero.Collections.getByLibraryAndKey(libraryID, plan.existing!.key);
    const inside = new Set<number>(existingCol ? existingCol.getChildItems(true, false) : []);
    const items = keys.map((key) => ({ key, item: itemByKey(libraryID, key) }));
    run.items = items.map(({ key, item }): ToolRunItem => {
      if (!item?.isRegularItem?.()) return { label: key, badge: t('collect.badge.unknown'), selectable: false, checked: false };
      const already = inside.has(item.id);
      return { label: summarize(item).label, badge: already ? t('collect.badge.already') : t('collect.badge.add'), selectable: !already, checked: !already, itemID: item.id };
    });
    run.status = plan.create.length
      ? t('collect.confirmNew', { path: newPath, n: run.items.filter((i) => i.checked).length })
      : t('collect.confirmExisting', { path: newPath, n: run.items.filter((i) => i.checked).length });
    run.confirmLabel = plan.create.length ? t('collect.buttonNew') : t('collect.button');
    run.confirmEmpty = plan.create.length > 0;
    if (!(await ctx.confirm())) {
      run.state = 'cancelled';
      run.status = t('collect.cancelled');
      for (const i of run.items) i.selectable = false;
      return JSON.stringify({ status: 'cancelled by the user', collection: newPath, added: 0 });
    }
    run.state = 'running';
    const chosen = items.filter((_x, i) => run.items![i].checked && run.items![i].selectable);
    for (const i of run.items) i.selectable = false;
    let collection: any = existingCol;
    const created: string[] = [];
    await Zotero.DB.executeTransaction(async () => {
      let parentID = plan.existing ? Zotero.Collections.getByLibraryAndKey(libraryID, plan.existing.key).id : undefined;
      for (const name of plan.create) {
        const c = new Zotero.Collection({ libraryID, name, ...(parentID ? { parentID } : {}) });
        await c.save();
        created.push(name);
        parentID = c.id;
        collection = c;
      }
      for (const { item } of chosen) {
        item.addToCollection(collection.id);
        await item.save();
      }
    });
    run.items.forEach((ri, i) => {
      if (chosen.includes(items[i])) ri.badge = t('collect.badge.added');
      else if (ri.badge === t('collect.badge.add')) ri.badge = t('collect.badge.skipped');
    });
    run.state = 'done';
    run.status = `${created.length ? t('collect.created', { path: newPath }) + ' ' : ''}${tn('collect.done', chosen.length, { path: newPath })}`;
    L.info(`collection ${collection.key}: ${created.length} created, ${chosen.length} items added`);
    return JSON.stringify({
      collection: newPath,
      key: collection.key,
      created,
      added: chosen.length,
      alreadyInside: items.filter((x) => x.item && inside.has(x.item.id)).length,
      notFound: items.filter((x) => !x.item?.isRegularItem?.()).map((x) => x.key),
    });
  },
});
