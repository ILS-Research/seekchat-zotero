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

/** 7e-2: pages of a known source to load again (the chat history holds answers, not the book texts). */
export interface PageRequest {
  /** Citation number of a source from earlier answers. */
  source: number;
  /** 1-based physical pages, sorted, at most MAX_PAGES_PER_REQUEST. */
  pages: number[];
}

/** 7e-2: a document the user names, searched with ZotSeek within that document only. */
export interface DocumentRequest {
  /** Citation number of a known source, or a title to look up in the scope. */
  source?: number;
  title?: string;
  query: string;
}

export const MAX_PAGES_PER_REQUEST = 10;
export const MAX_LOAD_REQUESTS = 3;

/** A known source the planner may refer to. */
export interface KnownSource {
  n: number;
  label: string;
  book: boolean;
}

export interface SearchPlan {
  /** The question rewritten to stand on its own (follow-ups resolved). */
  question: string;
  /** Queries for ZotSeek (semantic search), 1–3. */
  queries: string[];
  /** False if the model's reply was unusable and the plan is the fallback. */
  fromModel: boolean;
  /** Follow-ups: pages to load from known sources, documents to search in. */
  loadPages?: PageRequest[];
  loadDocuments?: DocumentRequest[];
}

export function fallbackPlan(question: string): SearchPlan {
  return { question, queries: [question], fromModel: false };
}

export function buildPlanMessages(opts: { question: string; history: HistoryTurn[]; scope: string; sources?: KnownSource[] }): ChatMessage[] {
  const loading = opts.sources ? ' ' +
    'The conversation shows only answers, not the texts of the sources. If the new question refers to specific pages ' +
    'of a source (e.g. "what is on page 45", "read pages 10-12 of the book", "look at that passage in more detail"), add ' +
    `"load_pages": [{"source": <number of the source below>, "pages": "<pages, e.g. 45 or 10-12>"}] (at most ${MAX_PAGES_PER_REQUEST} pages each). ` +
    'If it asks about one specific document (by number, author or title), add "load_documents": [{"source": <number>, ' +
    '"query": "<what to look for in it>"}], or {"title": "<title or author as named>", "query": "..."} for a document not in ' +
    `the list. At most ${MAX_LOAD_REQUESTS} entries each; leave both out when the question does not ask for specific pages ` +
    'or documents.' : '';
  const system =
    'You prepare a literature search in the user\'s Zotero library for a chat assistant. ' +
    'Given the conversation so far and the new question, answer only with a JSON object: ' +
    '{"question": "<the new question rewritten so that it can be understood without the conversation, in its language>", ' +
    `"queries": ["<1 to ${MAX_QUERIES} short queries for a semantic search, each covering one aspect>"]}. ` +
    'If the new question only asks to rework earlier answers (e.g. summarise, make a table, translate), ' +
    'still give queries for its topic.' + loading + ' No explanation, only the JSON object.';
  const known = opts.sources?.length
    ? 'Sources so far:\n' + opts.sources.map((s) => `[${s.n}] ${s.label}${s.book ? ' (book)' : ''}`).join('\n') + '\n\n' : '';
  const conversation = opts.history.map((h) => h.role === 'user'
    ? `User: ${h.content}`
    : `Assistant: ${h.content.length > ANSWER_CHARS ? h.content.slice(0, ANSWER_CHARS) + ' […]' : h.content}`).join('\n\n');
  // "/no_think" switches off Qwen 3's reasoning; other models read it as noise.
  const user = `Search scope: ${opts.scope}\n` + known +
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

/** "45", "10-12", "10–12, 14", [3, 4] -> sorted unique pages, capped. */
export function parsePageSpec(spec: unknown): number[] {
  const parts = Array.isArray(spec) ? spec.map(String) : typeof spec === 'number' ? [String(spec)] : typeof spec === 'string' ? spec.split(/[,;]/) : [];
  const pages = new Set<number>();
  for (const part of parts) {
    const m = part.match(/(\d+)\s*(?:[-–]\s*(\d+))?/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let p = from; p <= to && p - from < MAX_PAGES_PER_REQUEST; p++) if (p >= 1) pages.add(p);
  }
  return Array.from(pages).sort((a, b) => a - b).slice(0, MAX_PAGES_PER_REQUEST);
}

/** Reads the model's JSON; anything missing is filled from the original question. */
export function parsePlan(reply: string, question: string, known?: Set<number>): SearchPlan {
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
  const plan: SearchPlan = { question: standalone, queries: queries.length ? queries : [standalone], fromModel: true };
  if (known) {
    const isKnown = (n: unknown): n is number => typeof n === 'number' && known.has(n);
    const loadPages = (Array.isArray(json.load_pages) ? json.load_pages : [])
      .filter((r: any) => r && isKnown(r.source))
      .map((r: any) => ({ source: r.source, pages: parsePageSpec(r.pages) }))
      .filter((r: PageRequest) => r.pages.length)
      .slice(0, MAX_LOAD_REQUESTS);
    const loadDocuments = (Array.isArray(json.load_documents) ? json.load_documents : [])
      .filter((r: any) => r && (isKnown(r.source) || (typeof r.title === 'string' && r.title.trim())))
      .map((r: any) => ({
        ...(isKnown(r.source) ? { source: r.source } : { title: String(r.title).trim() }),
        query: typeof r.query === 'string' && r.query.trim() ? r.query.trim() : standalone,
      }))
      .slice(0, MAX_LOAD_REQUESTS);
    if (loadPages.length) plan.loadPages = loadPages;
    if (loadDocuments.length) plan.loadDocuments = loadDocuments;
  }
  return plan;
}
