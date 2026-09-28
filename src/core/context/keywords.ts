/**
 * Strategy 2 for long documents: the model expands the question into search
 * terms (synonyms, related terms, both languages), which then drive the page
 * selection. Prompt building and parsing are pure and unit-tested.
 */
import type { ChatMessage } from '../llm/types';
import { stripThinking } from '../llm/stream-parsers';

export const MAX_KEYWORDS = 20;

export function buildKeywordMessages(opts: {
  question: string;
  previousQuestion?: string;
  docTitle: string;
  /** Language of the document; keywords are generated in it only. Null: English and German. */
  language?: { name: string } | null;
}): ChatMessage[] {
  const system =
    'You generate search terms for a keyword search in a long scientific document. ' +
    'Return 8 to 15 terms: key terms of the question, synonyms, technical terms and related terms. ' +
    (opts.language
      ? `The document is in ${opts.language.name}: all terms only in ${opts.language.name}, as they would appear ` +
        'in the document; translate the question for this if necessary. '
      : 'Each in English and German. ') +
    'Single words or short phrases, no sentences. ' +
    'Answer only with a JSON array of strings, e.g. ["heavy rain", "flooding", "precipitation"].';
  const context = opts.previousQuestion ? `Previous question (context): ${opts.previousQuestion}\n` : '';
  // "/no_think" switches off Qwen 3's reasoning; other models read it as noise.
  const user = `Document: ${opts.docTitle}\n${context}Question: ${opts.question}\n/no_think`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Extracts keywords from a model reply: a JSON array if present, else lines or commas. */
export function parseKeywords(reply: string): string[] {
  const text = stripThinking(reply).trim();
  let items: unknown[] = [];
  const json = text.match(/\[[\s\S]*\]/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // not valid JSON, fall through to the line/comma split
    }
  }
  if (!items.length) items = text.split(/[\n,;]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const k = raw.replace(/^[\s\-*•\d.)"'„“]+|["'“”.]+$/g, '').trim();
    if (k.length < 3 || k.length > 60 || k.split(/\s+/).length > 4) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}
