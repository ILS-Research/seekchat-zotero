import { assertAllowedUrl } from '../host-guard';
import { getFetch, newTextDecoder } from '../../util/env';
import { LineBuffer } from './stream-parsers';
import type { ClientConfig } from './types';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Joins base URL and path without dropping a path prefix such as /v1. */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/**
 * One HTTP request to the model server. The URL is checked against the host
 * allow-list at request time, and redirects are refused rather than followed,
 * so a redirect cannot carry document text to another host.
 */
export async function request(
  cfg: ClientConfig,
  path: string,
  init: { method: string; body?: unknown; signal?: AbortSignal },
): Promise<Response> {
  const url = assertAllowedUrl(joinUrl(cfg.baseUrl, path), cfg.allowedRemoteHosts);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const resp = await getFetch()(url.href, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'error',
    signal: init.signal,
  });
  if (!resp.ok) {
    let detail = '';
    try {
      const text = await resp.text();
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.error || text;
      } catch {
        detail = text;
      }
    } catch {
      // body unreadable, the status is all we have
    }
    throw new HttpError(resp.status, `HTTP ${resp.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
  }
  return resp;
}

/** Feeds each complete line of a streaming response body to onLine. */
export async function readLines(resp: Response, onLine: (line: string) => boolean | void): Promise<void> {
  if (!resp.body) throw new Error('Response has no body');
  const reader = resp.body.getReader();
  const decoder = newTextDecoder();
  const lines = new LineBuffer();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of lines.push(decoder.decode(value, { stream: true }))) {
        if (onLine(line) === false) return;
      }
    }
    for (const line of lines.push(decoder.decode())) onLine(line);
    for (const line of lines.flush()) onLine(line);
  } finally {
    reader.releaseLock();
  }
}
