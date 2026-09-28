/**
 * Numbered sources for the library chat: ZotSeek passages grouped by item.
 *
 * Passages arrive ranked. They are taken in that order while the budget lasts;
 * each item gets a number [n] on its first passage, later passages of the same
 * item join it. Passages without text (pure keyword hits) never go into the
 * prompt – they are only counted, so the meta line can say so.
 */
import { t } from '../../i18n';
import type { ZotSeekPassage } from '../zotseek/client';

export interface SourceExcerpt {
  /** 1-based PDF page, if known. */
  page?: number;
  text: string;
  textSource?: string;
  noteKey?: string;
}

export interface LibrarySource {
  /** Citation number, 1-based, in order of relevance. */
  n: number;
  itemKey: string;
  libraryKey: string | null;
  /** "Muster, Beispiel 2021 – Titel" */
  label: string;
  /** Excerpts in document order (by page, notes last). */
  excerpts: SourceExcerpt[];
}

export interface SourceSet {
  sources: LibrarySource[];
  /** Passages used in the prompt. */
  passagesUsed: number;
  /** Hits without text, not sent. */
  withoutText: number;
  /** Passages with text that did not fit into the budget. */
  overBudget: number;
  chars: number;
}

/** "Muster, Beispiel u. a. 2021 – Titel" from ZotSeek's result fields. */
export function sourceLabel(p: Pick<ZotSeekPassage, 'authors' | 'year' | 'title'>): string {
  const names = p.authors.slice(0, 3).map((a) => a.split(',')[0].trim()).filter(Boolean);
  const authors = names.length ? names.join(', ') + (p.authors.length > 3 ? t('common.etAl') : '') : '';
  const head = [authors, p.year ? String(p.year) : ''].filter(Boolean).join(' ');
  const title = p.title || t('common.untitled');
  return head ? `${head} – ${title}` : title;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Characters one excerpt costs in the prompt (text plus its "(S. N)" line). */
function cost(text: string): number {
  return text.length + 12;
}

export function buildSources(passages: ZotSeekPassage[], budgetChars: number): SourceSet {
  const byItem = new Map<string, LibrarySource>();
  const seenText = new Map<string, string[]>();
  let used = 0;
  let passagesUsed = 0;
  let withoutText = 0;
  let overBudget = 0;
  for (const p of passages) {
    if (!p.text) {
      withoutText++;
      continue;
    }
    const id = `${p.libraryKey ?? '?'}/${p.itemKey}`;
    const text = p.text.trim();
    // The same chunk can come back twice (hybrid legs); a chunk contained in another adds nothing.
    const norm = normalized(text);
    const known = seenText.get(id) || [];
    if (known.some((k) => k.includes(norm))) continue;
    const source = byItem.get(id);
    const header = source ? 0 : sourceLabel(p).length + 8;
    if (used + header + cost(text) > budgetChars) {
      overBudget++;
      continue;
    }
    used += header + cost(text);
    passagesUsed++;
    seenText.set(id, [...known.filter((k) => !norm.includes(k)), norm]);
    const excerpt: SourceExcerpt = { page: p.page, text, textSource: p.textSource, noteKey: p.noteKey };
    if (source) {
      // Replace excerpts the new one contains, keep the rest.
      source.excerpts = source.excerpts.filter((e) => !norm.includes(normalized(e.text)));
      source.excerpts.push(excerpt);
    } else {
      byItem.set(id, {
        n: byItem.size + 1,
        itemKey: p.itemKey,
        libraryKey: p.libraryKey,
        label: sourceLabel(p),
        excerpts: [excerpt],
      });
    }
  }
  const sources = Array.from(byItem.values());
  for (const s of sources) s.excerpts.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity));
  return { sources, passagesUsed, withoutText, overBudget, chars: used };
}

/** Prompt text: one block per source, excerpts marked with their page. */
export function formatSources(sources: LibrarySource[]): string {
  return sources.map((s) => {
    const parts = s.excerpts.map((e) => {
      const where = e.page ? `(${t('cite.page')} ${e.page})` : e.textSource === 'note' ? '(note)' : '(no page)';
      return `${where}\n${e.text}`;
    });
    return `[${s.n}] ${s.label}\n${parts.join('\n\n')}`;
  }).join('\n\n---\n\n');
}
