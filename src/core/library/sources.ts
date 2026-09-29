/**
 * Numbered sources for the library chat: evidence from all sources (ZotSeek
 * passages, excerpts pre-read from books) grouped by item.
 *
 * Evidence arrives ranked. It is taken in that order while the budget lasts;
 * each item gets a number [n] on its first excerpt, later excerpts of the same
 * item join it. Numbers are stable within a chat: an item keeps its number in
 * follow-up questions, and sources cited earlier are carried into the next
 * prompt first. Evidence without text (pure keyword hits) never goes into the
 * prompt – it is only counted, so the meta line can say so.
 */
import { t } from '../../i18n';
import type { ZotSeekPassage } from '../zotseek/client';

export type EvidenceOrigin = 'zotseek' | 'book';

/** One excerpt from one source, before numbering. */
export interface Evidence {
  itemKey: string;
  libraryKey: string | null;
  /** "Muster, Beispiel 2021 – Titel" */
  label: string;
  origin: EvidenceOrigin;
  /** The PDF the excerpt comes from (citations open it); books can have several PDFs. */
  attachmentID?: number;
  /** Title of that PDF ("Teil 3 – Administration"), shown when a source has excerpts from several PDFs. */
  attachmentTitle?: string;
  /** Printed page number of `page`, if the PDF has page labels. */
  pageLabel?: string;
  /** Chapter path of the excerpt, if known ("Kapitel 2 › Messungen"). */
  chapter?: string;
  /** Missing for pure keyword hits (not sent). */
  text?: string;
  /** 1-based PDF page, if known. */
  page?: number;
  textSource?: string;
  noteKey?: string;
  /** 7e-2: a whole page loaded on request (not a search hit). */
  loaded?: boolean;
}

export interface SourceExcerpt {
  /** 1-based page in the PDF `attachmentID`, if known. */
  page?: number;
  text: string;
  textSource?: string;
  noteKey?: string;
  loaded?: boolean;
  /** The PDF this excerpt comes from: a page number only means something within it. */
  attachmentID?: number;
  attachmentTitle?: string;
  pageLabel?: string;
  chapter?: string;
}

export interface LibrarySource {
  /** Citation number, 1-based, stable within a chat. */
  n: number;
  itemKey: string;
  libraryKey: string | null;
  /** "Muster, Beispiel 2021 – Titel" */
  label: string;
  /** Where the excerpts come from (missing in chats of 0.7 and older: ZotSeek). */
  origin?: EvidenceOrigin;
  /** Chats saved by 0.9 and older: the one PDF of the source. Newer chats keep the PDF per excerpt. */
  attachmentID?: number;
  /** Excerpts in document order (by PDF, then page; notes last). */
  excerpts: SourceExcerpt[];
}

export interface SourceSet {
  /** Sources in the prompt, ordered by number. */
  sources: LibrarySource[];
  /** Excerpts used in the prompt (carried ones included). */
  passagesUsed: number;
  /** Hits without text, not sent. */
  withoutText: number;
  /** Excerpts with text that did not fit into the budget. */
  overBudget: number;
  /** Sources carried over from earlier answers. */
  carried: number;
  chars: number;
}

/** Numbering state of one chat: item id -> citation number. */
export type SourceNumbers = Map<string, number>;

/** "Muster, Beispiel u. a. 2021 – Titel" from ZotSeek's result fields. */
export function sourceLabel(p: Pick<ZotSeekPassage, 'authors' | 'year' | 'title'>): string {
  const names = p.authors.slice(0, 3).map((a) => a.split(',')[0].trim()).filter(Boolean);
  const authors = names.length ? names.join(', ') + (p.authors.length > 3 ? t('common.etAl') : '') : '';
  const head = [authors, p.year ? String(p.year) : ''].filter(Boolean).join(' ');
  const title = p.title || t('common.untitled');
  return head ? `${head} – ${title}` : title;
}

export function fromZotSeek(p: ZotSeekPassage): Evidence {
  return {
    itemKey: p.itemKey, libraryKey: p.libraryKey, label: sourceLabel(p), origin: 'zotseek',
    text: p.text, page: p.page, textSource: p.textSource, noteKey: p.noteKey,
  };
}

