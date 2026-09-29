/** Typed access to extensions.zotero.seekchat.* (defaults in prefs.js). */

export type Provider = 'ollama' | 'openai';

export interface SeekChatPrefs {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  numCtx: number;
  maxTokens: number;
  contextChars: number;
  historyTurns: number;
  /** Let thinking models reason before answering (Ollama `think`); slower, off by default. Helper calls never think. */
  thinking: boolean;
  systemPrompt: string;
  allowedRemoteHosts: string;
  /** https server with a self-signed/expired/mismatching certificate: add an exception for the session. */
  allowInvalidCerts: boolean;
  /** "auto": limits from the model (minus 20 %); "manual": numCtx, maxTokens, contextChars as set. */
  limitsMode: 'auto' | 'manual';
  /** Library chat: passages requested from ZotSeek per question. */
  libraryTopK: number;
}

// Without the `global` flag Zotero prepends "extensions.zotero.", matching prefs.js.
const PREFIX = 'seekchat.';

export function getPref(key: string): any {
  return Zotero.Prefs.get(PREFIX + key);
}

export function setPref(key: string, value: string | number | boolean): void {
  Zotero.Prefs.set(PREFIX + key, value);
}

function int(key: string, fallback: number, min: number, max: number): number {
  const v = Number(getPref(key));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

function str(key: string): string {
  const v = getPref(key);
  return typeof v === 'string' ? v.trim() : '';
}

export function readPrefs(): SeekChatPrefs {
  return {
    provider: str('provider') === 'openai' ? 'openai' : 'ollama',
    baseUrl: str('baseUrl'),
    apiKey: str('apiKey'),
    model: str('model'),
    temperature: int('temperaturePercent', 20, 0, 200) / 100,
    numCtx: int('numCtx', 16384, 1024, 1048576),
    maxTokens: int('maxTokens', 2048, 64, 65536),
    contextChars: int('contextChars', 40000, 2000, 4000000),
    historyTurns: int('historyTurns', 4, 0, 50),
    thinking: getPref('thinking') === true,
    systemPrompt: str('systemPrompt'),
    allowedRemoteHosts: str('allowedRemoteHosts'),
    allowInvalidCerts: getPref('allowInvalidCerts') === true,
    libraryTopK: int('libraryTopK', 30, 1, 100),
    limitsMode: str('limitsMode') === 'manual' ? 'manual' : 'auto',
  };
}
