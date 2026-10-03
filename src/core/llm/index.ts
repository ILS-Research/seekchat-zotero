import { logger } from '../../util/log';
import { parseAllowedHosts } from '../host-guard';
import type { SeekChatPrefs } from '../../prefs';
import { OllamaClient } from './ollama-client';
import { OpenAiClient } from './openai-client';
import type { LlmClient } from './types';

export function createClient(prefs: Pick<SeekChatPrefs, 'provider' | 'baseUrl' | 'apiKey' | 'allowedRemoteHosts'> & Partial<Pick<SeekChatPrefs, 'allowInvalidCerts'>>): LlmClient {
  if (!prefs.baseUrl) throw new Error('No chat server configured (SeekChat settings).');
  const cfg = {
    baseUrl: prefs.baseUrl,
    apiKey: prefs.apiKey || undefined,
    allowedRemoteHosts: parseAllowedHosts(prefs.allowedRemoteHosts),
    allowInvalidCerts: !!prefs.allowInvalidCerts,
  };
  return logged(prefs.provider === 'openai' ? new OpenAiClient(cfg) : new OllamaClient(cfg));
}

const L = logger('LLM');

/** Logs each chat call: model, prompt size, time to first token, total time, answer size. */
function logged(client: LlmClient): LlmClient {
  return {
    listModels: (signal) => client.listModels(signal),
    modelInfo: (model, signal) => client.modelInfo(model, signal),
    async streamChat(req, onDelta) {
      return (await this.streamTurn(req, onDelta)).text;
    },
    async streamTurn(req, onDelta) {
      const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
      const t0 = Date.now();
      let first = 0;
      L.info(`→ ${req.model}: ${req.messages.length} messages, ${chars} chars, maxTokens ${req.maxTokens}, think ${req.think ?? "default"}${req.tools?.length ? `, tools ${req.tools.map((x) => x.name).join(',')}` : ''}`);
      try {
        const out = await client.streamTurn(req, (d) => {
          if (!first) first = Date.now() - t0;
          onDelta(d);
        });
        L.info(`← ${req.model}: ${out.text.length} chars${out.toolCalls.length ? `, tool calls ${out.toolCalls.map((c) => c.name).join(',')}` : ''}, first token after ${first} ms, done in ${Date.now() - t0} ms`);
        return out;
      } catch (e: any) {
        L.warn(`✗ ${req.model} after ${Date.now() - t0} ms: ${e?.message || e}`);
        throw e;
      }
    },
  };
}

export type { ChatMessage, ChatResult, LlmClient, ToolCall, ToolSpec } from './types';