export function sourceId(s: Pick<Evidence, 'libraryKey' | 'itemKey'>): string {
  return `${s.libraryKey ?? '?'}/${s.itemKey}`;
}

/** Alternates between the lists (rank 1 of each, then rank 2, …), so no source crowds out the others. */
export function interleave<T>(...lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Characters one excerpt costs in the prompt (text plus its "(S. N)" line). */
function cost(text: string): number {
  return text.length + 12;
}

function headerCost(label: string): number {
  return label.length + 8;
}

/** Share of the budget that sources carried over from earlier answers may take. */
const CARRIED_SHARE = 0.5;

export function buildSources(
  evidence: (Evidence | ZotSeekPassage)[],
  budgetChars: number,
  opts: { numbers?: SourceNumbers; carried?: LibrarySource[] } = {},
): SourceSet {
  const numbers: SourceNumbers = opts.numbers ?? new Map();
  const byItem = new Map<string, LibrarySource>();
  const seenText = new Map<string, string[]>();
  let used = 0;
  let passagesUsed = 0;
  let withoutText = 0;
  let overBudget = 0;
  const numberOf = (id: string) => {
    let n = numbers.get(id);
    if (!n) {
      n = Math.max(0, ...numbers.values()) + 1;
      numbers.set(id, n);
    }
    return n;
  };

  // Sources cited earlier come first, so follow-ups ("put that in a table") still see them.
  for (const prev of opts.carried || []) {
    const id = sourceId(prev);
    const excerpts: SourceExcerpt[] = [];
    let extra = headerCost(prev.label);
    for (const e of prev.excerpts) {
      if (used + extra + cost(e.text) > budgetChars * CARRIED_SHARE) break;
      excerpts.push(e);
      extra += cost(e.text);
    }
    if (!excerpts.length) continue;
    used += extra;
    passagesUsed += excerpts.length;
    seenText.set(id, excerpts.map((e) => normalized(e.text)));
    byItem.set(id, { ...prev, n: numberOf(id), excerpts });
  }
  const carried = byItem.size;

  for (const raw of evidence) {
    const e: Evidence = 'origin' in raw ? raw : fromZotSeek(raw);
    if (!e.text) {
      withoutText++;
      continue;
    }
    const id = sourceId(e);
    const text = e.text.trim();
    // The same chunk can come back twice (hybrid legs, several queries); a chunk contained in another adds nothing.
    const norm = normalized(text);
    const known = seenText.get(id) || [];
    if (known.some((k) => k.includes(norm))) continue;
    const source = byItem.get(id);
    const header = source ? 0 : headerCost(e.label);
    if (used + header + cost(text) > budgetChars) {
      overBudget++;
      continue;
    }
    used += header + cost(text);
    passagesUsed++;
    seenText.set(id, [...known.filter((k) => !norm.includes(k)), norm]);
    const excerpt: SourceExcerpt = {
      page: e.page, text, textSource: e.textSource, noteKey: e.noteKey, loaded: e.loaded,
      attachmentID: e.attachmentID, attachmentTitle: e.attachmentTitle, pageLabel: e.pageLabel, chapter: e.chapter,
    };
    if (source) {
      // Replace excerpts the new one contains, keep the rest.
      source.excerpts = source.excerpts.filter((x) => !norm.includes(normalized(x.text)));
      source.excerpts.push(excerpt);
      // A book that ZotSeek also found counts as book: its pre-read passages are in it.
      if (e.origin === 'book') source.origin = 'book';
    } else {
      byItem.set(id, {
        n: numberOf(id),
        itemKey: e.itemKey,
        libraryKey: e.libraryKey,
        label: e.label,
        origin: e.origin,
        excerpts: [excerpt],
      });
    }
  }
  const sources = Array.from(byItem.values()).sort((a, b) => a.n - b.n);
  for (const s of sources) sortExcerpts(s);
  return { sources, passagesUsed, withoutText, overBudget, carried, chars: used };
}

/** Document order: PDFs in order of first appearance, pages ascending within each, excerpts without page last. */
function sortExcerpts(s: LibrarySource): void {
  const order = new Map<number | undefined, number>();
  for (const e of s.excerpts) if (!order.has(e.attachmentID)) order.set(e.attachmentID, order.size);
  s.excerpts.sort((a, b) => (order.get(a.attachmentID)! - order.get(b.attachmentID)!)
    || (a.page ?? Infinity) - (b.page ?? Infinity));
}

/** Distinct PDFs of a source's excerpts (legacy chats: the source's single PDF). */
export function sourceAttachments(s: LibrarySource): number[] {
  const ids = Array.from(new Set(s.excerpts.map((e) => e.attachmentID).filter((id): id is number => !!id)));
  return ids.length ? ids : s.attachmentID ? [s.attachmentID] : [];
}

/**
 * The PDF a citation of `page` refers to: the first excerpt on that page names
 * it; without page (or no excerpt on it) the PDF with the most excerpts; for
 * chats saved by 0.9 and older the source's single PDF. Undefined = the item's best PDF.
 */
export function attachmentFor(s: LibrarySource, page?: number): number | undefined {
  if (page) {
    const hit = s.excerpts.find((e) => e.page === page && e.attachmentID);
    if (hit) return hit.attachmentID;
  }
  const counts = new Map<number, number>();
  for (const e of s.excerpts) if (e.attachmentID) counts.set(e.attachmentID, (counts.get(e.attachmentID) || 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : s.attachmentID;
}

export interface PageGroup {
  attachmentID?: number;
  /** PDF title; '' when the source has only one PDF (nothing to tell apart). */
  title: string;
  pages: number[];
}

/** Pages of a source grouped by PDF, in document order; one group without title for single-PDF sources. */
export function pageGroups(s: LibrarySource): PageGroup[] {
  const groups = new Map<number | undefined, PageGroup>();
  for (const e of s.excerpts) {
    if (!e.page) continue;
    const key = e.attachmentID ?? s.attachmentID;
    const g = groups.get(key) || { attachmentID: key, title: e.attachmentTitle || '', pages: [] };
    if (!g.pages.includes(e.page)) g.pages.push(e.page);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  for (const g of list) g.pages.sort((a, b) => a - b);
  if (list.length === 1) list[0].title = '';
  return list;
}

/** "Teil 1: S. 12, 15 · Teil 3: S. 204", or "S. 12, 15" for one PDF (Markdown export). */
export function formatPageGroups(groups: PageGroup[], pageWord: string): string {
  return groups.map((g) => `${g.title ? `${g.title}: ` : ''}${pageWord} ${g.pages.join(', ')}`).join(' · ');
}

/**
 * Prompt text: one block per source, excerpts marked with their page; book
 * excerpts are marked as such. With several PDFs in one source each excerpt
 * also names its PDF; chapter and printed page are added where known.
 */
export function formatSources(sources: LibrarySource[]): string {
  return sources.map((s) => {
    const several = sourceAttachments(s).length > 1;
    const parts = s.excerpts.map((e) => {
      const bits: string[] = [];
      if (several && e.attachmentTitle) bits.push(e.attachmentTitle);
      if (e.chapter) bits.push(`chapter: ${e.chapter}`);
      if (e.page) bits.push(`${t('cite.page')} ${e.page}${e.pageLabel && e.pageLabel !== String(e.page) ? ` (printed ${e.pageLabel})` : ''}${e.loaded ? ', whole page' : ''}`);
      const where = e.page || bits.length ? `(${bits.join(', ') || 'no page'})` : e.textSource === 'note' ? '(note)' : '(no page)';
      return `${where}\n${e.text}`;
    });
    return `[${s.n}] ${s.label}${s.origin === 'book' ? ' (book)' : ''}\n${parts.join('\n\n')}`;
  }).join('\n\n---\n\n');
}

/** Pages of a source's excerpts, sorted. */
export function sourcePages(s: LibrarySource): number[] {
  return Array.from(new Set(s.excerpts.map((e) => e.page).filter((p): p is number => !!p))).sort((a, b) => a - b);
}
