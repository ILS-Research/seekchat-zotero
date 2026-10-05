/**
 * The one Ollama-specific part left (user decision): Ollama's OpenAI interface does not tell the context window, so
 * the limits ask its native API read-only – /api/ps (window of the loaded model) and /api/show (Modelfile num_ctx,
 * num_predict, the model's maximum). Optional: other servers (vLLM, llama.cpp …) answer 404 and are left alone; chat,
 * models and tools always go through /v1 (openai-client.ts). Nothing here ever sends num_ctx.
 */
import { request } from './http';
import type { ClientConfig, ModelInfo } from './types';

/** The server root without the /v1 path of the OpenAI interface. */
export function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** What Ollama's native API says about `model`, or null when the server is not Ollama (or does not answer). */
export async function probeOllama(cfg: ClientConfig, model: string, signal?: AbortSignal): Promise<ModelInfo | null> {
  const root = { ...cfg, baseUrl: serverRoot(cfg.baseUrl) };
  let info: ModelInfo;
  try {
    const resp = await request(root, '/api/show', { method: 'POST', body: { model }, signal });
    info = parseOllamaShow(await resp.json());
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
  info.ollama = true;
  try {
    const ps = await request(root, '/api/ps', { method: 'GET', signal });
    info.loadedContext = parseOllamaPs(await ps.json(), model);
  } catch {
    // not loaded or older server: the Modelfile or Ollama's default decides
  }
  return info;
}

/** Pure: context_length of `model` in /api/ps (names with and without ":latest" match). */
export function parseOllamaPs(json: any, model: string): number | undefined {
  const norm = (n: string) => String(n || '').replace(/:latest$/, '');
  const entry = (json?.models || []).find((m: any) => norm(m.name) === norm(model) || norm(m.model) === norm(model));
  const n = Number(entry?.context_length);
  return n > 0 ? n : undefined;
}

/** Pure parser for /api/show (unit-tested). */
export function parseOllamaShow(json: any): ModelInfo {
  const info: ModelInfo = {};
  const param = (name: string) => {
    const m = String(json?.parameters || '').match(new RegExp(`^${name}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : undefined;
  };
  info.configuredContext = param('num_ctx');
  info.numPredict = param('num_predict');
  for (const [k, v] of Object.entries(json?.model_info || {})) {
    if (/\.context_length$/.test(k) && !/rope|original/.test(k) && typeof v === 'number') info.maxContext = v;
  }
  return info;
}
