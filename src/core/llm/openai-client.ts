import { HttpError, readLines, request } from './http';
import { probeOllama } from './ollama-probe';
import { openAiMessages, parseSseLine, ToolCallAccumulator, toolsPayload } from './stream-parsers';
import type { ChatRequest, ChatResult, ClientConfig, LlmClient, ModelInfo } from './types';

/**
 * Servers that refused the thinking switch (a model without thinking, a strict server), per server and model: asked
 * without it from then on. Module-wide, since a new client is made for nearly every question.
 */
const noThink = new Set<string>();

/**
 * The base of the OpenAI interface: a bare server ("https://host", Ollama's usual entry) gets /v1; a URL with a path
 * ("https://host/v1", "https://proxy/openai/v1") is taken as it is.
 */
export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    return new URL(trimmed).pathname.replace(/\/+$/, '') ? trimmed : `${trimmed}/v1`;
  } catch {
    return trimmed;
  }
}

/** Short wait before repeating a request after a server error; ends early when the request is cancelled. */
export const RETRY_DELAY_MS = 1000;

function serverPause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const z = (globalThis as any).Zotero;
    const done = () => resolve();
    signal?.addEventListener('abort', done, { once: true });
    if (typeof setTimeout === 'function') setTimeout(done, RETRY_DELAY_MS);
    else if (z?.Promise?.delay) void z.Promise.delay(RETRY_DELAY_MS).then(done);
    else done();
  });
}

/**
 * Thinking on or off, as the common servers understand it: Ollama `reasoning_effort` ("none" switches it off),
 * vLLM/SGLang `chat_template_kwargs.enable_thinking` (Qwen3 and similar templates). Undefined: the server decides.
 */
export function thinkingFields(think: boolean | undefined): object {
  if (think === undefined) return {};
  return think
    ? { chat_template_kwargs: { enable_thinking: true } }
    : { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
}

/**
 * The model server through its OpenAI-compatible interface only (Ollama /v1, vLLM, llama.cpp, LM Studio, LiteLLM,
 * own FastAPI). SeekChat never sends a context size; the window comes from /v1/models (vLLM max_model_len) or, for
 * Ollama, from its native API read-only (ollama-probe.ts).
 */
export class OpenAiClient implements LlmClient {
  private api: ClientConfig;

  constructor(private cfg: ClientConfig) {
    this.api = { ...cfg, baseUrl: apiBase(cfg.baseUrl) };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.api, '/models', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.data || []).map((m: any) => String(m.id)).sort();
  }

  /**
   * /v1/models: vLLM reports max_model_len (the window it serves), some servers context_length/context_window.
   * When it says nothing, Ollama's native API is asked (ollama-probe.ts).
   */
  async modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo> {
    const resp = await request(this.api, '/models', { method: 'GET', signal });
    const entry = ((await resp.json()).data || []).find((m: any) => m.id === model) || {};
    const n = [entry.max_model_len, entry.context_length, entry.context_window].find((v) => typeof v === 'number' && v > 0);
    if (n) return { configuredContext: n };
    return (await probeOllama(this.cfg, model, signal)) || {};
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    return (await this.streamTurn(req, onDelta)).text;
  }

  async streamTurn(req: ChatRequest, onDelta: (text: string) => void, retried = false): Promise<ChatResult> {
    const thinkKey = `${this.api.baseUrl}|${req.model}`;
    const thinking = noThink.has(thinkKey) ? {} : thinkingFields(req.think);
    let resp: Response;
    try {
      resp = await request(this.api, '/chat/completions', {
        method: 'POST',
        signal: req.signal,
        body: {
          model: req.model,
          messages: openAiMessages(req.messages),
          ...toolsPayload(req.tools),
          stream: true,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          ...thinking,
        },
      });
    } catch (e: any) {
      // HTTP 5xx before anything was streamed: once more. Ollama answers 500 when it cannot parse a tool call the model
      // wrote ("XML syntax error … unexpected EOF"); a second sample usually comes out right.
      if (!retried && e instanceof HttpError && e.status >= 500 && !req.signal?.aborted) {
        await serverPause(req.signal);
        return this.streamTurn(req, onDelta, true);
      }
      // HTTP 400 about thinking/reasoning or the template fields: ask again without them. Other errors must not
      // switch thinking off for good.
      if (!Object.keys(thinking).length || !(e instanceof HttpError && e.status === 400)
        || !/think|reason|chat_template_kwargs/i.test(e.message)) throw e;
      noThink.add(thinkKey);
      return this.streamTurn(req, onDelta, retried);
    }
    let full = '';
    const calls = new ToolCallAccumulator();
    await readLines(resp, (line) => {
      const ev = parseSseLine(line);
      if (!ev) return;
      if (ev.error) throw new Error(ev.error);
      if (ev.delta) {
        full += ev.delta;
        onDelta(ev.delta);
      }
      if (ev.toolDeltas) calls.push(ev.toolDeltas);
      if (ev.done) return false;
    });
    return { text: full, toolCalls: calls.result() };
  }
}
