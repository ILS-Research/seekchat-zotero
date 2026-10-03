/**
 * Chat history as Markdown, for the "als .md speichern" buttons of the PDF
 * section and the library chat window. Answers are already Markdown; the
 * library chat's sources are appended as a numbered list per answer.
 */
import type { LlmRequestLog, Turn } from './turn';
import { currentLocale, t } from '../i18n';
import { formatPageGroups, pageGroups } from './library/sources';
import { bookDetails, bookStateText } from './book-report';

export interface ExportInfo {
  /** "PDF: Muster 2021 – Titel" or "Bibliothek „Meine Bibliothek“" */
  subject: string;
  model: string;
  date: Date;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "28.09.2026, 14:05" (German) / "2026-09-28 14:05" (English). */
export function formatDateTime(d: Date): string {
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return currentLocale() === 'de'
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${time}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** Quotes every line, so multi-line questions stay one block. */
function quote(text: string): string {
  return text.trim().split('\n').map((l) => `> ${l}`).join('\n');
}

export function chatToMarkdown(turns: Turn[], info: ExportInfo): string {
  const out: string[] = [
    `# SeekChat – ${info.subject}`,
    '',
    t('export.exported', { date: formatDateTime(info.date) }) + (info.model ? t('export.model', { model: info.model }) : ''),
  ];
  let n = 0;
  for (const turn of turns) {
    if (turn.pending) continue;
    if (turn.role === 'user') {
      n++;
      out.push('', `## ${t('export.question', { n })}`, '', quote(turn.content));
      continue;
    }
    out.push('', turn.error ? `**${turn.content.trim()}**` : turn.content.trim());
    if (turn.meta) out.push('', ...turn.meta.split('\n').map((l) => `*${l.trim()}*  `));
    if (turn.bookProgress?.length) {
      out.push('', t('export.books'), '');
      for (const b of turn.bookProgress) {
        out.push(`- ${b.label} – ${bookStateText(b)}`, ...bookDetails(b).map((l) => `  - ${l}`));
      }
    }
    if (turn.sources?.length) {
      out.push('', t('export.sources'), '');
      for (const s of turn.sources) {
        const groups = pageGroups(s);
        const origin = s.origin === 'book' ? ` (${t('lib.originBook')})` : '';
        out.push(`${s.n}. ${s.label}${origin}${groups.length ? ` – ${formatPageGroups(groups, t('cite.page'))}` : ''}`);
      }
    }
    if (turn.requests?.length) out.push('', ...requestsToMarkdown(turn.requests));
    if (turn.notice) out.push('', `*${turn.notice}*`);
  }
  return out.join('\n').trimEnd() + '\n';
}

/** File name without characters Windows or macOS reject. */
export function exportFileName(subject: string, date: Date): string {
  const safe = subject.replace(/[\\/:*?"<>|„“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat';
  // No colon in the time: Windows rejects it in file names.
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
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
    const params = [t('export.params', { model: r.model, temperature: r.temperature, maxTokens: r.maxTokens })];
    const chars = r.messages.reduce((n, m) => n + m.content.length, 0);
    out.push('<details>', `<summary>${t('export.request', { i: i + 1, purpose: r.purpose, params: params.join(', '), chars })}</summary>`, '');
    for (const m of r.messages) {
      const f = fence(m.content);
      out.push(`**${m.role}:**`, '', `${f}text`, m.content, f, '');
    }
    out.push('</details>', '');
  });
  if (out[out.length - 1] === '') out.pop();
  return out;
}
