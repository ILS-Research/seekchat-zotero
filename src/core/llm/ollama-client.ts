import { HttpError, readLines, request } from './http';
import { ollamaMessages, parseOllamaLine, toolsPayload } from './stream-parsers';
import type { ChatRequest, ChatResult, ClientConfig, LlmClient, ModelInfo, ToolCall } from './types';

/**
 * Models that rejected the `think` field (not a thinking model), per server: asked without it from then on. Module-wide,
 * since a new client is made for nearly every question.
 */
const noThink = new Set<string>();

/**
 * Ollama's native API. SeekChat never sends num_ctx: every other value makes Ollama reload the model (seconds),
 * so the server's own context window is used and the text budget follows it (limits.ts).
 */
export class OllamaClient implements LlmClient {
  constructor(private cfg: ClientConfig) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.cfg, '/api/tags', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.models || []).map((m: any) => String(m.name)).sort();
  }

  /**
   * /api/show: num_ctx/num_predict from the Modelfile parameters, the model's own maximum from model_info;
   * /api/ps: the context window of the model if it is loaded (older servers do not report it).
   */
  async modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo> {
    const resp = await request(this.cfg, '/api/show', { method: 'POST', body: { model }, signal });
    const info = parseOllamaShow(await resp.json());
    try {
      const ps = await request(this.cfg, '/api/ps', { method: 'GET', signal });
      info.loadedContext = parseOllamaPs(await ps.json(), model);
    } catch {
      // not loaded or older server: the Modelfile or Ollama's default decides
    }
    return info;
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    return (await this.streamTurn(req, onDelta)).text;
  }

  async streamTurn(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult> {
    const thinkKey = `${this.cfg.baseUrl}|${req.model}`;
    const think = req.think !== undefined && !noThink.has(thinkKey) ? { think: req.think } : {};
    const body = {
      model: req.model,
      messages: ollamaMessages(req.messages),
      ...toolsPayload(req.tools),
      stream: true,
      ...think,
      options: {
        temperature: req.temperature,
        num_predict: req.maxTokens,
      },
    };
    let resp: Response;
    try {
      resp = await request(this.cfg, '/api/chat', { method: 'POST', signal: req.signal, body });
    } catch (e: any) {
      // HTTP 400 "… does not support thinking": ask again without the field. Other errors that merely mention
      // "think" (a model name like qwen3-thinking, a proxy message) must not switch thinking off for good.
      if (!('think' in think) || !(e instanceof HttpError && e.status === 400) || !/support[^\n]*think/i.test(e.message)) throw e;
      noThink.add(thinkKey);
      return this.streamTurn(req, onDelta);
    }
    let full = '';
    const toolCalls: ToolCall[] = [];
    await readLines(resp, (line) => {
      const ev = parseOllamaLine(line);
      if (!ev) return;
      if (ev.error) throw new Error(ev.error);
      if (ev.delta) {
        full += ev.delta;
        onDelta(ev.delta);
      }
      for (const c of ev.toolCalls || []) toolCalls.push({ ...c, id: c.id || `call_${toolCalls.length}` });
      if (ev.done) return false;
    });
    return { text: full, toolCalls };
  }
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
