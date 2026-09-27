/**
 * Chooses which pages of a document fit into the prompt budget.
 *
 * If the whole document fits it is sent as is. Otherwise pages are ranked
 * with a small BM25-style score against weighted search terms (the question,
 * optionally expanded by the model, see keywords.ts). Only pages that match
 * reasonably well are sent, plus page 1 (title, abstract) and the neighbours
 * of the best hits for context; unrelated pages are not used as filler.
 * Without any match, pages are spread evenly across the document.
 */
import type { Page } from './types';

export interface Selection {
  pages: Page[];
  mode: 'full' | 'excerpt';
  /** Pages with a keyword hit (excerpt mode). */
  matchedPages: number;
  /** True if no page matched and pages were spread evenly instead. */
  noMatches: boolean;
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

/** A page counts as relevant if it scores at least this share of the best page. */
const RELEVANCE_SHARE = 0.15;
/** Neighbours are added around this many top pages. */
const NEIGHBOUR_ANCHORS = 5;

const STOPWORDS = new Set((
  'der die das den dem des ein eine einer eines einem einen und oder aber nicht ist sind war waren wird werden ' +
  'wie was wer wo wann warum welche welcher welches mit von zu zum zur auf aus bei für über unter nach vor ' +
  'im in an am es sie er ich wir ihr sich auch noch nur schon sehr mehr kann können soll sollen hat haben ' +
  'dieser diese dieses dem gibt text dokument paper artikel seite seiten ' +
  'the a an and or but not is are was were be been what which who where when why how with from to of on ' +
  'in at by for about into this that these those it its they them there their can could should would does ' +
  'do did has have had paper document article page pages'
).split(' '));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((t) => !STOPWORDS.has(t));
}

function scorePages(pages: Page[], terms: WeightedTerm[]): number[] {
  if (terms.length === 0) return pages.map(() => 0);
  const tokenized = pages.map((p) => tokenize(p.text));
  const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / Math.max(1, tokenized.length) || 1;
  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    const seen = new Set(tokens);
    for (const { term } of terms) if (seen.has(term)) df.set(term, (df.get(term) || 0) + 1);
  }
  const n = pages.length;
  const k1 = 1.2;
  const b = 0.75;
  return tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const { term, weight } of terms) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
      score += weight * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * tokens.length / avgLen));
    }
    return score;
  });
}

/**
 * Search terms from the question (weight 1) and model keywords (weight 0.6;
 * multi-word keywords contribute each word). A term keeps its highest weight.
 */
export function buildTerms(question: string, keywords: string[] = []): WeightedTerm[] {
  const weights = new Map<string, number>();
  const add = (text: string, w: number) => {
    for (const t of tokenize(text)) weights.set(t, Math.max(weights.get(t) || 0, w));
  };
  add(question, 1);
  for (const k of keywords) add(k, 0.6);
  return Array.from(weights, ([term, weight]) => ({ term, weight }));
}

function evenlySpread(count: number, first: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let step = count; step >= 1 && order.length < count; step = Math.floor(step / 2)) {
    for (let i = first; i < count; i += step) {
      if (!seen.has(i)) {
        seen.add(i);
        order.push(i);
      }
    }
    if (step === 1) break;
  }
  return order;
}

/** Adds pages in the given order while they fit; the first page that does not fit may be truncated. */
function fill(pages: Page[], order: number[], budgetChars: number): Page[] {
  const chosen: Page[] = [];
  const taken = new Set<number>();
  let used = 0;
  let truncated = false;
  for (const i of order) {
    if (taken.has(i)) continue;
    const page = pages[i];
    const remaining = budgetChars - used;
    if (remaining <= 0) break;
    if (page.text.length <= remaining) {
      chosen.push(page);
      used += page.text.length;
      taken.add(i);
    } else if (!truncated && remaining > 1000) {
      // A truncated relevant page is better than leaving the budget unused.
      chosen.push({ pageNumber: page.pageNumber, text: page.text.slice(0, remaining) + ' […]' });
      used = budgetChars;
      truncated = true;
      taken.add(i);
    }
  }
  return chosen.sort((a, b) => a.pageNumber - b.pageNumber);
}

export function selectPagesByTerms(pages: Page[], terms: WeightedTerm[], budgetChars: number): Selection {
  const nonEmpty = pages.filter((p) => p.text.trim());
  const total = nonEmpty.reduce((s, p) => s + p.text.length, 0);
  if (total <= budgetChars) return { pages: nonEmpty, mode: 'full', matchedPages: 0, noMatches: false };

  const scores = scorePages(nonEmpty, terms);
  const best = Math.max(0, ...scores);
  if (best <= 0) {
    const spread = fill(nonEmpty, [0, ...evenlySpread(nonEmpty.length, 1)], budgetChars);
    return { pages: spread, mode: 'excerpt', matchedPages: 0, noMatches: true };
  }
  const relevant = nonEmpty
    .map((_, i) => i)
    .filter((i) => scores[i] >= best * RELEVANCE_SHARE)
    .sort((a, b) => scores[b] - scores[a] || a - b);
  const neighbours: number[] = [];
  for (const i of relevant.slice(0, NEIGHBOUR_ANCHORS)) {
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < nonEmpty.length) neighbours.push(j);
  }
  const chosen = fill(nonEmpty, [0, ...relevant, ...neighbours], budgetChars);
  return { pages: chosen, mode: 'excerpt', matchedPages: relevant.length, noMatches: false };
}

export function selectPages(pages: Page[], query: string, budgetChars: number): Selection {
  return selectPagesByTerms(pages, buildTerms(query), budgetChars);
}
