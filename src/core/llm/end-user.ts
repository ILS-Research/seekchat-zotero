/** `end_user` in the chat body, for the usage statistics of the ILS model server (ollama.ils.local only). */
export const STATS_HOST = 'ollama.ils.local';

/** True when the endpoint is the ILS model server; only then the option "send user name" applies. */
export function isStatsHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase() === STATS_HOST;
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The Zotero account name (sync login), empty when nobody is logged in. */
export function currentUserName(): string {
  try {
    return String((globalThis as any).Zotero?.Users?.getCurrentUsername?.() || '').trim();
  } catch {
    return '';
  }
}

/** The name in plain text, or its SHA-256 hash when `plain` is off; undefined without a name. */
export async function endUserValue(name: string, plain: boolean): Promise<string | undefined> {
  const n = name.trim();
  if (!n) return undefined;
  return plain ? n : sha256Hex(n.toLowerCase());
}
