/**
 * Pure helpers of the library tools (search, read items, collections, tags): compact item summaries the model
 * reads, merging hits of several search sources, collection paths, tag counts. No Zotero here (unit-tested);
 * zotero-library.ts reads Zotero and feeds these.
 */

/** What the model sees of an item in a result list; `key` is what later tools refer to. */
export interface ItemSummary {
  key: string;
  type: string;
  /** "Kuttler, Müller (2011): Titel". */
  label: string;
  year?: string;
  /** Journal, book, publisher or website. */
  venue?: string;
  /** Kinds of readable files: pdf, epub, html, text. */
  files: string[];
  tags: string[];
  collections: string[];
}

/** Hard limits, so a tool result stays small (the model's context is the server's own, never raised). */
export const MAX_RESULTS = 25;
export const DEFAULT_RESULTS = 15;
export const MAX_TAGS_PER_ITEM = 8;
export const MAX_COLLECTIONS_PER_ITEM = 5;
export const EXCERPT_CHARS = 300;

export function clampLimit(v: unknown, fallback = DEFAULT_RESULTS, max = MAX_RESULTS): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : fallback;
}

/** Text cut at a word border with "…". */
export function cut(text: string, max: number): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trim()} …`;
}

/** "Müller, Schmidt (2020): Title"; more than two names: "Müller et al.". */
export function itemLabel(names: string[], year: string | undefined, title: string): string {
  const who = names.length > 2 ? `${names[0]} et al.` : names.join(', ');
  const head = [who, year ? `(${year})` : ''].filter(Boolean).join(' ');
  return `${head}${head ? ': ' : ''}${title || '?'}`;
}

export function yearOf(date: unknown): string | undefined {
  return String(date || '').match(/\b(1[5-9]|20)\d{2}\b/)?.[0];
}

/** Year range filter; items without a year pass only when no range is given. */
export function inYearRange(year: string | undefined, from?: unknown, to?: unknown): boolean {
  const f = Number(from) || 0;
  const t = Number(to) || 0;
  if (!f && !t) return true;
  const y = Number(year);
  if (!y) return false;
  return (!f || y >= f) && (!t || y <= t);
}

export type SourceID = 'zotero' | 'zotseek' | 'seekbook';

/** One hit of one source; `excerpt` and `where` only from passage searches. */
export interface SourceHit {
  key: string;
  source: SourceID;
  excerpt?: string;
  /** "S. 12", "Kapitel 3, S. 45". */
  where?: string;
}

export interface MergedHit {
  key: string;
  sources: SourceID[];
  excerpts: { source: SourceID; text: string; where?: string }[];
}

/**
 * Hits of several sources joined per item, order kept: items found by more sources first, then by the best
 * rank in any list (passage searches rank by relevance; Zotero's own search has no ranking, so it comes last).
 */
export function mergeHits(lists: SourceHit[][]): MergedHit[] {
  const byKey = new Map<string, MergedHit & { rank: number }>();
  lists.forEach((list, li) => list.forEach((hit, i) => {
    let m = byKey.get(hit.key);
    if (!m) {
      m = { key: hit.key, sources: [], excerpts: [], rank: Infinity };
      byKey.set(hit.key, m);
    }
    if (!m.sources.includes(hit.source)) m.sources.push(hit.source);
    const rank = hit.source === 'zotero' ? 1e6 + i : i + li * 0.01;
    m.rank = Math.min(m.rank, rank);
    if (hit.excerpt && m.excerpts.length < 2) m.excerpts.push({ source: hit.source, text: cut(hit.excerpt, EXCERPT_CHARS), where: hit.where });
  }));
  return [...byKey.values()]
    .sort((a, b) => b.sources.length - a.sources.length || a.rank - b.rank)
    .map(({ rank: _r, ...m }) => m);
}

/** Status of one search source in a run: number of hits, switched off, not installed, failed. */
export type SourceStatus = number | 'off' | 'missing' | 'skipped' | { error: string };

/** For the model: plain words instead of the status objects. */
export function sourceStatusText(s: SourceStatus): string | number {
  if (typeof s === 'number') return s;
  if (s === 'off') return 'switched off';
  if (s === 'missing') return 'not installed';
  if (s === 'skipped') return 'not asked (no free-text query, or included in ZotSeek)';
  return `failed: ${s.error}`;
}

export interface CollectionNode {
  key: string;
  name: string;
  parentKey?: string;
  items: number;
}

/** Collections with their path ("Projekt A / Stadtklima"), depth-first, at most `max`. */
export function collectionPaths(nodes: CollectionNode[], max = 200): { key: string; path: string; items: number; subcollections: number }[] {
  const children = new Map<string | undefined, CollectionNode[]>();
  for (const n of nodes) {
    const list = children.get(n.parentKey) || [];
    list.push(n);
    children.set(n.parentKey, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const keys = new Set(nodes.map((n) => n.key));
  const out: { key: string; path: string; items: number; subcollections: number }[] = [];
  const walk = (parent: string | undefined, prefix: string) => {
    for (const n of children.get(parent) || []) {
      if (out.length >= max) return;
      const path = prefix ? `${prefix} / ${n.name}` : n.name;
      out.push({ key: n.key, path, items: n.items, subcollections: (children.get(n.key) || []).length });
      walk(n.key, path);
    }
  };
  walk(undefined, '');
  // Parents outside the list (subtree requested): their children are roots.
  for (const n of nodes) if (n.parentKey && !keys.has(n.parentKey) && !out.some((o) => o.key === n.key)) {
    out.push({ key: n.key, path: n.name, items: n.items, subcollections: (children.get(n.key) || []).length });
    walk(n.key, n.name);
  }
  return out.slice(0, max);
}

/**
 * The collection meant by `ref`: its key, its full path, or its name (case-insensitive). Several with that
 * name: an error naming their paths, so the model can ask or use the key.
 */
export function findCollection(paths: { key: string; path: string }[], ref: string): { key: string; path: string } {
  const r = String(ref || '').trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s*\/\s*/g, ' / ').trim();
  const byKey = paths.find((p) => p.key === r);
  if (byKey) return byKey;
  const byPath = paths.filter((p) => norm(p.path) === norm(r));
  if (byPath.length === 1) return byPath[0];
  const byName = paths.filter((p) => norm(p.path.split(' / ').pop()!) === norm(r));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`several collections are named "${r}": ${byName.map((p) => `"${p.path}" (${p.key})`).join(', ')}`);
  throw new Error(`no collection "${r}" in this library`);
}

/** Tags with their number of items, most used first; `filter` matches part of the name. */
export function countTags(itemTags: string[][], filter?: string, limit = 100): { tag: string; items: number }[] {
  const counts = new Map<string, number>();
  for (const tags of itemTags) for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
  const f = String(filter || '').toLowerCase().trim();
  return [...counts.entries()]
    .filter(([tag]) => !f || tag.toLowerCase().includes(f))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, items]) => ({ tag, items }));
}

/** String list from a tool argument (array, or one string with commas/semicolons). */
export function stringArg(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(/\s*[,;]\s*/).filter(Boolean);
  return [];
}
