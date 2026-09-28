/**
 * Chat history as Markdown, for the "als .md speichern" buttons of the PDF
 * section and the library chat window. Answers are already Markdown; the
 * library chat's sources are appended as a numbered list per answer.
 */
import type { LlmRequestLog, Turn } from './session';

export interface ExportInfo {
  /** "PDF: Muster 2021 – Titel" or "Bibliothek „Meine Bibliothek“" */
  subject: string;
  model: string;
  date: Date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateTime(d: Date): string {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Quotes every line, so multi-line questions stay one block. */
function quote(text: string): string {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

export function chatToMarkdown(turns: Turn[], info: ExportInfo): string {
  const out: string[] = [
    `# SeekChat – ${info.subject}`,
    '',
    `Exportiert am ${formatDateTime(info.date)}${info.model ? ` · Modell: ${info.model}` : ''}`,
  ];
  let n = 0;
  for (const t of turns) {
    if (t.pending) continue;
    if (t.role === 'user') {
      n++;
      out.push('', `## Frage ${n}`, '', quote(t.content));
      continue;
    }
    out.push('', t.error ? `**${t.content.trim()}**` : t.content.trim());
    if (t.meta) out.push('', ...t.meta.split('\n').map((l) => `*${l.trim()}*  `));
    if (t.sources?.length) {
      out.push('', 'Quellen:', '');
      for (const s of t.sources) {
        const pages = Array.from(new Set(s.excerpts.map((e) => e.page).filter((p): p is number => !!p))).sort((a, b) => a - b);
        out.push(`${s.n}. ${s.label}${pages.length ? ` – S. ${pages.join(', ')}` : ''}`);
      }
    }
    if (t.requests?.length) out.push('', ...requestsToMarkdown(t.requests));
  }
  return out.join('\n').trimEnd() + '\n';
}

/** File name without characters Windows or macOS reject. */
export function exportFileName(subject: string, date: Date): string {
  const safe = subject.replace(/[\\/:*?"<>|„“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `SeekChat ${stamp} ${safe}.md`;
}

/** Longest run of backticks in a text, so the fence around it can be one longer. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((m) => m.length));
  return '`'.repeat(longest + 1);
}

/**
 * The model requests of one answer as collapsible blocks: purpose, parameters
 * and every message verbatim (system prompt with the document text, history, question).
 */
export function requestsToMarkdown(requests: LlmRequestLog[]): string[] {
  const out: string[] = [];
  requests.forEach((r, i) => {
    const params = [`Modell ${r.model}`, `Temperatur ${r.temperature}`, `max. ${r.maxTokens} Tokens`];
    if (r.numCtx) params.push(`num_ctx ${r.numCtx}`);
    const chars = r.messages.reduce((n, m) => n + m.content.length, 0);
    out.push('<details>', `<summary>Anfrage ${i + 1} an das Modell: ${r.purpose} (${params.join(', ')}; ${chars} Zeichen)</summary>`, '');
    for (const m of r.messages) {
      const f = fence(m.content);
      out.push(`**${m.role}:**`, '', `${f}text`, m.content, f, '');
    }
    out.push('</details>', '');
  });
  if (out[out.length - 1] === '') out.pop();
  return out;
}
