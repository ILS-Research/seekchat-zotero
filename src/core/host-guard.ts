/**
 * Which hosts SeekChat may send document text to.
 *
 * Default: this computer only (127.0.0.1, localhost, [::1]). The pref
 * `seekchat.allowedRemoteHosts` adds exact host names on top. Same rules as
 * the ILS ZotSeek fork (zotseek-src/src/core/loopback-url.ts), duplicated on
 * purpose so the two plugins stay independent.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class HostRejectedError extends Error {
  code = 'HOST_REJECTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'HostRejectedError';
  }
}

/** Normalizes one host entry: lower case, no scheme, port or path. Empty if unusable. */
export function normalizeHostEntry(entry: string): string {
  let h = entry.trim().toLowerCase();
  if (!h) return '';
  if (h.includes('://')) {
    try { return new URL(h).hostname; } catch { return ''; }
  }
  h = h.split('/')[0];
  if (!h.startsWith('[')) h = h.split(':')[0];
  return /^[a-z0-9.\-\[\]:]+$/.test(h) ? h : '';
}

export function parseAllowedHosts(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return Array.from(new Set(raw.split(/[,\s]+/).map(normalizeHostEntry).filter(Boolean)));
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/**
 * An API key only travels over https to other computers (plain http would send it
 * and the PDF text readable to everyone on the way). Loopback stays allowed: it
 * never leaves this computer.
 */
export function assertSecureTransport(u: URL, apiKey: string | undefined): void {
  if (apiKey && u.protocol === 'http:' && !isLoopbackHost(u.hostname)) {
    throw new HostRejectedError(
      `An API key is set, so '${u.hostname}' must be reached over https:// ` +
      `(for a self-signed certificate tick "Accept invalid certificate" in the SeekChat settings).`
    );
  }
}

/** Validates a request URL against loopback plus the allowed remote hosts. */
export function assertAllowedUrl(raw: string, allowedRemoteHosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HostRejectedError(`Invalid server URL: '${raw}'`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HostRejectedError(`Server URL must use http or https, got '${u.protocol}'`);
  }
  if (u.username || u.password) {
    throw new HostRejectedError('Server URL must not contain credentials; use the API key field');
  }
  if (!isLoopbackHost(u.hostname) && !allowedRemoteHosts.includes(u.hostname)) {
    throw new HostRejectedError(
      `'${u.hostname}' is not allowed. SeekChat only talks to this computer unless the host ` +
      `is listed under "Allowed remote hosts" in the SeekChat settings ` +
      `(that sends PDF text and questions to it).`
    );
  }
  return u;
}
