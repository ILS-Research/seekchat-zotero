/**
 * Read-only library tools of the tool chat: search_library (Zotero's search plus ZotSeek and SeekBook as set in
 * the tool list), get_item, get_selection, list_collections, list_tags. Results are compact JSON for the model;
 * items carry their Zotero key, which later tools use. Found items are listed in the run with links.
 */
import { t, tn } from '../../../i18n';
import type { Tool, ToolContext } from '../types';
import type { ToolRunItem } from '../../turn';
import { clampLimit, sourceStatusText, stringArg, type SourceID, type SourceStatus } from './summary';
import {
  currentSelection, DEFAULT_PARTS, itemByKey, itemDetails, listCollections, listTags, searchLibrary, summarize,
  type ItemPart, type SearchArgs,
} from './zotero-library';

const STRING = { type: 'string' };

/** ZotSeek/SeekBook installed and enabled (the plugin object exists); whether their index answers is checked per search. */
const zotseekInstalled = () => !!(Zotero as any).ZotSeek;
const seekbookInstalled = () => !!(Zotero as any).SeekBook;

function sourceLine(status: Record<SourceID, SourceStatus>): string {
  const word = (s: SourceStatus) => (typeof s === 'number' ? tn('libtools.hits', s)
    : s === 'off' ? t('libtools.off') : s === 'missing' ? t('libtools.missing') : s === 'skipped' ? t('libtools.skipped')
    : t('libtools.failed', { error: s.error }));
  return `Zotero: ${word(status.zotero)} · ZotSeek: ${word(status.zotseek)} · SeekBook: ${word(status.seekbook)}`;
}

const SOURCE_NAMES: Record<SourceID, string> = { zotero: 'Zotero', zotseek: 'ZotSeek', seekbook: 'SeekBook' };

export const searchLibraryTool = (): Tool => ({
  spec: {
    name: 'search_library',
    description:
      'Search the user\'s Zotero library (the library chosen at the top of the chat) for items. Combine a free-text query '
      + 'with filters. Besides Zotero\'s own search (title, creator, year; full text with "fulltext") the query also goes to '
      + 'ZotSeek (meaning-based search in papers) and SeekBook (search in books) when the user has them; their hits come '
      + 'with a short excerpt. Results are items with their Zotero "key" – use get_item with it for details. Never invent items.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text: topic, words of the title, author names, year.' },
        author: { type: 'string', description: 'Part of a creator\'s name.' },
        title: { type: 'string', description: 'Part of the title.' },
        year_from: { type: 'integer' },
        year_to: { type: 'integer' },
        item_type: { type: 'string', description: 'Zotero item type, e.g. journalArticle, book, bookSection, report, thesis, webpage.' },
        tags: { type: 'array', items: STRING, description: 'Items must carry all of these tags.' },
        collection: { type: 'string', description: 'Collection name, path ("A / B") or key; includes subcollections.' },
        has_pdf: { type: 'boolean', description: 'Only items with a PDF.' },
        fulltext: { type: 'boolean', description: 'Also search the full text of attachments and notes (Zotero\'s search).' },
        added_after: { type: 'string', description: 'Only items added after this date (YYYY-MM-DD).' },
        sources: { type: 'array', items: { type: 'string', enum: ['zotero', 'zotseek', 'seekbook'] }, description: 'Limit to these search sources (default: all available).' },
        limit: { type: 'integer', description: 'Number of results (default 15, at most 25).' },
      },
    },
  },
  label: () => t('libtools.search.label'),
  description: () => t('libtools.search.description'),
  options: [
    {
      key: 'zotseek',
      label: 'ZotSeek',
      default: 'on',
      choices: [
        { value: 'on', label: t('libtools.useZotSeek'), available: zotseekInstalled, unavailableHint: t('libtools.notInstalled') },
        { value: 'off', label: t('libtools.dontUse') },
      ],
    },
    {
      key: 'seekbook',
      label: 'SeekBook',
      default: 'on',
      choices: [
        { value: 'on', label: t('libtools.useSeekBook'), available: seekbookInstalled, unavailableHint: t('libtools.notInstalled') },
        { value: 'off', label: t('libtools.dontUse') },
      ],
    },
  ],
  title: (args) => (args.query || args.title || args.author
    ? t('libtools.search.titleQuery', { query: String(args.query || args.title || args.author) })
    : t('libtools.search.title')),
  async run(args, ctx) {
    const settings = { zotseek: ctx.options.zotseek === 'on', seekbook: ctx.options.seekbook === 'on' };
    ctx.run.status = t('libtools.searching');
    ctx.update();
    const out = await searchLibrary(ctx.target.libraryID, args as SearchArgs, settings, t('cite.page'), ctx.signal);
    ctx.run.status = `${tn('libtools.found', out.total, { scope: out.scope })}${out.total > out.hits.length ? ` ${t('libtools.shown', { n: out.hits.length })}` : ''}\n${sourceLine(out.status)}`;
    ctx.run.items = out.hits.map((h): ToolRunItem => {
      const s = summarize(h.item);
      const ex = h.excerpts[0];
      return {
        label: s.label,
        badge: h.sources.map((x) => SOURCE_NAMES[x]).join(' + '),
        detail: ex ? `${ex.where ? `${ex.where}: ` : ''}„${ex.text}“` : undefined,
        itemID: h.item.id,
      };
    });
    ctx.run.state = 'done';
    return JSON.stringify({
      scope: out.scope,
      sources: Object.fromEntries(Object.entries(out.status).map(([k, v]) => [k, sourceStatusText(v)])),
      total: out.total,
      shown: out.hits.length,
      results: out.hits.map((h) => ({
        ...summarize(h.item),
        foundBy: h.sources,
        ...(h.excerpts.length ? { excerpts: h.excerpts.map((e) => ({ source: e.source, where: e.where, text: e.text })) } : {}),
      })),
    });
  },
});

