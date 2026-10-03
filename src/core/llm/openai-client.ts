import { readLines, request } from './http';
import { openAiMessages, parseSseLine, ToolCallAccumulator, toolsPayload } from './stream-parsers';
import type { ChatRequest, ChatResult, ClientConfig, LlmClient, ModelInfo } from './types';

/** Any OpenAI-compatible server (vLLM, llama.cpp, LM Studio, LiteLLM, Ollama /v1, own FastAPI). */
export class OpenAiClient implements LlmClient {
  constructor(private cfg: ClientConfig) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const resp = await request(this.cfg, '/models', { method: 'GET', signal });
    const json: any = await resp.json();
    return (json.data || []).map((m: any) => String(m.id)).sort();
  }

  /** /models: vLLM reports max_model_len, some servers context_length/context_window. */
  async modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo> {
    const resp = await request(this.cfg, '/models', { method: 'GET', signal });
    const entry = ((await resp.json()).data || []).find((m: any) => m.id === model) || {};
    const n = [entry.max_model_len, entry.context_length, entry.context_window].find((v) => typeof v === 'number' && v > 0);
    return n ? { configuredContext: n } : {};
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string> {
    return (await this.streamTurn(req, onDelta)).text;
  }

  async streamTurn(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult> {
    const resp = await request(this.cfg, '/chat/completions', {
      method: 'POST',
      signal: req.signal,
      body: {
        model: req.model,
        messages: openAiMessages(req.messages),
        ...toolsPayload(req.tools),
        stream: true,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
      },
    });
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
