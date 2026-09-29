/**
 * SeekBook (own full-text index for books) over its REST API on Zotero's local
 * server. For now only the status: whether SeekBook is installed, enabled,
 * reachable and has indexed books. Passage search and page loading follow
 * (M4 step 1, see ../ideas-seekbook.md). Like the ZotSeek client: no fallback,
 * and nothing outside src/core/seekbook/ may assume SeekBook.
 */
import { t, type Key } from '../../i18n';
import { getFetch } from '../../util/env';

export const STATS_PATH = '/seekbook/stats';
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
