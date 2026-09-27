/**
 * Strategy 2 for long documents: the model expands the question into search
 * terms (synonyms, related terms, both languages), which then drive the page
 * selection. Prompt building and parsing are pure and unit-tested.
 */
import type { ChatMessage } from '../llm/types';
import { stripThinking } from '../llm/stream-parsers';

export const MAX_KEYWORDS = 20;

export function buildKeywordMessages(opts: { question: string; previousQuestion?: string; docTitle: string }): ChatMessage[] {
  const system =
    'Du erzeugst Suchbegriffe für eine Stichwortsuche in einem langen wissenschaftlichen Dokument. ' +
    'Gib 8 bis 15 Begriffe zurück: zentrale Begriffe der Frage, Synonyme, Fachbegriffe, verwandte Begriffe ' +
    'und Übersetzungen (Deutsch und Englisch). Einzelwörter oder kurze Wortgruppen, keine Sätze. ' +
    'Antworte nur mit einem JSON-Array von Strings, z. B. ["Starkregen", "heavy rainfall", "Überflutung"].';
  const context = opts.previousQuestion ? `Vorherige Frage (Kontext): ${opts.previousQuestion}\n` : '';
  // "/no_think" switches off Qwen 3's reasoning; other models read it as noise.
  const user = `Dokument: ${opts.docTitle}\n${context}Frage: ${opts.question}\n/no_think`;
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
