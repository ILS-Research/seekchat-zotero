import type { ChatMessage } from './llm/types';
import type { ContextBlock } from './context/types';

export const DEFAULT_SYSTEM_PROMPT =
  'Du bist ein wissenschaftlicher Assistent in Zotero. Beantworte Fragen ausschließlich auf Grundlage ' +
  'des bereitgestellten Dokuments. Belege Aussagen mit der Seitenangabe im Format [S. 12] direkt hinter ' +
  'der Aussage. Wenn das Dokument die Antwort nicht enthält, sage das offen, statt zu raten. ' +
  'Antworte in der Sprache der Frage, knapp und präzise.';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function formatPages(pages: { pageNumber: number; text: string }[]): string {
  return pages.map((p) => `[Seite ${p.pageNumber}]\n${p.text.trim()}`).join('\n\n');
}

export function describeContext(ctx: ContextBlock): string {
  if (ctx.mode === 'full') return `vollständiger Text, ${ctx.totalPages} Seiten`;
  const how = ctx.noMatches ? 'keine Treffer, verteilte Seiten' : `${ctx.matchedPages ?? 0} Seiten mit Treffern`;
  return `Auszüge: S. ${compressRanges(ctx.includedPages)} von ${ctx.totalPages} Seiten (${how})`;
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

export function buildMessages(opts: {
  systemPrompt?: string;
  context: ContextBlock;
  history: HistoryTurn[];
  question: string;
}): ChatMessage[] {
  const { context } = opts;
  const note = context.mode === 'full'
    ? 'Es folgt der vollständige Text des Dokuments.'
    : `Das Dokument ist zu lang für den Kontext. Es folgen die zur Frage passendsten Seiten (${describeContext(context)}). ` +
      'Wenn die Antwort auf anderen Seiten stehen könnte, weise darauf hin.';
  const system =
    `${opts.systemPrompt || DEFAULT_SYSTEM_PROMPT}\n\n` +
    `Dokument: ${context.title}\n${note}\n\n<dokument>\n${context.body}\n</dokument>`;
  return [
    { role: 'system', content: system },
    ...opts.history.map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: opts.question },
  ];
}
