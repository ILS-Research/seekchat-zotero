/**
 * Certificates of https chat servers that the system does not trust (self-signed, unknown CA, expired, other name).
 * The user decides per certificate in a dialog (settings); the decision and the certificate itself (DER, base64) are
 * kept in the pref `seekchat.certificates` (JSON list), where each entry can be switched between trusted and not
 * trusted. Only a trusted certificate with exactly this SHA-256 fingerprint is accepted for its host and port
 * (pinning): a different certificate on the same server asks again.
 *
 * The list functions are pure (unit-tested); probing a server needs Zotero.
 */
import { getPref, setPref } from '../prefs';

export interface CertInfo {
  host: string;
  port: number;
  /** SHA-256 fingerprint, upper case hex with colons (as Firefox shows it). */
  sha256: string;
  subject: string;
  commonName: string;
  issuer: string;
  /** Validity, ISO dates. */
  notBefore: string;
  notAfter: string;
  /** The certificate itself, DER as base64. */
  der: string;
  /** Why the system does not trust it (NSS error name), if known. */
  error?: string;
}

export interface StoredCert extends CertInfo {
  trusted: boolean;
  /** When the user decided, ISO date. */
  decided: string;
}

const PREF = 'certificates';

/** Pure: the stored list from the pref text; broken or foreign entries are left out. */
export function parseCertList(raw: unknown): StoredCert[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((c) => c && typeof c.host === 'string' && typeof c.sha256 === 'string' && Number(c.port) > 0)
        .map((c) => ({ ...c, port: Number(c.port), trusted: c.trusted === true }))
      : [];
  } catch {
    return [];
  }
}

export function readCerts(): StoredCert[] {
  return parseCertList(getPref(PREF));
}

export function writeCerts(list: StoredCert[]): void {
  setPref(PREF, JSON.stringify(list));
}

const sameCert = (a: Pick<CertInfo, 'host' | 'port' | 'sha256'>, b: Pick<CertInfo, 'host' | 'port' | 'sha256'>) =>
  a.host === b.host && a.port === b.port && a.sha256.toUpperCase() === b.sha256.toUpperCase();

/** Pure: the entry for this certificate on this host and port, if any. */
export function findCert(list: StoredCert[], cert: Pick<CertInfo, 'host' | 'port' | 'sha256'>): StoredCert | undefined {
  return list.find((c) => sameCert(c, cert));
}

/** Pure: the list with this certificate added or its decision changed. */
export function upsertCert(list: StoredCert[], cert: CertInfo, trusted: boolean, now = new Date()): StoredCert[] {
  const entry: StoredCert = { ...cert, trusted, decided: now.toISOString() };
  const i = list.findIndex((c) => sameCert(c, cert));
  return i < 0 ? [...list, entry] : list.map((c, k) => (k === i ? entry : c));
}

/** Pure: the list without this certificate. */
export function removeCert(list: StoredCert[], cert: Pick<CertInfo, 'host' | 'port' | 'sha256'>): StoredCert[] {
  return list.filter((c) => !sameCert(c, cert));
}

/** Pure: the certificate in PEM form (for viewing and saving). */
export function toPem(derBase64: string): string {
  const lines = derBase64.replace(/\s+/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** NSS time (microseconds) as ISO date. */
const isoDate = (prTime: number) => (prTime ? new Date(prTime / 1000).toISOString().slice(0, 10) : '');

/** What SeekChat keeps of an nsIX509Cert. */
export function certInfoOf(cert: any, host: string, port: number, error?: string): CertInfo {
  return {
    host,
    port,
    sha256: String(cert.sha256Fingerprint || '').toUpperCase(),
    subject: String(cert.subjectName || ''),
    commonName: String(cert.commonName || ''),
    issuer: String(cert.issuerName || cert.issuerCommonName || ''),
    notBefore: isoDate(Number(cert.validity?.notBefore || 0)),
    notAfter: isoDate(Number(cert.validity?.notAfter || 0)),
    der: String(cert.getBase64DERString?.() || ''),
    ...(error ? { error } : {}),
  };
}

export type ProbeResult =
  /** The system trusts the certificate (or the URL is not https). */
  | { state: 'valid' }
  /** No answer at all (server down, wrong address). */
  | { state: 'unreachable' }
  /** The system does not trust it; `cert` is the nsIX509Cert, `info` what is kept of it. */
  | { state: 'invalid'; cert: any; info: CertInfo };

/**
 * Asks the server once (HEAD /) and tells whether its certificate passes the system's check. A certificate exception
 * SeekChat added earlier in this session counts as passing.
 */
export function probeCertificate(u: URL): Promise<ProbeResult> {
  if (u.protocol !== 'https:') return Promise.resolve({ state: 'valid' });
  const port = Number(u.port) || 443;
  const win = Zotero.getMainWindow();
  const xhr = new win.XMLHttpRequest();
  xhr.open('HEAD', `${u.origin}/`);
  xhr.timeout = 15000;
  return new Promise((resolve) => {
    xhr.onload = () => resolve({ state: 'valid' });
    xhr.ontimeout = () => resolve({ state: 'unreachable' });
    xhr.onerror = () => {
      try {
        const sec = xhr.channel?.securityInfo;
        const cert = sec?.serverCert;
        if (!cert) return resolve({ state: 'unreachable' });
        resolve({ state: 'invalid', cert, info: certInfoOf(cert, u.hostname, port, sec?.errorCodeString || undefined) });
      } catch {
        resolve({ state: 'unreachable' });
      }
    };
    xhr.send();
  });
}
