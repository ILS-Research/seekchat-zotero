/**
 * https chat servers whose certificate the system does not trust: SeekChat lets a request through only when the user
 * trusted exactly this certificate (SHA-256) for this host and port (certs.ts, decided in the settings dialog). Then
 * it adds a certificate exception for that certificate in Firefox's override service, until Zotero restarts. A
 * certificate that is not trusted, or a new one on the same server, stops the request with a message pointing to the
 * settings.
 *
 * Migration: who had switched on the old "Accept invalid certificate" gets the server's current certificate entered
 * as trusted once (visible in the list), then the old setting is cleared.
 */
import { t } from '../i18n';
import { getPref, setPref } from '../prefs';
import { logger } from '../util/log';
import { findCert, probeCertificate, readCerts, upsertCert, writeCerts, type CertInfo } from './certs';
import { UserFacingError } from './errors';

const L = logger('TLS');

/** host:port checked in this session (valid, or trusted and excepted). */
const checked = new Set<string>();
/** host:port with an exception added by SeekChat in this session. */
const excepted = new Set<string>();

function overrideService(): any {
  try {
    const Cc = (globalThis as any).Cc ?? (globalThis as any).Components?.classes ?? Zotero.getMainWindow()?.Cc;
    const Ci = (globalThis as any).Ci ?? (globalThis as any).Components?.interfaces ?? Zotero.getMainWindow()?.Ci;
    return Cc['@mozilla.org/security/certoverride;1'].getService(Ci.nsICertOverrideService);
  } catch {
    return null;
  }
}

/** Adds the certificate exception for `cert` on host:port (until Zotero restarts). */
export function addException(host: string, port: number, cert: any): void {
  const svc = overrideService();
  if (!svc) return;
  try {
    svc.rememberValidityOverride(host, port, {}, cert, true);
  } catch {
    // Older Gecko: (host, port, originAttributes, cert, overrideBits, temporary).
    svc.rememberValidityOverride(host, port, {}, cert, 7, true);
  }
  excepted.add(`${host}:${port}`);
}

/** Takes back SeekChat's exception for host:port and forgets the check (after "not trusted" or removal). */
export function forgetServer(host: string, port: number): void {
  const key = `${host}:${port}`;
  checked.delete(key);
  if (excepted.delete(key)) overrideService()?.clearValidityOverride(host, port, {});
}

/** Forgets every check of this session (the next request checks again). */
export function resetTlsChecks(): void {
  checked.clear();
}

/** The user's decision for a certificate: stored in the list, applied at once. */
export function decideCertificate(info: CertInfo, cert: any, trusted: boolean): void {
  writeCerts(upsertCert(readCerts(), info, trusted));
  forgetServer(info.host, info.port);
  if (trusted && cert) {
    addException(info.host, info.port, cert);
    checked.add(`${info.host}:${info.port}`);
  }
}

/** Before a request to `u`: lets it through or throws a UserFacingError that says what to do. */
export async function prepareTls(u: URL): Promise<void> {
  if (u.protocol !== 'https:') return;
  const port = Number(u.port) || 443;
  const key = `${u.hostname}:${port}`;
  if (checked.has(key)) return;
  const probe = await probeCertificate(u);
  if (probe.state === 'unreachable') return; // the request itself reports the connection error
  if (probe.state === 'valid') {
    checked.add(key);
    return;
  }
  const { info, cert } = probe;
  let entry = findCert(readCerts(), info);
  if (!entry && getPref('allowInvalidCerts') === true) {
    writeCerts(upsertCert(readCerts(), info, true));
    setPref('allowInvalidCerts', false);
    entry = findCert(readCerts(), info);
    L.warn(`old setting "Accept invalid certificate": certificate of ${key} (${info.sha256}) entered as trusted`);
  }
  if (entry?.trusted) {
    addException(u.hostname, port, cert);
    checked.add(key);
    L.info(`certificate of ${key} trusted by the user (${info.sha256})`);
    return;
  }
  throw new UserFacingError(t(entry ? 'cert.refused' : 'cert.unknown', { host: key }));
}