const PARTS: ItemPart[] = ['fields', 'abstract', 'notes', 'attachments', 'tags', 'collections', 'related'];

function showItem(ctx: ToolContext, item: any): void {
  ctx.run.items = [{ label: summarize(item).label, itemID: item.id }];
}

export const getItemTool = (): Tool => ({
  spec: {
    name: 'get_item',
    description: 'Read one item of the library by its key (from search_library, get_selection or list results): fields, '
      + 'creators, abstract, and on request notes, attachments, tags, collections, related items.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The item\'s Zotero key.' },
        include: { type: 'array', items: { type: 'string', enum: PARTS }, description: 'Parts to read (default: fields, abstract, tags).' },
      },
      required: ['key'],
    },
  },
  label: () => t('libtools.item.label'),
  description: () => t('libtools.item.description'),
  title: (args) => t('libtools.item.title', { key: String(args.key || '?') }),
  async run(args, ctx) {
    const item = itemByKey(ctx.target.libraryID, String(args.key || ''));
    if (!item?.isRegularItem?.()) {
      ctx.run.state = 'error';
      ctx.run.status = t('libtools.item.missing', { key: String(args.key || '') });
      return `Error: no item with key "${args.key}" in this library. Use search_library to find items and their keys.`;
    }
    const parts = stringArg(args.include).filter((p): p is ItemPart => PARTS.includes(p as ItemPart));
    const details = await itemDetails(item, parts.length ? parts : DEFAULT_PARTS);
    showItem(ctx, item);
    ctx.run.state = 'done';
    return JSON.stringify(details);
  },
});

export const getSelectionTool = (): Tool => ({
  spec: {
    name: 'get_selection',
    description: 'What the user has selected in Zotero right now: the selected items, the collection or library shown, '
      + 'and – with a document open in the reader – that document and the text marked in it. Use it for "these items", '
      + '"this collection", "the marked passage".',
    parameters: { type: 'object', properties: {} },
  },
  label: () => t('libtools.selection.label'),
  description: () => t('libtools.selection.description'),
  title: () => t('libtools.selection.title'),
  async run(_args, ctx) {
    const sel = currentSelection();
    const items = (sel.selectedItems as any[]) || [];
    ctx.run.status = tn('libtools.selection.items', items.length);
    ctx.run.items = items.map((s) => {
      const item = itemByKey(ctx.target.libraryID, s.key) || Zotero.Items.getByLibraryAndKey(Zotero.getMainWindow()?.ZoteroPane?.getSelectedLibraryID?.(), s.key);
      return { label: s.label, itemID: item?.id };
    });
    ctx.run.state = 'done';
    return JSON.stringify(sel);
  },
});

export const listCollectionsTool = (): Tool => ({
  spec: {
    name: 'list_collections',
    description: 'Collections of the library as paths ("Project A / Urban climate") with their keys and number of items; '
      + 'optionally only the subtree of one collection.',
    parameters: {
      type: 'object',
      properties: { parent: { type: 'string', description: 'Collection name, path or key whose subtree to list.' } },
    },
  },
  label: () => t('libtools.collections.label'),
  description: () => t('libtools.collections.description'),
  title: () => t('libtools.collections.title'),
  async run(args, ctx) {
    const list = listCollections(ctx.target.libraryID, args.parent ? String(args.parent) : undefined);
    ctx.run.status = tn('libtools.collections.count', list.length);
    ctx.run.state = 'done';
    return JSON.stringify({ library: Zotero.Libraries.getName(ctx.target.libraryID), collections: list });
  },
});

export const listTagsTool = (): Tool => ({
  spec: {
    name: 'list_tags',
    description: 'Tags used in the library or in one collection, with the number of items carrying each, most used first. '
      + 'Use it to work with the user\'s existing tags instead of inventing variants.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name, path or key (default: whole library).' },
        filter: { type: 'string', description: 'Only tags containing this text.' },
        limit: { type: 'integer', description: 'Number of tags (default 100).' },
      },
    },
  },
  label: () => t('libtools.tags.label'),
  description: () => t('libtools.tags.description'),
  title: () => t('libtools.tags.title'),
  async run(args, ctx) {
    const out = await listTags(ctx.target.libraryID, args.collection ? String(args.collection) : undefined, args.filter, clampLimit(args.limit, 100, 300));
    ctx.run.status = tn('libtools.tags.count', out.tags.length, { scope: out.scope });
    ctx.run.state = 'done';
    return JSON.stringify(out);
  },
});

/** The library tools, built when the registry is made (labels in the UI language). */
export function libraryTools(): Tool[] {
  return [searchLibraryTool(), getItemTool(), getSelectionTool(), listCollectionsTool(), listTagsTool()];
}
