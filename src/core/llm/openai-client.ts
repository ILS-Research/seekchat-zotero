import { readLines, request } from './http';
import { parseSseLine } from './stream-parsers';
import type { ChatRequest, ClientConfig, LlmClient } from './types';

/** Any OpenAI-compatible server (vLLM, llama.cpp, LM Studio, LiteLLM, Ollama /v1, own FastAPI). */
export class OpenAiClient implements LlmClient {
  constructor(private cfg: ClientConfig) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.cfg, '/models', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.data || []).map((m: any) => String(m.id)).sort();
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    const resp = await request(this.cfg, '/chat/completions', {
      method: 'POST',
      signal: req.signal,
      body: {
        model: req.model,
        messages: req.messages,
        stream: true,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      },
    });
    let full = '';
    await readLines(resp, (line) => {
      const ev = parseSseLine(line);
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
