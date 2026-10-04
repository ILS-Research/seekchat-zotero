/**
 * Pure helpers of the tool that changes items (update_item): reading the model's arguments into a list of changes,
 * matching names loosely, and describing a change in plain lines. No Zotero here (unit-tested); update-item.ts
 * checks the changes against the items and applies them.
 */
import { stringArg } from './summary';

/** More items in one call are refused (the model is asked to split them). */
export const MAX_UPDATE_ITEMS = 50;

/** What the model wants changed on one item. Field values are text; "" clears the field. */
export interface ItemChange {
  key: string;
  itemType?: string;
  fields: Record<string, string>;
  addTags: string[];
  removeTags: string[];
}

/**
 * The changes of a call: `changes` (a list), or the arguments of a single change (`key`, …). Throws an Error the
 * model can read when something is unusable.
 */
export function parseChanges(args: Record<string, any>): ItemChange[] {
  const raw: any[] = Array.isArray(args.changes) ? args.changes : args.key ? [args] : [];
  if (!raw.length) throw new Error('no changes given: pass "changes", a list of {key, item_type?, fields?, add_tags?, remove_tags?}');
  if (raw.length > MAX_UPDATE_ITEMS) throw new Error(`at most ${MAX_UPDATE_ITEMS} items per call; split them into several calls`);
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const key = String(r?.key || '').trim();
    if (!key) throw new Error(`change ${i + 1} has no "key"`);
    if (seen.has(key)) throw new Error(`item ${key} appears twice; combine its changes`);
    seen.add(key);
    const fields: Record<string, string> = {};
    const given = r.fields && typeof r.fields === 'object' && !Array.isArray(r.fields) ? r.fields : {};
    for (const [name, value] of Object.entries(given)) fields[name] = value === null || value === undefined ? '' : String(value).trim();
    const itemType = String(r.item_type || '').trim() || undefined;
    const addTags = stringArg(r.add_tags);
    const removeTags = stringArg(r.remove_tags);
    if (!itemType && !Object.keys(fields).length && !addTags.length && !removeTags.length) throw new Error(`change for ${key} changes nothing`);
    return { key, itemType, fields, addTags, removeTags };
  });
}

/** Case-, space- and underscore-insensitive form of a type or field name ("Journal Article" = journalArticle). */
export function looseName(name: string): string {
  return String(name || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/** The entry of `names` that `wanted` means (exact, else loose), or undefined. */
export function matchName(wanted: string, names: string[]): string | undefined {
  const w = String(wanted || '').trim();
  return names.find((n) => n === w) || names.find((n) => looseName(n) === looseName(w));
}

/** Item types that are not regular items: never offered as a target type. */
export const NON_REGULAR_TYPES = ['attachment', 'note', 'annotation'];

/** One line of the preview; an empty value shows as a dash. */
export function dash(value: string): string {
  return value.trim() ? value : '–';
}

/** Tags that the item does not carry yet / carries and may lose. */
export function tagDelta(own: string[], add: string[], remove: string[]): { add: string[]; remove: string[] } {
  const has = new Set(own);
  return { add: [...new Set(add)].filter((t) => !has.has(t)), remove: [...new Set(remove)].filter((t) => has.has(t)) };
}
