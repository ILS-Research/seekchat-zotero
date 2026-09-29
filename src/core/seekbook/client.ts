/**
 * SeekBook (own full-text index for books) over its REST API on Zotero's local
 * server: status (installed, enabled, reachable, books indexed), passage
 * search, which books are searchable, and whole pages. Like the ZotSeek
 * client: no fallback, and nothing outside src/core/seekbook/ may assume SeekBook.
 */
import { t, type Key } from '../../i18n';
import { getFetch } from '../../util/env';
import { UserFacingError } from '../errors';
import { parseSearchResponse, type ZotSeekPassage } from '../zotseek/client';

export const STATS_PATH = '/seekbook/stats';
export const SEARCH_PATH = '/seekbook/search';
export const BOOKS_PATH = '/seekbook/books';
export const PAGES_PATH = '/seekbook/pages';
/** SeekBook's limit for one /seekbook/pages request. */
export const MAX_PAGES = 10;
export const API_VERSION = 1;

export type SeekBookReason = 'not-installed' | 'server-off' | 'endpoint-off' | 'no-index' | 'error';

export type SeekBookStatus =
  | { available: true; indexedBooks: number; queued: number }
  | { available: false; reason: SeekBookReason; message: string };

export interface SeekBookEnvironment {
  /** Zotero.SeekBook exists: installed and enabled (a disabled plugin removes it). */
  plugin: boolean;
  serverPort: number | null;
  /** /seekbook/stats is registered (off when "Access for other plugins" is switched off in SeekBook). */
  endpoint: boolean;
}

export function readEnvironment(): SeekBookEnvironment {
  const server = (Zotero as any).Server;
  return {
    plugin: !!(Zotero as any).SeekBook,
    serverPort: server?.port || null,
    endpoint: !!server?.Endpoints?.[STATS_PATH],
  };
}

export function diagnose(env: SeekBookEnvironment): SeekBookReason | null {
  if (!env.plugin) return 'not-installed';
  if (!env.serverPort) return 'server-off';
  if (!env.endpoint) return 'endpoint-off';
  return null;
}

const MESSAGE: Record<SeekBookReason, Key> = {
  'not-installed': 'seekbook.notInstalled',
  'server-off': 'seekbook.serverOff',
  'endpoint-off': 'seekbook.endpointOff',
  'no-index': 'seekbook.noIndex',
  error: 'seekbook.error',
};

export function unavailableMessage(reason: SeekBookReason, detail = ''): string {
  return t(MESSAGE[reason], { detail });
}

/** Status from /seekbook/stats. Never throws: problems come back as an unavailable status. */
export async function getSeekBookStatus(signal?: AbortSignal): Promise<SeekBookStatus> {
  const env = readEnvironment();
  const local = diagnose(env);
  if (local) return { available: false, reason: local, message: unavailableMessage(local) };
  try {
    const resp = await getFetch()(`http://127.0.0.1:${env.serverPort}${STATS_PATH}`, {
      headers: { 'Zotero-Allowed-Request': '1' }, redirect: 'error', signal,
    });
    if (!resp.ok) return { available: false, reason: 'error', message: unavailableMessage('error', `HTTP ${resp.status}`) };
    return parseStatus(await resp.json());
  } catch (e: any) {
    if (signal?.aborted) throw e;
    return { available: false, reason: 'error', message: unavailableMessage('error', String(e?.message || e)) };
  }
}

export function parseStatus(json: any): SeekBookStatus {
  if (json?.apiVersion !== API_VERSION) {
    return { available: false, reason: 'error', message: unavailableMessage('error', `API version ${json?.apiVersion ?? '?'}`) };
  }
  const indexedBooks = Number(json.indexedBooks) || 0;
  if (!indexedBooks) return { available: false, reason: 'no-index', message: unavailableMessage('no-index') };
  return { available: true, indexedBooks, queued: Number(json.queuedDocuments) || 0 };
}

export class SeekBookUnavailableError extends UserFacingError {
  constructor(readonly reason: SeekBookReason, detail = '') {
    super(unavailableMessage(reason, detail));
    this.name = 'SeekBookUnavailableError';
  }
}

