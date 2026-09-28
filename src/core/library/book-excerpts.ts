/**
 * Pre-reading a book for the library chat: the model gets the book's best
 * matching pages and copies out what is relevant to the question, each
 * passage marked with its page. The passages then join the numbered sources
 * of the one answer. Prompt building and parsing are pure and unit-tested.
 */
import type { ChatMessage } from '../llm/types';
import { stripThinking } from '../llm/stream-parsers';
import { formatPages, isNoMatch, NO_MATCH_MARKER } from '../prompt';
import type { Page } from '../context/types';

export const MAX_EXCERPTS = 8;
/** Parsed passages shorter than this are noise (a stray heading, "…"). */
const MIN_CHARS = 20;

export interface BookExcerpt {
  page?: number;
  text: string;
}

export function buildExcerptMessages(opts: { question: string; book: string; pages: Page[]; totalPages: number }): ChatMessage[] {
  const system =
    'You pre-read a book for a research assistant who answers a question from several sources. ' +
    'From the pages of the book below, copy the passages that are relevant to the question: verbatim or closely ' +
    'paraphrased, each complete enough to be understood on its own (at most about 150 words). ' +
    `Give at most ${MAX_EXCERPTS} passages, the most relevant first. Start each passage on its own line with the page ` +
    'marker of the page it is on, exactly as in the document, e.g. [Page 12]. ' +
    `If the pages contain nothing relevant to the question, answer only with "${NO_MATCH_MARKER}". ` +
    'Do not answer the question yourself and add no introduction or commentary.\n\n' +
    `Book: ${opts.book} (${opts.pages.length} of ${opts.totalPages} pages, selected by keyword search)\n\n` +
    `<document>\n${formatPages(opts.pages)}\n</document>`;
  // "/no_think" switches off Qwen 3's reasoning; other models read it as noise.
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Question: ${opts.question}\n/no_think` },
  ];
}

const MARKER = /\[\s*(?:Page|Seite|S\.|p\.)\s*(\d+)\s*\]/gi;

/**
 * Passages from the model's reply. Page markers outside the pages that were
 * sent are dropped (the passage stays, without page); a reply without any
 * marker counts as one passage without page.
 */
export function parseExcerpts(reply: string, sentPages: number[]): BookExcerpt[] {
  const text = stripThinking(reply).trim();
  if (!text || isNoMatch(text)) return [];
  const allowed = new Set(sentPages);
  const marks = Array.from(text.matchAll(MARKER));
  const pieces: BookExcerpt[] = [];
  if (!marks.length) {
    pieces.push({ text });
  } else {
    marks.forEach((m, i) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index ?? text.length : text.length;
      const page = Number(m[1]);
      pieces.push({ page: allowed.has(page) ? page : undefined, text: text.slice(start, end) });
    });
  }
  return pieces
    .map((p) => ({ ...p, text: p.text.replace(/^[\s:–—-]+|[\s-]+$/g, '').replace(/^["„“]|["“”]$/g, '').trim() }))
    .filter((p) => p.text.length >= MIN_CHARS && !isNoMatch(p.text))
    .slice(0, MAX_EXCERPTS);
}
