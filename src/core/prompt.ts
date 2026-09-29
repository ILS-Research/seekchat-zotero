import type { ChatMessage } from './llm/types';
import type { ContextBlock } from './context/types';
import { quoted, t, tn } from '../i18n';

/** Citation marker the model is asked to use: "[p. 12]" in English, "[S. 12]" in German. */
function pageMark(): string {
  return t('cite.page');
}

/**
 * Default system prompt of the PDF chat. Prompts are English (models follow them best);
 * the model answers in the language of the question and cites pages with the UI's marker.
 */
export function defaultSystemPrompt(): string {
  const p = pageMark();
  return 'You are a scientific assistant in Zotero. Answer questions only on the basis of the provided document. ' +
    `Support each statement with the page right after it, in the format [${p} 12]. If the document does not contain ` +
    'the answer, say so openly instead of guessing. Answer in the language of the question, concisely and precisely.';
}

/** Marker the model answers with when a pre-read book has nothing on the question (library chat, source "books"). */
export const NO_MATCH_MARKER = 'NO RELEVANT CONTENT';

/** The reply is only the no-match marker (maybe with quotes or a period; the German marker of 0.6.0 too). */
export function isNoMatch(answer: string): boolean {
  const norm = answer.replace(/[„“"'.!*\s]/g, '').toUpperCase();
  return norm === NO_MATCH_MARKER.replace(/\s/g, '') || norm === 'KEINEANGABE';
}

export function defaultLibraryPrompt(): string {
  const p = pageMark();
  return 'You are a scientific assistant in Zotero. Answer questions only on the basis of the provided, numbered ' +
    'sources from the user\'s library. Support every statement right after it with source number and page in the ' +
    `format [2, ${p} 12], without a page as [2]; several references as [1, ${p} 3; 4, ${p} 7]. Do not cite sources ` +
    'that were not provided. If the sources do not contain the answer, say so openly instead of guessing. ' +
    'Answer in the language of the question, concisely and precisely.';
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** "[Page 27] (printed 25)" when the PDF's printed label differs from the physical page. */
export function formatPages(pages: { pageNumber: number; text: string }[], labels?: (string | null)[] | null): string {
  return pages.map((p) => {
    const label = labels?.[p.pageNumber - 1];
    const printed = label && label !== String(p.pageNumber) ? ` (printed ${label})` : '';
    return `[Page ${p.pageNumber}]${printed}\n${p.text.trim()}`;
  }).join('\n\n');
}

export function describeContext(ctx: ContextBlock): string {
  if (ctx.library) {
    const l = ctx.library;
    const extra = [
      l.withoutText ? t('meta.withoutText', { n: l.withoutText }) : '',
      l.overBudget ? t('meta.overBudget', { n: l.overBudget }) : '',
    ].filter(Boolean).join(', ');
    const o = l.origins;
    const origins = !o || !o.books ? 'ZotSeek'
      : !o.zotseek ? t('meta.originBooks', { n: o.books })
      : `${t('meta.originZotSeek', { n: o.zotseek })}, ${t('meta.originBooks', { n: o.books })}`;
    const head = t('meta.library', { scope: l.scope, sources: tn('meta.sources', l.sources.length), passages: tn('meta.passages', l.passagesUsed), origins });
    return extra ? `${head}; ${extra}` : head;
  }
  if (ctx.mode === 'full') return t('meta.fullText', { pages: ctx.totalPages });
  const pageLabel = t('cite.page');
  const range = compressRanges(ctx.includedPages);
  if (ctx.chapters?.complete) {
    return t('meta.chaptersWhole', { chapters: chapterList(ctx.chapters.titles), pageLabel, range, pages: ctx.totalPages });
  }
  const scope = ctx.chapters ? `${chapterList(ctx.chapters.titles)}, ` : '';
  const how = ctx.noMatches ? t('meta.noHits') : t('meta.hitPages', { n: ctx.matchedPages ?? 0 });
  return t('meta.excerpts', { scope, pageLabel, range, pages: ctx.totalPages, how });
}

function chapterList(titles: string[]): string {
  return t(titles.length === 1 ? 'meta.chapter' : 'meta.chapters', { titles: titles.map(quoted).join(', ') });
}

/** [1,2,3,5,7,8] -> "1–3, 5, 7–8" */
export function compressRanges(nums: number[]): string {
  const sorted = Array.from(new Set(nums)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? `${start}` : `${start}–${sorted[i]}`);
  }
  return parts.join(', ');
}

/** Where the sources in the prompt come from, for the model. */
function describeOrigins(l: NonNullable<ContextBlock['library']>): string {
  const parts: string[] = [];
  if (!l.origins || l.origins.zotseek) parts.push('passages found with ZotSeek, a search index of the library');
  if (l.origins?.books) parts.push('passages that were pre-read from books by keyword search, marked "(book)"');
  const carried = (l.carried ? ' Sources cited in earlier answers are included again with their numbers.' : '') +
    (l.sources.some((s) => s.excerpts.some((e) => e.loaded)) ? ' Pages marked "whole page" were loaded in full because the question asks for them.' : '');
  return `Below are the sources that best match the question: ${parts.join(', and ')}.${carried}`;
}

export function buildMessages(opts: {
  systemPrompt?: string;
  context: ContextBlock;
  history: HistoryTurn[];
  question: string;
}): ChatMessage[] {
  const { context } = opts;
  if (context.library) {
    const system =
      `${opts.systemPrompt || defaultLibraryPrompt()}\n\n` +
      `Search scope: ${context.library.scope}. ${describeOrigins(context.library)} ` +
      'Other parts of the library are not included.\n\n' +
      `<sources>\n${context.body}\n</sources>`;
    return [
      { role: 'system', content: system },
      ...opts.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: opts.question },
    ];
  }
  const pages = `pages ${compressRanges(context.includedPages)} of ${context.totalPages}`;
  const note = context.mode === 'full'
    ? 'The full text of the document follows.'
    : context.chapters?.complete
    ? `The document is too long for the context. Only the parts selected by the user follow (${pages}). ` +
      'If the answer could be in other parts of the document, point that out.'
    : `The document is too long for the context. The pages that best match the question follow (${pages}). ` +
      'If the answer could be on other pages, point that out.';
  const printed = context.body.includes('(printed ')
    ? '\nPages are marked [Page N]: N is the page in the PDF file, use it in citations. "(printed X)" is the page number printed on that page; mention it only when the user asks for printed page numbers.'
    : '';
  const notes = context.notes?.length
    ? '\n\nThe user added their own notes on this document as context. Use them as background; when a statement comes ' +
      'from a note, say so (e.g. "(note „Title“)") instead of a page citation.\n<notes>\n' +
      context.notes.map((n) => `[Note „${n.title}“]\n${n.text}`).join('\n\n') + '\n</notes>'
    : '';
  const system =
    `${opts.systemPrompt || defaultSystemPrompt()}\n\n` +
    `Document: ${context.title}\n${note}${printed}\n\n<document>\n${context.body}\n</document>${notes}`;
  return [
    { role: 'system', content: system },
    ...opts.history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: opts.question },
  ];
}
