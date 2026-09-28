import type { ChatMessage } from './llm/types';
import type { ContextBlock } from './context/types';

export const DEFAULT_SYSTEM_PROMPT =
  'Du bist ein wissenschaftlicher Assistent in Zotero. Beantworte Fragen ausschließlich auf Grundlage ' +
  'des bereitgestellten Dokuments. Belege Aussagen mit der Seitenangabe im Format [S. 12] direkt hinter ' +
  'der Aussage. Wenn das Dokument die Antwort nicht enthält, sage das offen, statt zu raten. ' +
  'Antworte in der Sprache der Frage, knapp und präzise.';

export const DEFAULT_LIBRARY_PROMPT =
  'Du bist ein wissenschaftlicher Assistent in Zotero. Beantworte Fragen ausschließlich auf Grundlage ' +
  'der bereitgestellten, nummerierten Quellen aus der Bibliothek des Nutzers. Belege jede Aussage direkt ' +
  'dahinter mit Quellennummer und Seite im Format [2, S. 12], ohne Seitenangabe mit [2]; mehrere Belege ' +
  'als [1, S. 3; 4, S. 7]. Nenne keine Quellen, die nicht bereitgestellt wurden. Enthalten die Quellen ' +
  'die Antwort nicht, sage das offen, statt zu raten. Antworte in der Sprache der Frage, knapp und präzise.';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function formatPages(pages: { pageNumber: number; text: string }[]): string {
  return pages.map((p) => `[Seite ${p.pageNumber}]\n${p.text.trim()}`).join('\n\n');
}

export function describeContext(ctx: ContextBlock): string {
  if (ctx.library) {
    const l = ctx.library;
    const extra = [
      l.withoutText ? `${l.withoutText} Treffer ohne Textauszug nicht verwendet` : '',
      l.overBudget ? `${l.overBudget} Abschnitte über dem Budget` : '',
    ].filter(Boolean).join(', ');
    const n = l.sources.length;
    const counts = `${n} ${n === 1 ? 'Quelle' : 'Quellen'}, ${l.passagesUsed} ${l.passagesUsed === 1 ? 'Abschnitt' : 'Abschnitte'}`;
    return `${l.scope}: ${counts} (ZotSeek)${extra ? `; ${extra}` : ''}`;
  }
  if (ctx.mode === 'full') return `vollständiger Text, ${ctx.totalPages} Seiten`;
  if (ctx.chapters?.complete) {
    return `${chapterList(ctx.chapters.titles)} vollständig: S. ${compressRanges(ctx.includedPages)} von ${ctx.totalPages} Seiten`;
  }
  const scope = ctx.chapters ? `${chapterList(ctx.chapters.titles)}, ` : '';
  const how = ctx.noMatches ? 'keine Treffer, verteilte Seiten' : `${ctx.matchedPages ?? 0} Seiten mit Treffern`;
  return `${scope}Auszüge: S. ${compressRanges(ctx.includedPages)} von ${ctx.totalPages} Seiten (${how})`;
}

function chapterList(titles: string[]): string {
  return `Kapitel ${titles.map((t) => `„${t}“`).join(', ')}`;
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
  if (context.library) {
    const system =
      `${opts.systemPrompt || DEFAULT_LIBRARY_PROMPT}\n\n` +
      `Suchbereich: ${context.library.scope}. Es folgen die zur Frage passendsten Textabschnitte, ` +
      `gefunden mit ZotSeek; andere Stellen der Bibliothek sind nicht enthalten.\n\n` +
      `<quellen>\n${context.body}\n</quellen>`;
    return [
      { role: 'system', content: system },
      ...opts.history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: opts.question },
    ];
  }
  const note = context.mode === 'full'
    ? 'Es folgt der vollständige Text des Dokuments.'
    : context.chapters?.complete
    ? `Das Dokument ist zu lang für den Kontext. Es folgen nur die vom Nutzer ausgewählten Teile (${describeContext(context)}). ` +
      'Wenn die Antwort in anderen Teilen des Dokuments stehen könnte, weise darauf hin.'
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
