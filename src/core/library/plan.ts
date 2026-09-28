/**
 * Step 1 of a library question: one short model call turns the question (plus
 * the chat so far) into a standalone question and 1–3 queries for ZotSeek's
 * semantic search. Books make their own search terms, in their language, like
 * the PDF chat. The reply is JSON; if it cannot be read, the question is used as it is.
 */
import type { ChatMessage } from '../llm/types';
import { stripThinking } from '../llm/stream-parsers';
import type { HistoryTurn } from '../prompt';

export const MAX_QUERIES = 3;
/** Earlier answers are shortened to this many characters in the planning prompt. */
const ANSWER_CHARS = 600;

export interface SearchPlan {
  /** The question rewritten to stand on its own (follow-ups resolved). */
  question: string;
  /** Queries for ZotSeek (semantic search), 1–3. */
  queries: string[];
  /** False if the model's reply was unusable and the plan is the fallback. */
  fromModel: boolean;
}

export function fallbackPlan(question: string): SearchPlan {
  return { question, queries: [question], fromModel: false };
}

export function buildPlanMessages(opts: { question: string; history: HistoryTurn[]; scope: string }): ChatMessage[] {
  const system =
    'You prepare a literature search in the user\'s Zotero library for a chat assistant. ' +
    'Given the conversation so far and the new question, answer only with a JSON object: ' +
    '{"question": "<the new question rewritten so that it can be understood without the conversation, in its language>", ' +
    `"queries": ["<1 to ${MAX_QUERIES} short queries for a semantic search, each covering one aspect>"]}. ` +
    'If the new question only asks to rework earlier answers (e.g. summarise, make a table, translate), ' +
    'still give queries for its topic. No explanation, only the JSON object.';
  const conversation = opts.history.map((h) => h.role === 'user'
    ? `User: ${h.content}`
    : `Assistant: ${h.content.length > ANSWER_CHARS ? h.content.slice(0, ANSWER_CHARS) + ' […]' : h.content}`).join('\n\n');
  // "/no_think" switches off Qwen 3's reasoning; other models read it as noise.
  const user = `Search scope: ${opts.scope}\n` +
    (conversation ? `Conversation so far:\n${conversation}\n\n` : '') +
    `New question: ${opts.question}\n/no_think`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean) : [];
}

/** Reads the model's JSON; anything missing is filled from the original question. */
export function parsePlan(reply: string, question: string): SearchPlan {
  const text = stripThinking(reply);
  const match = text.match(/\{[\s\S]*\}/);
  let json: any = null;
  if (match) {
    try {
      json = JSON.parse(match[0]);
    } catch {
      // unusable: fallback below
    }
  }
  if (!json || typeof json !== 'object') return fallbackPlan(question);
  const standalone = typeof json.question === 'string' && json.question.trim() ? json.question.trim() : question;
  const seen = new Set<string>();
  const queries = strings(json.queries).filter((q) => {
    const k = q.toLowerCase();
    if (seen.has(k) || q.length > 300) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_QUERIES);
  return { question: standalone, queries: queries.length ? queries : [standalone], fromModel: true };
}
