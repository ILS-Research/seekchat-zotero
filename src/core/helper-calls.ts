/**
 * Short model calls around an answer, shared by the PDF chat and the library pipeline: the document's
 * language, search terms for the question, and a client that records every request into the answer
 * (for the Markdown export).
 */
import { buildKeywordMessages, parseKeywords } from './context/keywords';
import {
  buildLanguageMessages, guessLanguage, normalizeLanguage, parseLanguageReply,
  type Language, type LanguageSource,
} from './context/language';
import type { ContextProvider } from './context/types';
import type { LlmClient } from './llm/types';
import type { SeekChatPrefs } from '../prefs';
import type { Turn } from './turn';
import { logError, logger } from '../util/log';

const L = logger('Chat');

/** Detected language per provider key (metadata is read every time and not cached). */
export type LanguageCache = Map<string, { lang: Language | null; source: LanguageSource | null }>;

/**
 * Language of the document: the item's "Language" field, else a short model
 * call on the first pages, else a local stopword guess. Resolved once.
 */
export async function resolveLanguage(
  cache: LanguageCache,
  provider: ContextProvider,
  client: LlmClient,
  prefs: SeekChatPrefs,
  signal: AbortSignal,
): Promise<{ lang: Language | null; source: LanguageSource | null }> {
  // Metadata is read every time, so a language entered later applies at once;
  // only the detected language is cached.
  const fromMetadata = normalizeLanguage(provider.metadataLanguage());
  if (fromMetadata) return { lang: fromMetadata, source: 'metadata' };
  const cached = cache.get(provider.key);
  if (cached) return cached;
  const remember = (v: { lang: Language | null; source: LanguageSource | null }) => {
    cache.set(provider.key, v);
    return v;
  };
  const sample = await provider.sampleText(3000);
  try {
    const reply = await client.streamChat(
      { model: prefs.model, messages: buildLanguageMessages(sample), temperature: 0, maxTokens: 64, numCtx: prefs.numCtx, think: false, signal },
      () => {},
    );
    const fromModel = parseLanguageReply(reply);
    if (fromModel) return remember({ lang: fromModel, source: 'model' });
  } catch (e) {
    if (signal.aborted) throw e;
    logError(e);
  }
  const guessed = guessLanguage(sample);
  return remember({ lang: guessed, source: guessed ? 'guess' : null });
}

/** Strategy "keywords": one short, low-temperature model call that expands the question into search terms. */
export async function expandKeywords(
  provider: ContextProvider,
  client: LlmClient,
  prefs: SeekChatPrefs,
  question: string,
  previousQuestion: string,
  language: Language | null,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const reply = await client.streamChat(
      {
        model: prefs.model,
        messages: buildKeywordMessages({ question, previousQuestion, docTitle: provider.describe(), language }),
        temperature: 0.2,
        maxTokens: 512,
        numCtx: prefs.numCtx,
        think: false,
        signal,
      },
      () => {},
    );
    return parseKeywords(reply);
  } catch (e) {
    if (signal.aborted) throw e;
    // The answer still works with the question alone; the meta line tells the user.
    logError(e);
    return [];
  }
}

/** Model client that records each request into the answer turn. */
export function recordingClient(client: LlmClient, answer: Turn, purpose: () => string): LlmClient {
  return {
    listModels: (signal) => client.listModels(signal),
    modelInfo: (model, signal) => client.modelInfo(model, signal),
    streamChat: (req, onDelta) => {
      const why = purpose();
      L.info(`model call: ${why}`);
      (answer.requests ??= []).push({
        purpose: why,
        model: req.model,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        numCtx: req.numCtx,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return client.streamChat(req, onDelta);
    },
  };
}

