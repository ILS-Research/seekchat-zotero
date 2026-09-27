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
