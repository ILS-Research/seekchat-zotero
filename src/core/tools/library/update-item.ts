/**
 * Tool update_item: changes library items – their item type, fields and tags. For checks like "is the type of
 * every item right" the model reads items (search_library with fields, get_item, read_document) and then proposes
 * changes here. Like the import it shows a preview first (per item what changes, the fields a new type drops,
 * checkboxes) and changes nothing before the user confirms. The previous values go into the result, so a change
 * can be reverted by another call.
 */
import { t, tn } from '../../../i18n';
import { logger } from '../../../util/log';
import type { ToolRunItem } from '../../turn';
import type { Tool } from '../types';
import { dash, fieldAlias, matchName, NON_REGULAR_TYPES, parseChanges, tagDelta, type ItemChange } from './edit-plan';
import { field, itemByKey, summarize } from './zotero-library';

const L = logger('Library');

interface FieldEdit {
  fieldID: number;
  name: string;
  from: string;
  to: string;
}

interface Plan {
  change: ItemChange;
  item: any;
  label: string;
  newTypeID?: number;
  edits: FieldEdit[];
  /** Fields (name -> value) the new type does not have; their values are dropped. */
  lost: Record<string, string>;
  addTags: string[];
  removeTags: string[];
  /** Why this change cannot be made at all (item missing, not a regular item, unknown type). */
  problem?: string;
  /** Fields left out because the (new) type does not have them; the rest of the change is still made. */
  skipped: string[];
}

const typeName = (id: number) => Zotero.ItemTypes.getName(id);
const typeLabel = (id: number) => Zotero.ItemTypes.getLocalizedString(id) || typeName(id);

/** Value the item has now for the field `fieldID` of the type `newType` (mapped through base fields when the type changes). */
function currentValue(item: any, fieldID: number, newType: number): string {
  try {
    if (Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) return field(item, Zotero.ItemFields.getName(fieldID));
    const base = Zotero.ItemFields.getBaseIDFromTypeAndField(newType, fieldID) || fieldID;
    const oldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, base);
    return oldID ? field(item, Zotero.ItemFields.getName(oldID)) : '';
  } catch {
    return '';
  }
}

/** Checks one change against its item and works out what would change. Does not touch the item. */
function planChange(libraryID: number, change: ItemChange): Plan {
  const item = itemByKey(libraryID, change.key);
  const plan: Plan = { change, item, label: change.key, edits: [], lost: {}, addTags: [], removeTags: [], skipped: [] };
  if (!item) return { ...plan, problem: t('update.problem.missing') };
  if (!item.isRegularItem?.()) return { ...plan, problem: t('update.problem.notRegular') };
  plan.label = summarize(item).label;

  let typeID: number = item.itemTypeID;
  if (change.itemType) {
    const allowed: string[] = Zotero.ItemTypes.getTypes().map((x: any) => x.name).filter((n: string) => !NON_REGULAR_TYPES.includes(n));
    const name = matchName(change.itemType, allowed);
    if (!name) return { ...plan, problem: t('update.problem.type', { type: change.itemType }) };
    const id = Zotero.ItemTypes.getID(name);
    if (id !== item.itemTypeID) {
      plan.newTypeID = id;
      typeID = id;
      const dropped: number[] = item.getFieldsNotInType(id, true) || [];
      for (const fieldID of dropped) {
        const name = Zotero.ItemFields.getName(fieldID);
        const v = field(item, name);
        if (v) plan.lost[name] = v;
      }
    }
  }

  const valid: string[] = Zotero.ItemFields.getItemTypeFields(typeID).map((id: number) => Zotero.ItemFields.getName(id));
  for (const [given, to] of Object.entries(change.fields)) {
    const wanted = fieldAlias(given);
    let fieldID: number | false = false;
    const own = matchName(wanted, valid);
    if (own) fieldID = Zotero.ItemFields.getID(own);
    else {
      // A base field (publicationTitle) given for a type that names it differently (bookTitle).
      const any = matchName(wanted, Zotero.ItemFields.getAll().map((x: any) => x.name));
      const base = any && Zotero.ItemFields.getID(any);
      fieldID = (base && Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, base)) || false;
    }
    if (!fieldID) {
      plan.skipped.push(given);
      continue;
    }
    const name = Zotero.ItemFields.getName(fieldID);
    const from = currentValue(item, fieldID, typeID);
    if (from !== to) plan.edits.push({ fieldID, name, from, to });
  }
  const own = (item.getTags() || []).map((x: any) => x.tag);
  const delta = tagDelta(own, change.addTags, change.removeTags);
  plan.addTags = delta.add;
  plan.removeTags = delta.remove;
  return plan;
}

const hasChange = (p: Plan) => !p.problem && (p.newTypeID !== undefined || p.edits.length > 0 || p.addTags.length > 0 || p.removeTags.length > 0);

/** The preview lines of a change, in the UI language. */
function describe(p: Plan): string {
  if (p.problem) return p.problem;
  const lines: string[] = [];
  if (p.newTypeID !== undefined) lines.push(t('update.line.type', { from: typeLabel(p.item.itemTypeID), to: typeLabel(p.newTypeID) }));
  for (const e of p.edits) {
    lines.push(t('update.line.field', { field: Zotero.ItemFields.getLocalizedString(e.fieldID) || e.name, from: dash(e.from), to: dash(e.to) }));
  }
  const lost = Object.keys(p.lost);
  if (lost.length) lines.push(t('update.line.lost', { fields: lost.map((f) => `${f} („${p.lost[f].slice(0, 40)}“)`).join(', ') }));
  if (p.addTags.length) lines.push(t('update.line.tagsAdd', { tags: p.addTags.join(', ') }));
  if (p.removeTags.length) lines.push(t('update.line.tagsRemove', { tags: p.removeTags.join(', ') }));
  if (p.skipped.length) lines.push(t('update.line.skipped', { fields: p.skipped.join(', '), type: typeLabel(p.newTypeID ?? p.item.itemTypeID) }));
  return lines.join('\n') || t('update.nothingHere');
}

