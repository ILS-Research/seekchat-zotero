/**
 * Tools on a document's reference list, through Find Online References (zotero-reference) when installed:
 * get_document_references gives the model the whole list of a document (it decides which entries are of interest),
 * show_references lists the chosen ones in the chat with a link each (DOI, arXiv, the reference's URL, else a
 * Google Scholar search), so the user can open and add them in the browser; entries already in the library link
 * to the item instead. Both read only.
 */
import { t, tn } from '../../../i18n';
import { getFindRefsListApi, type FindRefsDocumentReference } from '../../findrefs/client';
import { docKind } from '../../context/document';
import type { ToolRunItem } from '../../turn';
import type { Tool, ToolContext } from '../types';
import { cut, stringArg } from './summary';
import { itemByKey, summarize } from './zotero-library';

/** Entries per call; longer lists are read in pages (offset). */
export const REFERENCES_PAGE = 120;
const TEXT_CHARS = 260;

const listApiAvailable = () => !!getFindRefsListApi();

/** Where a reference can be opened in the browser, best first. Pure (unit-tested). */
export function referenceLink(ref: Pick<FindRefsDocumentReference, 'identifiers' | 'url' | 'title' | 'text'>): { url: string; via: 'doi' | 'arxiv' | 'url' | 'isbn' | 'search' } {
  const ids = ref.identifiers || {};
  if (ids.DOI) return { url: `https://doi.org/${encodeURI(ids.DOI)}`, via: 'doi' };
  if (ids.arXiv) return { url: `https://arxiv.org/abs/${encodeURIComponent(ids.arXiv)}`, via: 'arxiv' };
  if (ref.url && /^https?:\/\//i.test(ref.url)) return { url: ref.url, via: 'url' };
  const query = (ref.title && ref.title.length > 8 ? ref.title : ref.text || '').replace(/\s+/g, ' ').trim().slice(0, 250);
  if (ids.ISBN) return { url: `https://www.google.com/search?tbm=bks&q=isbn:${encodeURIComponent(ids.ISBN)}`, via: 'isbn' };
  return { url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`, via: 'search' };
}

/** Compact entry for the model. Pure. */
export function referenceForModel(r: FindRefsDocumentReference): Record<string, unknown> {
  const ids = r.identifiers || {};
  return {
    n: r.number,
    text: cut(r.text, TEXT_CHARS),
    ...(r.title ? { title: cut(r.title, 200) } : {}),
    ...(r.year ? { year: r.year } : {}),
    ...(ids.DOI ? { doi: ids.DOI } : {}),
    ...(ids.arXiv ? { arxiv: ids.arXiv } : {}),
    ...(ids.ISBN ? { isbn: ids.ISBN } : {}),
    ...(r.url && !ids.DOI ? { url: r.url } : {}),
  };
}

/**
 * The document meant: `key` of an item or attachment in the chat's library; without key the document open in the
 * reader, else the single item selected in the library.
 */
function documentFor(ctx: ToolContext, key?: string): any | null {
  if (key) return itemByKey(ctx.target.libraryID, key) || null;
  const win = Zotero.getMainWindow();
  if (win?.Zotero_Tabs?.selectedType === 'reader') {
    const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    const att = reader && Zotero.Items.get(reader.itemID);
    if (att) return att;
  }
  const selected: any[] = win?.ZoteroPane?.getSelectedItems?.() || [];
  return selected.length === 1 ? selected[0] : null;
}

function labelOf(item: any): string {
  const top = item.isRegularItem?.() ? item : item.parentItem || item;
  return top.isRegularItem?.() ? summarize(top).label : String(item.getField?.('title') || item.key);
}

async function readList(ctx: ToolContext, key?: string) {
  const api = getFindRefsListApi();
  if (!api) throw new Error('Find Online References (0.7.36 or newer) is not installed');
  const doc = documentFor(ctx, key);
  if (!doc) throw new Error(key ? `no item or attachment with key "${key}" in this library` : 'no document given and none open or selected');
  if (doc.isAttachment?.() && docKind(doc) !== 'pdf') throw new Error('reference lists can only be read from PDFs');
  ctx.run.status = t('refs.reading', { doc: labelOf(doc) });
  ctx.update();
  const list = await api.getReferences!(doc);
  if (!list) throw new Error(`"${labelOf(doc)}" has no PDF`);
  return { doc, list };
}

function fail(ctx: ToolContext, e: any): string {
  ctx.run.state = 'error';
  ctx.run.status = String(e?.message || e);
  return `Error: ${ctx.run.status}`;
}

export const getDocumentReferencesTool = (): Tool => ({
  spec: {
    name: 'get_document_references',
    description:
      'Read the reference list (bibliography) of a document with Find Online References: all entries, numbered. Use it '
      + 'to find sources related to a document or a topic in it – decide yourself which entries fit, then call '
      + 'show_references with their numbers so the user gets links. "key" is an item or PDF key (from search_library, '
      + 'get_selection); without it the document open in the reader or the selected item is used. Long lists come in '
      + `pages of ${REFERENCES_PAGE} (offset).`,
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Item or PDF attachment key; default: document in the reader / selected item.' },
        offset: { type: 'integer', description: 'Skip this many entries (for long lists).' },
      },
    },
  },
  label: () => t('refs.list.label'),
  description: () => t('refs.list.description'),
  available: listApiAvailable,
  unavailableHint: () => t('refs.needsFindRefs'),
  title: () => t('refs.list.title'),
  async run(args, ctx) {
    try {
      const { doc, list } = await readList(ctx, args.key ? String(args.key) : undefined);
      const offset = Math.max(0, Math.round(Number(args.offset) || 0));
      const page = list.references.slice(offset, offset + REFERENCES_PAGE);
      ctx.run.state = 'done';
      ctx.run.status = tn('refs.list.done', list.references.length, { doc: labelOf(doc) });
      return JSON.stringify({
        document: labelOf(doc),
        key: list.itemKey,
        total: list.references.length,
        offset,
        ...(offset + page.length < list.references.length ? { next: offset + page.length } : {}),
        references: page.map(referenceForModel),
      });
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      return fail(ctx, e);
    }
  },
});

export const showReferencesTool = (): Tool => ({
  spec: {
    name: 'show_references',
    description:
      'Show chosen entries of a document\'s reference list (numbers from get_document_references) in the chat, each with '
      + 'a link to open it in the browser (DOI, arXiv, its URL, else a Google Scholar search); entries already in the '
      + 'library link to the item. Give a short reason per entry when helpful.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The same document key as for get_document_references.' },
        numbers: { type: 'array', items: { type: 'integer' }, description: 'Entry numbers to show.' },
        reasons: { type: 'object', description: 'Optional: entry number -> one sentence why it fits.', additionalProperties: { type: 'string' } },
      },
      required: ['numbers'],
    },
  },
  label: () => t('refs.show.label'),
  description: () => t('refs.show.description'),
  available: listApiAvailable,
  unavailableHint: () => t('refs.needsFindRefs'),
  title: (args) => tn('refs.show.title', stringArg(args.numbers).length),
  async run(args, ctx) {
    try {
      const { doc, list } = await readList(ctx, args.key ? String(args.key) : undefined);
      const wanted = [...new Set(stringArg(args.numbers).map(Number).filter((n) => Number.isInteger(n)))];
      const byNumber = new Map(list.references.map((r) => [r.number, r]));
      const api = getFindRefsListApi()!;
      const reasons = (args.reasons && typeof args.reasons === 'object' ? args.reasons : {}) as Record<string, string>;
      const out: Record<string, unknown>[] = [];
      const items: ToolRunItem[] = [];
      for (const n of wanted) {
        const ref = byNumber.get(n);
        if (!ref) {
          out.push({ n, status: 'no such entry' });
          continue;
        }
        const inLibrary = await api.findInLibrary?.(ref).catch(() => undefined);
        const label = `[${n}] ${cut(ref.text, 220)}`;
        const reason = reasons[String(n)] ? String(reasons[String(n)]) : undefined;
        if (inLibrary?.id) {
          items.push({ label, badge: t('refs.badge.inLibrary'), detail: reason, itemID: inLibrary.id });
          out.push({ n, status: 'already in the library', key: inLibrary.key });
        } else {
          const link = referenceLink(ref);
          items.push({ label, badge: t(`refs.badge.${link.via}`), detail: reason, url: link.url });
          out.push({ n, status: 'linked', link: link.url, via: link.via });
        }
      }
      ctx.run.items = items;
      ctx.run.state = 'done';
      ctx.run.status = t('refs.show.done', { n: items.length, doc: labelOf(doc) });
      return JSON.stringify({ document: labelOf(doc), shown: out });
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      return fail(ctx, e);
    }
  },
});
