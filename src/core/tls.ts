/**
 * "Accept invalid certificate": for an https chat server with a
 * self-signed, expired or mismatching certificate, SeekChat adds a
 * certificate exception for that host and port in Firefox's override
 * service, like the browser's "Accept the risk" button. Temporary (until
 * Zotero restarts) and only for hosts SeekChat talks to; taken back when the
 * setting is switched off.
 */
import { logger } from '../util/log';

const L = logger('TLS');

/** host:port with an exception added in this session. */
const overridden = new Set<string>();

function overrideService(): any {
  try {
    const Cc = (globalThis as any).Cc ?? (globalThis as any).Components?.classes ?? Zotero.getMainWindow()?.Cc;
    const Ci = (globalThis as any).Ci ?? (globalThis as any).Components?.interfaces ?? Zotero.getMainWindow()?.Ci;
    return Cc['@mozilla.org/security/certoverride;1'].getService(Ci.nsICertOverrideService);
  } catch {
    return null;
  }
}

/** Certificate of an https origin whose TLS check fails, or null if the check passes (or the host is unreachable). */
function failingServerCert(origin: string): Promise<any> {
  const win = Zotero.getMainWindow();
  const xhr = new win.XMLHttpRequest();
  xhr.open('HEAD', `${origin}/`);
  xhr.timeout = 15000;
  return new Promise((resolve) => {
    xhr.onload = () => resolve(null);
    xhr.ontimeout = () => resolve(null);
    xhr.onerror = () => {
      try {
        resolve(xhr.channel?.securityInfo?.serverCert ?? null);
      } catch {
        resolve(null);
      }
    };
    xhr.send();
  });
}

/** Prepares a request to `u`: adds or removes the certificate exception according to `allowInvalid`. */
export async function prepareTls(u: URL, allowInvalid: boolean): Promise<void> {
  if (u.protocol !== 'https:') return;
  const port = Number(u.port) || 443;
  const key = `${u.hostname}:${port}`;
  if (!allowInvalid) {
    if (overridden.delete(key)) overrideService()?.clearValidityOverride(u.hostname, port, {});
    return;
  }
  if (overridden.has(key)) return;
  const svc = overrideService();
  if (!svc) return;
  const cert = await failingServerCert(u.origin);
  if (!cert) return;
  try {
    svc.rememberValidityOverride(u.hostname, port, {}, cert, true);
  } catch {
    // Older Gecko: (host, port, originAttributes, cert, overrideBits, temporary).
    svc.rememberValidityOverride(u.hostname, port, {}, cert, 7, true);
  }
  overridden.add(key);
  L.warn(`accepting the invalid certificate of ${key} for this session ("Accept invalid certificate" is on)`);
}