/** A SeekBook passage: ZotSeek's passage fields plus where in the book it is. */
export interface SeekBookPassage extends ZotSeekPassage {
  attachmentKey?: string;
  attachmentTitle?: string;
  pageEnd?: number;
  pageLabel?: string;
  chapter?: string;
  chunkIndex?: number;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** ZotSeek's parser (same shape) plus SeekBook's extra `matchedChunk` fields. */
export function parseBookSearch(json: any): SeekBookPassage[] {
  const base = parseSearchResponse(json);
  const chunks = (json.results as any[]).filter((r) => r && typeof r.itemKey === 'string' && r.itemKey).map((r) => r.matchedChunk || {});
  return base.map((p, i) => ({
    ...p,
    attachmentKey: str(chunks[i].attachmentKey),
    attachmentTitle: str(chunks[i].attachmentTitle),
    pageEnd: num(chunks[i].pageEnd),
    pageLabel: str(chunks[i].pageLabel),
    chapter: str(chunks[i].chapter),
    chunkIndex: num(chunks[i].chunkIndex),
  }));
}

async function getJson(path: string, params: Record<string, string | undefined>, signal?: AbortSignal): Promise<{ status: number; json: any }> {
  const env = readEnvironment();
  const local = diagnose(env);
  if (local) throw new SeekBookUnavailableError(local);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  let resp: Response;
  try {
    resp = await getFetch()(`http://127.0.0.1:${env.serverPort}${path}?${sp}`, {
      headers: { 'Zotero-Allowed-Request': '1' }, redirect: 'error', signal,
    });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    throw new SeekBookUnavailableError('error', String(e?.message || e));
  }
  let json: any = null;
  try {
    json = await resp.json();
  } catch {
    // handled by the callers through the status
  }
  return { status: resp.status, json };
}

function failed(status: number, json: any): SeekBookUnavailableError {
  return new SeekBookUnavailableError('error', `HTTP ${status}${json?.error ? `: ${String(json.error).slice(0, 200)}` : ''}`);
}

export interface BookSearchOptions {
  topK?: number;
  libraryKey?: string;
  /** Only these books (item keys). */
  itemKeys?: string[];
  signal?: AbortSignal;
}

/** Passage search in SeekBook's index; throws SeekBookUnavailableError when it cannot answer. */
export async function searchBooks(query: string, opts: BookSearchOptions = {}): Promise<SeekBookPassage[]> {
  const { status, json } = await getJson(SEARCH_PATH, {
    q: query, topK: opts.topK ? String(opts.topK) : undefined, libraryKey: opts.libraryKey,
    itemKeys: opts.itemKeys?.join(','), granularity: 'passages',
  }, opts.signal);
  if (status === 404) throw new SeekBookUnavailableError('endpoint-off');
  if (status !== 200) throw failed(status, json);
  try {
    return parseBookSearch(json);
  } catch (e: any) {
    throw new SeekBookUnavailableError('error', String(e?.message || e));
  }
}

/**
 * Item keys of the searchable books (at least one PDF indexed) among `itemKeys`
 * (all books of the library when omitted). Null when SeekBook is too old to
 * say (before 0.3.0: no /seekbook/books).
 */
export async function searchableBooks(libraryKey: string, itemKeys?: string[], signal?: AbortSignal): Promise<Set<string> | null> {
  const { status, json } = await getJson(BOOKS_PATH, { libraryKey, itemKeys: itemKeys?.join(',') }, signal);
  if (status === 404 && !json?.books) return null;
  if (status !== 200 || !Array.isArray(json?.books)) throw failed(status, json);
  return new Set(json.books.filter((b: any) => b?.searchable === true && typeof b.itemKey === 'string').map((b: any) => b.itemKey as string));
}

export interface BookPage {
  /** 1-based page in the PDF. */
  page: number;
  label?: string;
  text: string;
}

/** Whole pages `from`–`to` (at most MAX_PAGES) of an indexed PDF, as SeekBook cleaned them. */
export async function loadBookPages(
  libraryKey: string, attachmentKey: string, from: number, to: number, signal?: AbortSignal,
): Promise<{ attachmentKey: string; attachmentTitle: string; pages: BookPage[] }> {
  const { status, json } = await getJson(PAGES_PATH, {
    libraryKey, attachmentKey, pages: from === to ? String(from) : `${from}-${to}`,
  }, signal);
  if (status !== 200 || !Array.isArray(json?.pages)) throw failed(status, json);
  return {
    attachmentKey: String(json.attachmentKey || attachmentKey),
    attachmentTitle: String(json.attachmentTitle || ''),
    pages: json.pages
      .filter((p: any) => num(p?.page) && typeof p.text === 'string')
      .map((p: any) => ({ page: p.page, label: str(p.label), text: p.text })),
  };
}
