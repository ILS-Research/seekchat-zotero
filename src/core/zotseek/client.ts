/**
 * Client for ZotSeek's local REST search (`/zotseek/search`, `/zotseek/stats`)
 * on Zotero's own HTTP server. SeekChat uses ZotSeek only through this
 * documented interface; there is deliberately no fallback to other search
 * paths: without the endpoint there is no library chat, only the PDF chat.
 */
import { getFetch } from '../../util/env';

export const SEARCH_PATH = '/zotseek/search';
export const STATS_PATH = '/zotseek/stats';

export interface ZotSeekPassage {
  itemKey: string;
  /** 'user' | 'group:<id>' | null if ZotSeek could not resolve it. */
  libraryKey: string | null;
  title: string;
  authors: string[];
  year?: number;
  /** Rank score, only comparable within one result set. */
  score: number;
  /** Cosine similarity 0–1, null if the semantic leg did not find the item. */
  semanticScore: number | null;
  /** Normalised keyword relevance, null if the keyword leg did not find the item. */
  keywordScore: number | null;
  /** Full chunk text; missing for pure keyword hits without an indexed chunk. */
  text?: string;
  /** 1-based PDF page, if known. */
  page?: number;
  /** Where the chunk came from, e.g. 'pdf', 'note', 'abstract'. */
  textSource?: string;
  /** Child note key for note chunks. */
  noteKey?: string;
}

export interface SearchOptions {
  topK?: number;
  /** 'user' or 'group:<id>'; omitted = all indexed libraries. */
  libraryKey?: string;
  mode?: 'hybrid' | 'semantic' | 'keyword';
  /** 0–1; omitted = ZotSeek's own preference. */
  minSimilarity?: number;
  signal?: AbortSignal;
}

export interface IndexStats {
  ready: boolean;
  indexedPapers: number;
  totalChunks: number;
}

export type UnavailableReason = 'not-installed' | 'server-off' | 'endpoint-off' | 'no-index' | 'error';

export type ZotSeekStatus =
  | { available: true; stats: IndexStats }
  | { available: false; reason: UnavailableReason; message: string };

/** User-facing explanation why the library chat is not available. */
export const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  'not-installed': 'Chat über die Bibliothek braucht das Plugin ZotSeek. Ohne ZotSeek steht nur der Chat mit einzelnen PDFs zur Verfügung.',
  'server-off': 'Chat über die Bibliothek braucht Zoteros lokalen HTTP-Server: Einstellungen → Erweitert → ' +
    '„Anderen Anwendungen auf diesem Computer erlauben, mit Zotero zu kommunizieren“.',
  'endpoint-off': 'Chat über die Bibliothek braucht in den ZotSeek-Einstellungen „AI Agent Access“.',
  'no-index': 'ZotSeek hat noch nichts indexiert. Bitte zuerst in ZotSeek die Bibliothek indexieren (Modus „full“ für PDF-Inhalte).',
  'error': 'ZotSeek-Suche nicht erreichbar.',
};

export class ZotSeekUnavailableError extends Error {
  constructor(public reason: UnavailableReason, detail?: string) {
    super(UNAVAILABLE_MESSAGES[reason] + (detail ? ` (${detail})` : ''));
    this.name = 'ZotSeekUnavailableError';
  }
}

/** Facts about the running Zotero that decide whether ZotSeek's REST search can work. */
export interface Environment {
  pluginLoaded: boolean;
  /** Port of Zotero's local HTTP server, 0 if it is not running. */
  serverPort: number;
  searchEndpointRegistered: boolean;
}

/** Local reasons first; null means "try the endpoint". */
export function diagnose(env: Environment): UnavailableReason | null {
  if (!env.pluginLoaded) return 'not-installed';
  if (!env.serverPort) return 'server-off';
  if (!env.searchEndpointRegistered) return 'endpoint-off';
  return null;
}

