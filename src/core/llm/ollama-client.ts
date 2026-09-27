import { readLines, request } from './http';
import { parseOllamaLine } from './stream-parsers';
import type { ChatRequest, ClientConfig, LlmClient } from './types';

/** Ollama's native API: lets us set num_ctx, which the /v1 endpoint cannot. */
export class OllamaClient implements LlmClient {
  constructor(private cfg: ClientConfig) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.cfg, '/api/tags', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.models || []).map((m: any) => String(m.name)).sort();
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
