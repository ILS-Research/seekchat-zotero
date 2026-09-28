/**
 * Splits an answer into text and page citations such as [S. 12], [S. 3–4],
 * [Seite 7], [p. 5] or [pp. 5, 9], so the UI can make them clickable.
 */

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'cite'; text: string; page: number };

const CITE = /\[(?:S\.|Seiten?|pp?\.|pages?)\s*(\d+)(?:\s*(?:[-–,;]|und|and|f\.?|ff\.?)\s*\d*)*\s*\]/gi;

export function splitCitations(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    out.push({ type: 'cite', text: m[0], page: Number(m[1]) });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export type SourceSegment =
  | { type: 'text'; text: string }
  | { type: 'source'; text: string; n: number; page?: number };

const BRACKET = /\[([^\[\]\n]{1,80})\]/g;
const SOURCE_PART = /^\s*(\d{1,3})\s*(?:,\s*(?:S\.|Seiten?|pp?\.|pages?)\s*(\d+)(?:\s*(?:[-–]|f\.?|ff\.?)\s*\d*)*)?\s*$/i;

/**
 * Library chat: splits an answer into text and source citations such as [1],
 * [2, S. 12], [1, S. 3–4] or [1, S. 5; 3, S. 7] (one segment per part).
 * Only numbers 1..sourceCount count, so "[2021]" or "[3]" without a third
 * source stay text.
 */
export function splitSourceCitations(text: string, sourceCount: number): SourceSegment[] {
  const out: SourceSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(BRACKET)) {
    const parts = m[1].split(';').map((p) => p.match(SOURCE_PART));
    if (!parts.every((p) => p && Number(p[1]) >= 1 && Number(p[1]) <= sourceCount)) continue;
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    parts.forEach((p, i) => {
      const label = parts.length === 1 ? m[0] : `[${p![0].trim()}]`;
      if (i > 0) out.push({ type: 'text', text: ' ' });
      out.push({ type: 'source', text: label, n: Number(p![1]), page: p![2] ? Number(p![2]) : undefined });
    });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}