/** What could not be done, for the model: whole changes refused and fields left out. */
function problemsOf(plans: Plan[]): { key: string; problem: string }[] {
  return plans.flatMap((p) => [
    ...(p.problem ? [{ key: p.change.key, problem: p.problem }] : []),
    ...(p.skipped.length ? [{ key: p.change.key, problem: `fields not in the type ${typeName(p.newTypeID ?? p.item.itemTypeID)}, left out: ${p.skipped.join(', ')}` }] : []),
  ]);
}

export const updateItemTool = (): Tool => ({
  spec: {
    name: 'update_item',
    description:
      'Change items of the library: their item type, fields and tags. Give a list of "changes", one per item: "key" (from '
      + 'search_library, get_item, get_selection – never invent keys), optionally "item_type" (Zotero name, e.g. journalArticle, '
      + 'book, bookSection, conferencePaper, report, thesis, webpage), "fields" (Zotero field name -> new value; "" clears '
      + 'the field), "add_tags", "remove_tags". A new item type drops the fields it does not have (the preview shows which). '
      + 'Change only what you have evidence for (the fields, the first pages with read_document); at most '
      + `50 items per call. The user sees a preview and confirms before anything changes; the result lists the previous values.`,
    parameters: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: 'The changes, one per item.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Item key.' },
              item_type: { type: 'string', description: 'New Zotero item type.' },
              fields: { type: 'object', description: 'Field name -> new value ("" clears).', additionalProperties: { type: 'string' } },
              add_tags: { type: 'array', items: { type: 'string' } },
              remove_tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['key'],
          },
        },
      },
      required: ['changes'],
    },
  },
  label: () => t('update.label'),
  description: () => t('update.description'),
  title: (args) => tn('update.title', Array.isArray(args.changes) ? args.changes.length : args.key ? 1 : 0),
  async run(args, ctx) {
    const { run, target } = ctx;
    const libraryID = target.libraryID;
    if (!Zotero.Libraries.get(libraryID)?.editable) {
      run.state = 'error';
      run.status = t('collect.readOnly');
      return 'Error: this library is read-only.';
    }
    let plans: Plan[];
    try {
      plans = parseChanges(args).map((c) => planChange(libraryID, c));
    } catch (e: any) {
      run.state = 'error';
      run.status = String(e?.message || e);
      return `Error: ${run.status}`;
    }
    run.items = plans.map((p): ToolRunItem => {
      const change = hasChange(p);
      return {
        label: p.label,
        badge: p.problem ? t('update.badge.invalid') : change ? t('update.badge.change') : t('update.badge.unchanged'),
        detail: describe(p),
        selectable: change,
        checked: change,
        itemID: p.item?.id,
      };
    });
    const n = () => run.items!.filter((i) => i.checked).length;
    if (!plans.some(hasChange)) {
      run.state = problemsOf(plans).length ? 'error' : 'done';
      run.status = t('update.nothing');
      return JSON.stringify({ status: 'nothing to change', problems: problemsOf(plans) });
    }
    run.status = tn('update.confirm', n());
    run.confirmLabel = t('update.button');
    if (!(await ctx.confirm())) {
      run.state = 'cancelled';
      run.status = t('collect.cancelled');
      for (const i of run.items) i.selectable = false;
      return JSON.stringify({ status: 'cancelled by the user', changed: 0 });
    }
    run.state = 'running';
    const changed: Record<string, unknown>[] = [];
    const failed: Record<string, unknown>[] = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const row = run.items[i];
      row.selectable = false;
      if (!row.checked || !hasChange(p)) {
        if (hasChange(p)) row.badge = t('update.badge.skipped');
        continue;
      }
      const before: Record<string, unknown> = {
        ...(p.newTypeID !== undefined ? { item_type: typeName(p.item.itemTypeID), droppedFields: p.lost } : {}),
        ...(p.edits.length ? { fields: Object.fromEntries(p.edits.map((e) => [e.name, e.from])) } : {}),
        ...(p.addTags.length ? { tagsAdded: p.addTags } : {}),
        ...(p.removeTags.length ? { tagsRemoved: p.removeTags } : {}),
      };
      try {
        if (p.newTypeID !== undefined) p.item.setType(p.newTypeID);
        for (const e of p.edits) p.item.setField(e.fieldID, e.to);
        for (const tag of p.addTags) p.item.addTag(tag);
        for (const tag of p.removeTags) p.item.removeTag(tag);
        await p.item.saveTx();
        row.badge = t('update.badge.changed');
        changed.push({ key: p.change.key, label: p.label, before });
      } catch (e: any) {
        L.error(`update ${p.change.key}: ${e?.message || e}`);
        row.badge = t('update.badge.failed');
        row.detail = `${row.detail}\n${String(e?.message || e)}`;
        failed.push({ key: p.change.key, error: String(e?.message || e) });
      }
    }
    run.state = failed.length && !changed.length ? 'error' : 'done';
    run.status = tn('update.done', changed.length) + (failed.length ? ` ${tn('update.failed', failed.length)}` : '');
    L.info(`update_item: ${changed.length} changed, ${failed.length} failed`);
    return JSON.stringify({
      changed, failed, notChanged: plans.length - changed.length - failed.length,
      ...(problemsOf(plans).length ? { problems: problemsOf(plans) } : {}),
    });
  },
});
