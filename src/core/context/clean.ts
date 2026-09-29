/**
 * Running headers and footers (title, chapter, page number, licence) removed
 * from PDF pages. Copied from SeekBook (src/core/text/clean.ts, same rules):
 * they cost budget on every page and hide headings from the outline detection.
 *
 * Zotero's PDF worker joins lines of the same font into running text, so a
 * header is usually the first words of a page. Headers and footers are found
 * as word prefixes/suffixes that recur on many pages once digits are masked.
 */
import type { Page } from './types';

/** Share of pages a prefix/suffix must start/end to count as running header/footer. */
export const HEADER_SHARE = 0.3;
const MAX_WORDS = 14;
/** Pages shorter than this are not used to find running lines. */
const MIN_PAGE_WORDS = 8;

function normWord(w: string): string {
  return w.toLowerCase().replace(/\d+/g, '#');
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Share of the best prefix count a longer prefix must keep to count as part of the header. */
const EXTEND_SHARE = 0.8;

/**
 * Word sequence at the start (or end, if `fromEnd`) that recurs on at least
 * `minPages` pages. Among the most frequent sequences the longest one wins
 * that still covers ≥ 80 % of those pages, so a header does not swallow a
 * body word that happens to follow it on a few pages. A single word only
 * counts if it is a bare (page) number.
 */
function findRunning(pageWords: string[][], fromEnd: boolean, minPages: number): string[] | null {
  const best: ({ key: string[]; count: number } | null)[] = [];
  for (let k = 1; k <= MAX_WORDS; k++) {
    const counts = new Map<string, number>();
    for (const ws of pageWords) {
      if (ws.length < k + MIN_PAGE_WORDS / 2) continue;
      const part = fromEnd ? ws.slice(ws.length - k) : ws.slice(0, k);
      const key = part.map(normWord).join(' ');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let top: { key: string[]; count: number } | null = null;
    for (const [key, count] of counts) {
      if (count < minPages) continue;
      if (k === 1 && !/^[#ivxlc]+$/.test(key)) continue;
      if (!top || count > top.count) top = { key: key.split(' '), count };
    }
    best.push(top);
  }
  const ref = Math.max(0, ...best.map((b) => b?.count || 0));
  if (!ref) return null;
  for (let k = best.length - 1; k >= 0; k--) {
    if (best[k] && best[k]!.count >= ref * EXTEND_SHARE) return best[k]!.key;
  }
  return null;
}

function matches(ws: string[], key: string[], fromEnd: boolean): boolean {
  if (ws.length < key.length) return false;
  const part = fromEnd ? ws.slice(ws.length - key.length) : ws.slice(0, key.length);
  return part.every((w, i) => normWord(w) === key[i]);
}

/** Removes running headers and footers; returns the patterns found. */
export function stripRunningLines(pages: Page[], share = HEADER_SHARE): { pages: Page[]; removed: string[] } {
  const minPages = Math.max(3, Math.ceil(pages.length * share));
  let pageWords = pages.map((p) => words(p.text));
  const removed: string[] = [];
  if (pages.length >= 3) {
    // Several rounds: a header is often "title" plus "page number", odd and even pages differ.
    for (const fromEnd of [false, true]) {
      for (let round = 0; round < 4; round++) {
        const key = findRunning(pageWords, fromEnd, minPages);
        if (!key) break;
        removed.push(`${fromEnd ? 'footer' : 'header'}: ${key.join(' ')}`);
        pageWords = pageWords.map((ws) => {
          if (!matches(ws, key, fromEnd)) return ws;
          return fromEnd ? ws.slice(0, ws.length - key.length) : ws.slice(key.length);
        });
      }
    }
  }
  if (!removed.length) return { pages, removed };
  // Rebuild the text from the remaining words; line breaks inside a page carry no meaning after the PDF worker.
  return { pages: pages.map((p, i) => ({ pageNumber: p.pageNumber, text: pageWords[i].join(' ') })), removed };
}

