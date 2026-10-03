/**
 * Token limits per question: the context window the server uses, answer length and the document text budget.
 * SeekChat never sends a context size (Ollama would reload the model for each other num_ctx); the budget
 * follows the server's own window.
 *
 * Mode "auto" (default), Ollama: the window of the loaded model (/api/ps), else num_ctx from the Modelfile,
 * else Ollama's default (4096) – never the model's maximum, which Ollama does not use unasked. OpenAI-compatible:
 * the server's limit (vLLM max_model_len), else the model's maximum. Minus 20 % headroom. Mode "manual": the
 * values from the settings (the context window is then what the server is known to use).
 */
import { t } from '../i18n';
import { CHARS_PER_TOKEN } from './context/fit';
import { createClient } from './llm';
import type { ModelInfo } from './llm/types';
import type { SeekChatPrefs } from '../prefs';
import { logError } from '../util/log';

export interface Limits {
  /** Context window the budget is based on (not sent to the server). */
  numCtx: number;
  maxTokens: number;
  contextChars: number;
}

export interface ResolvedLimits extends Limits {
  source: 'auto' | 'manual' | 'fallback';
  /** For settings and meta line, e.g. "num_ctx 131072 aus der Modelldatei". */
  detail: string;
}

/** Share of the model's context actually used. */
export const HEADROOM = 0.8;
/** Tokens kept free for system prompt, history and question. */
const RESERVE_TOKENS = 1500;
const MAX_ANSWER_TOKENS = 12288;
/** Ollama's context window when neither the Modelfile nor the server environment sets one. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;

/** Pure: limits from a context size in tokens (unit-tested). */
export function limitsFromContext(context: number, numPredict?: number): Limits {
  const numCtx = Math.max(2048, Math.floor((context * HEADROOM) / 1024) * 1024);
  let maxTokens = Math.min(MAX_ANSWER_TOKENS, Math.floor(numCtx * 0.1));
  if (numPredict && numPredict > 0) maxTokens = Math.min(maxTokens, Math.floor(numPredict * HEADROOM));
  maxTokens = Math.max(256, maxTokens);
  const textTokens = Math.max(600, numCtx - maxTokens - RESERVE_TOKENS);
  const contextChars = Math.max(2000, Math.floor((textTokens * CHARS_PER_TOKEN) / 1000) * 1000);
  return { numCtx, maxTokens, contextChars };
}

export function describeSource(info: ModelInfo, provider: 'ollama' | 'openai' = 'openai'): { context?: number; detail: string } {
  if (provider === 'ollama') {
    if (info.loadedContext) return { context: info.loadedContext, detail: t('limits.loaded', { n: info.loadedContext }) };
    if (info.configuredContext) return { context: info.configuredContext, detail: t('limits.configured', { n: info.configuredContext }) };
    return { context: OLLAMA_DEFAULT_CONTEXT, detail: t('limits.ollamaDefault', { n: OLLAMA_DEFAULT_CONTEXT }) };
  }
  if (info.configuredContext) return { context: info.configuredContext, detail: t('limits.configured', { n: info.configuredContext }) };
  if (info.maxContext) return { context: info.maxContext, detail: t('limits.maximum', { n: info.maxContext }) };
  return { detail: t('limits.none') };
}

const cache = new Map<string, Promise<ModelInfo | null>>();

export function clearLimitsCache(): void {
  cache.clear();
}

function modelInfo(prefs: SeekChatPrefs): Promise<ModelInfo | null> {
  const key = `${prefs.provider}|${prefs.baseUrl}|${prefs.model}`;
  let p = cache.get(key);
  if (!p) {
    p = createClient(prefs).modelInfo(prefs.model).then((info) => {
      // Ollama's window is known once the model is loaded: ask again next time until it is.
      if (prefs.provider === 'ollama' && !info.loadedContext) cache.delete(key);
      return info;
    }, (e) => {
      logError(e);
      cache.delete(key);
      return null;
    });
    cache.set(key, p);
  }
  return p;
}

export function manualLimits(prefs: SeekChatPrefs): Limits {
  return { numCtx: prefs.numCtx, maxTokens: prefs.maxTokens, contextChars: prefs.contextChars };
}

export async function resolveLimits(prefs: SeekChatPrefs): Promise<ResolvedLimits> {
  if (prefs.limitsMode === 'manual') return { ...manualLimits(prefs), source: 'manual', detail: t('limits.manual') };
  if (!prefs.baseUrl || !prefs.model) {
    return { ...manualLimits(prefs), source: 'fallback', detail: t('limits.noModel') };
  }
  const info = await modelInfo(prefs);
  const { context, detail } = info ? describeSource(info, prefs.provider) : describeSource({});
  if (!context) return { ...manualLimits(prefs), source: 'fallback', detail: t('limits.fallback', { detail: info ? detail : t('limits.unreachable') }) };
  return { ...limitsFromContext(context, info?.numPredict), source: 'auto', detail: t('limits.share', { detail, percent: Math.round(HEADROOM * 100) }) };
}