export function readEnvironment(): Environment {
  const server = (Zotero as any).Server;
  return {
    pluginLoaded: !!(Zotero as any).ZotSeek,
    // Zotero.Server.port is only set while the server listens.
    serverPort: Number(server?.port) || 0,
    searchEndpointRegistered: !!server?.Endpoints?.[SEARCH_PATH],
  };
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asScore(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Validates and flattens a `/zotseek/search` response; entries without an item key are dropped. */
export function parseSearchResponse(json: any): ZotSeekPassage[] {
  if (!json || !Array.isArray(json.results)) throw new Error('unexpected ZotSeek response: no "results" list');
  const out: ZotSeekPassage[] = [];
  for (const r of json.results) {
    if (!r || typeof r.itemKey !== 'string' || !r.itemKey) continue;
    const chunk = r.matchedChunk && typeof r.matchedChunk === 'object' ? r.matchedChunk : {};
    const authors = Array.isArray(r.authors) ? r.authors.filter((a: unknown) => typeof a === 'string')
      : typeof r.authors === 'string' && r.authors ? [r.authors] : [];
    out.push({
      itemKey: r.itemKey,
      libraryKey: typeof r.libraryKey === 'string' ? r.libraryKey : null,
      title: typeof r.title === 'string' ? r.title : '',
      authors,
      year: asNumber(r.year),
      score: asNumber(r.score) ?? 0,
      semanticScore: asScore(r.semanticScore),
      keywordScore: asScore(r.keywordScore),
      text: typeof chunk.snippet === 'string' && chunk.snippet.trim() ? chunk.snippet : undefined,
      page: asNumber(chunk.page),
      textSource: typeof chunk.textSource === 'string' ? chunk.textSource : undefined,
      noteKey: typeof chunk.noteKey === 'string' ? chunk.noteKey : undefined,
    });
  }
  return out;
}

export function parseStats(json: any): IndexStats {
  return {
    ready: json?.ready === true,
    indexedPapers: asNumber(json?.indexedPapers) ?? 0,
    totalChunks: asNumber(json?.totalChunks) ?? 0,
  };
}

export function buildSearchUrl(port: number, query: string, opts: SearchOptions = {}): string {
  const sp = new URLSearchParams({ q: query, granularity: 'passages' });
  if (opts.topK) sp.set('topK', String(opts.topK));
  if (opts.libraryKey) sp.set('libraryKey', opts.libraryKey);
  if (opts.mode) sp.set('mode', opts.mode);
  if (opts.minSimilarity !== undefined) sp.set('minSimilarity', String(opts.minSimilarity));
  return `http://127.0.0.1:${port}${SEARCH_PATH}?${sp}`;
}

/**
 * GET on Zotero's local server. The header is required: Zotero rejects requests
 * with a browser user agent (ours, since fetch comes from the main window) unless
 * they carry Zotero-Allowed-Request.
 */
async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  let resp: Response;
  try {
    resp = await getFetch()(url, { headers: { 'Zotero-Allowed-Request': '1' }, redirect: 'error', signal });
  } catch (e: any) {
    if (signal?.aborted) throw e;
    throw new ZotSeekUnavailableError('error', String(e?.message || e));
  }
  // 404: endpoint unregistered since the last check (AI Agent Access switched off).
  if (resp.status === 404) throw new ZotSeekUnavailableError('endpoint-off');
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new ZotSeekUnavailableError('error', `HTTP ${resp.status}, keine JSON-Antwort`);
  }
  if (!resp.ok) throw new ZotSeekUnavailableError('error', `HTTP ${resp.status}: ${String(json?.error || '').slice(0, 200)}`);
  return json;
}

/** Whether the library chat can work right now; checks the environment, then the index via /zotseek/stats. */
export async function getZotSeekStatus(signal?: AbortSignal): Promise<ZotSeekStatus> {
  const env = readEnvironment();
  const local = diagnose(env);
  if (local) return { available: false, reason: local, message: UNAVAILABLE_MESSAGES[local] };
  try {
    const stats = parseStats(await getJson(`http://127.0.0.1:${env.serverPort}${STATS_PATH}`, signal));
    if (!stats.ready) return { available: false, reason: 'no-index', message: UNAVAILABLE_MESSAGES['no-index'] };
    return { available: true, stats };
  } catch (e: any) {
    if (e instanceof ZotSeekUnavailableError) return { available: false, reason: e.reason, message: e.message };
    throw e;
  }
}

/** Passage search in the ZotSeek index; throws ZotSeekUnavailableError if the endpoint cannot be used. */
export async function searchPassages(query: string, opts: SearchOptions = {}): Promise<ZotSeekPassage[]> {
  const env = readEnvironment();
  const local = diagnose(env);
  if (local) throw new ZotSeekUnavailableError(local);
  const json = await getJson(buildSearchUrl(env.serverPort, query, opts), opts.signal);
  try {
    return parseSearchResponse(json);
  } catch (e: any) {
    throw new ZotSeekUnavailableError('error', String(e?.message || e));
  }
}
