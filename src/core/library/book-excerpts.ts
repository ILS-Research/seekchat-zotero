/**
 * Reading a book for the library chat, like the PDF chat: the model gets the
 * pages found for the question (whole book if it fits) and answers the question
 * from them, each statement starting with its page marker. The statements then
 * join the numbered sources of the one answer. Pure and unit-tested.
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

export function buildExcerptMessages(opts: {
  question: string; book: string; pages: Page[]; totalPages: number; language?: string | null; complete?: boolean;
}): ChatMessage[] {
  const system =
    'You answer a question from one book, for a research assistant who then combines the answers from several sources. ' +
    'Answer the question using only the pages of the book below, with the facts, definitions, steps and details that ' +
    `matter for it. Write at most ${MAX_EXCERPTS} self-contained statements (each up to about 150 words), the most ` +
    'relevant first. Start each statement on its own line with the page marker of the page it comes from, exactly as ' +
    'in the document, e.g. [Page 12]; quote short key phrases verbatim. Write in the language of the question. ' +
    `If the pages contain nothing on the question, answer only with "${NO_MATCH_MARKER}". ` +
    'No introduction, no summary at the end.\n\n' +
    `Book: ${opts.book}` + (opts.language ? `, written in ${opts.language}` : '') +
    (opts.complete ? ` (complete, ${opts.totalPages} pages)` : ` (${opts.pages.length} of ${opts.totalPages} pages, selected by keyword search)`) +
    `\n\n<document>\n${formatPages(opts.pages)}\n</document>`;
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
