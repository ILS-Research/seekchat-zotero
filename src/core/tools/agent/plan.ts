/**
 * Pure helpers of the subagent: packages, which tools it gets, keeping its conversation inside the context,
 * joining the results of several packages. No Zotero here (unit-testable).
 */
import type { ChatMessage } from '../../llm/types';

/** The tools a subagent may use: reading only (no changes, no confirmations, no further subagents). */
export const SUBAGENT_TOOLS = ['search_library', 'get_item', 'get_selection', 'list_collections', 'list_tags', 'read_document', 'get_document_references'];

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Text of a message as it counts for the context. */
const size = (m: ChatMessage) => (m.content || '').length + JSON.stringify(m.toolCalls || []).length;

/**
 * Keeps the conversation under `budgetChars`: tool results except the last two are cut to a short head, oldest
 * first, until it fits. System prompt, task and the model's own messages stay.
 */
export function shortenOldToolResults(messages: ChatMessage[], budgetChars: number, keepLast = 2, head = 300): void {
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budgetChars) return;
  const tools = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of tools.slice(0, Math.max(0, tools.length - keepLast))) {
    const m = messages[i];
    if (m.content.length <= head + 80) continue;
    const before = m.content.length;
    m.content = `${m.content.slice(0, head)} … [earlier result shortened to save context – you have read it already; do not call it again, go on with what you concluded from it]`;
    total -= before - m.content.length;
    if (total <= budgetChars) return;
  }
}

/** A result text without a Markdown code fence around it. */
function unfence(text: string): string {
  const m = text.trim().match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : text.trim();
}

/**
 * The results of the packages as one: JSON lists are joined into one list; otherwise the texts one after the other
 * with their package as heading.
 */
export function joinResults(results: { label: string; text: string }[]): unknown {
  if (results.length === 1) {
    try { return JSON.parse(unfence(results[0].text)); } catch { return results[0].text; }
  }
  const parsed = results.map((r) => {
    try { return JSON.parse(unfence(r.text)); } catch { return undefined; }
  });
  if (results.length && parsed.every((p) => Array.isArray(p))) return parsed.flat();
  return results.map((r) => `## ${r.label}\n${r.text}`).join('\n\n');
}
