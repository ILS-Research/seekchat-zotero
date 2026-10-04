/**
 * Tool read_document: the plain text of a document of the library, from page `from_page` to `to_page` (PDF), or
 * the sections of a web page, e-book or text file. For checks that need the document itself – title page, imprint,
 * abstract, reference list – and for reading on where a search hit was found. Read-only, a few pages per call.
 */
import { t } from '../../../i18n';
import { UserFacingError } from '../../errors';
import { docKind, KIND_ORDER } from '../../context/document';
import { describeItem, getDocPages } from '../../context/pdf-context';
import type { Tool } from '../types';
import { itemByKey } from './zotero-library';

/** Pages per call and characters per call at most (the model's context is the server's own, never raised). */
export const READ_MAX_PAGES = 10;
export const READ_MAX_CHARS = 12000;

/** The attachment meant by `item`: the attachment itself, else the regular item's best readable one. */
export function readableAttachment(item: any): any | null {
  if (item?.isAttachment?.()) return docKind(item) ? item : null;
  if (!item?.isRegularItem?.()) return null;
  const atts: any[] = Zotero.Items.get(item.getAttachments()).filter((a: any) => a && !a.deleted && docKind(a));
  atts.sort((a, b) => KIND_ORDER.indexOf(docKind(a)!) - KIND_ORDER.indexOf(docKind(b)!));
  return atts[0] || null;
}

/** The part of `pages` to read: from, to and the cut by characters. Pure (unit-tested). */
export function pageWindow(total: number, fromArg: unknown, toArg: unknown, lengths: number[]): { from: number; to: number; next?: number } {
  const from = Math.min(Math.max(1, Math.round(Number(fromArg)) || 1), Math.max(1, total));
  const wanted = Math.round(Number(toArg)) || from + 2;
  let to = Math.min(total, Math.max(from, wanted), from + READ_MAX_PAGES - 1);
  let chars = 0;
  for (let p = from; p <= to; p++) {
    chars += lengths[p - 1] || 0;
    if (chars > READ_MAX_CHARS && p > from) {
      to = p - 1;
      break;
    }
  }
  return { from, to, ...(to < total ? { next: to + 1 } : {}) };
}

export const readDocumentTool = (): Tool => ({
  spec: {
    name: 'read_document',
    description:
      'Read the text of a document of the library: "key" is an item key (its best readable file is used) or an attachment key; '
      + `"from_page" and "to_page" select pages (default: the first 3; at most ${READ_MAX_PAGES} pages or about ${READ_MAX_CHARS} `
      + 'characters per call – the result says where to continue). Web pages, e-books and text files come in sections of about a page. '
      + 'Use it to check what a document really is (title page, imprint, abstract) or to read on.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Item or attachment key.' },
        from_page: { type: 'integer', description: 'First page (default 1).' },
        to_page: { type: 'integer', description: 'Last page (default: from_page + 2).' },
      },
      required: ['key'],
    },
  },
  label: () => t('read.label'),
  description: () => t('read.description'),
  title: (args) => t('read.title', { key: String(args.key || '?') }),
  async run(args, ctx) {
    const { run } = ctx;
    const fail = (message: string) => {
      run.state = 'error';
      run.status = message;
      return `Error: ${message}`;
    };
    const item = itemByKey(ctx.target.libraryID, String(args.key || ''));
    if (!item) return fail(t('read.missing', { key: String(args.key || '') }));
    const att = readableAttachment(item);
    if (!att) return fail(t('read.noFile'));
    const kind = docKind(att)!;
    const label = describeItem(att);
    run.status = t('read.reading', { doc: label });
    ctx.update();
    let pages;
    try {
      pages = await getDocPages(att, kind);
    } catch (e: any) {
      if (ctx.signal.aborted) throw e;
      return fail(e instanceof UserFacingError ? e.message : String(e?.message || e));
    }
    const total = pages.length ? pages[pages.length - 1].pageNumber : 0;
    const lengths: number[] = [];
    for (const p of pages) lengths[p.pageNumber - 1] = p.text.length;
    const win = pageWindow(total, args.from_page, args.to_page, lengths);
    const unit = kind === 'pdf' ? 'page' : 'section';
    run.items = [{ label, itemID: (att.parentItem || att).id }];
    run.status = t(kind === 'pdf' ? 'read.donePages' : 'read.doneSections', { from: win.from, to: win.to, total });
    run.state = 'done';
    return JSON.stringify({
      document: label,
      key: att.key,
      kind,
      [`${unit}s`]: total,
      from: win.from,
      to: win.to,
      ...(win.next ? { next: win.next } : {}),
      text: pages.filter((p) => p.pageNumber >= win.from && p.pageNumber <= win.to).map((p) => ({ [unit]: p.pageNumber, text: p.text })),
    });
  },
});
