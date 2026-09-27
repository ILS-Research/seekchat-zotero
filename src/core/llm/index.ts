import { parseAllowedHosts } from '../host-guard';
import type { SeekChatPrefs } from '../../prefs';
import { OllamaClient } from './ollama-client';
import { OpenAiClient } from './openai-client';
import type { LlmClient } from './types';

export function createClient(prefs: Pick<SeekChatPrefs, 'provider' | 'baseUrl' | 'apiKey' | 'allowedRemoteHosts'>): LlmClient {
  if (!prefs.baseUrl) throw new Error('No chat server configured (SeekChat settings).');
  const cfg = {
    baseUrl: prefs.baseUrl,
    apiKey: prefs.apiKey || undefined,
    allowedRemoteHosts: parseAllowedHosts(prefs.allowedRemoteHosts),
  };
  return prefs.provider === 'openai' ? new OpenAiClient(cfg) : new OllamaClient(cfg);
}

export type { ChatMessage, LlmClient } from './types';
