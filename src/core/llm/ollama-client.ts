import { readLines, request } from './http';
import { parseOllamaLine } from './stream-parsers';
import type { ChatRequest, ClientConfig, LlmClient, ModelInfo } from './types';

/** Ollama's native API: lets us set num_ctx, which the /v1 endpoint cannot. */
export class OllamaClient implements LlmClient {
  constructor(private cfg: ClientConfig) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.cfg, '/api/tags', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.models || []).map((m: any) => String(m.name)).sort();
  }

  /** /api/show: num_ctx/num_predict from the Modelfile parameters, the model's own maximum from model_info. */
  async modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo> {
    const resp = await request(this.cfg, '/api/show', { method: 'POST', body: { model }, signal });
    return parseOllamaShow(await resp.json());
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const resp = await request(this.cfg, '/api/chat', {
      method: 'POST',
      signal: req.signal,
      body: {
        model: req.model,
        messages: req.messages,
        stream: true,
        options: {
          temperature: req.temperature,
          num_predict: req.maxTokens,
          ...(req.numCtx ? { num_ctx: req.numCtx } : {}),
        },
      },
    });
    let full = '';
    await readLines(resp, (line) => {
      const ev = parseOllamaLine(line);
      if (!ev) return;
      if (ev.error) throw new Error(ev.error);
      if (ev.delta) {
        full += ev.delta;
        onDelta(ev.delta);
      }
      if (ev.done) return false;
    });
    return full;
  }
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
