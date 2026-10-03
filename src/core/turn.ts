/** One chat message and what the UI shows about it; shared by the session, the library pipeline and the views. */
import type { BookTarget } from './library/books';
import type { LibrarySource } from './library/sources';
import type { LanguageSource } from './context/language';
import type { HistoryTurn } from './prompt';

export type { BookTarget };

export interface Turn {
  /** This answer was saved as a note on its own (button shows ✓). */
  noteSaved?: boolean;
  role: 'user' | 'assistant';
  content: string;
  /** Fixed hint from SeekChat shown after this answer as its own message (never sent to the model). */
  notice?: string;
  /** Which part of the document the answer was based on. */
  meta?: string;
  error?: boolean;
  /** Stopped by the user; kept on screen, never sent to the model as history. */
  cancelled?: boolean;
  pending?: boolean;
  /** Library chat: the numbered sources in the prompt (numbers stable within the chat, not 1..n). */
  sources?: LibrarySource[];
  /** Library chat, source "books": what happened to each book (each can be skipped while running). */
  bookProgress?: BookProgress[];
  /** Every request sent to the model for this answer, in order (for the Markdown export). */
  requests?: LlmRequestLog[];
  /** Tool chat: the tools the model ran for this answer, in order. */
  toolRuns?: ToolRun[];
}

export type ToolRunState = 'running' | 'confirm' | 'done' | 'error' | 'cancelled';

/** One tool call as the UI shows it: progress line, a list (preview or result) and, in state "confirm", the user's choice. */
export interface ToolRun {
  id: string;
  name: string;
  /** What the tool does, in the UI language ("Import 3 references"). */
  title: string;
  state: ToolRunState;
  /** Progress or result line. */
  status?: string;
  items?: ToolRunItem[];
}

export interface ToolRunItem {
  label: string;
  detail?: string;
  /** Short state shown before the label ("found", "duplicate", "saved" …). */
  badge?: string;
  /** In state "confirm": the item is offered with a checkbox; `checked` is the user's choice. */
  selectable?: boolean;
  checked?: boolean;
  /** Zotero item the label opens (existing duplicate or saved item). */
  itemID?: number;
}

export interface LlmRequestLog {
  /** 'Spracherkennung' | 'Suchbegriffe' | 'Antwort' */
  purpose: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: { role: string; content: string }[];
}

export type BookState = 'waiting' | 'language' | 'keywords' | 'reading' | 'found' | 'none' | 'nohits' | 'skipped' | 'error' | 'limit';

export interface BookProgress {
  label: string;
  attachmentID: number;
  state: BookState;
  /** State "found": number of passages. */
  found?: number;
  /** State "error": message. */
  error?: string;
  /** Language of the book (UI name) and where it came from, its search terms and the pages sent (like the PDF chat's meta line). */
  language?: string;
  languageSource?: LanguageSource;
  keywords?: string[];
  pages?: number[];
  totalPages?: number;
}

/** Books in these states can still be skipped. */
export const SKIPPABLE: BookState[] = ['waiting', 'language', 'keywords', 'reading'];

/**
 * The last `maxPairs` complete exchanges: a question directly followed by a finished answer. Questions whose answer
 * failed or was cancelled are left out with it, so the model never sees two questions in a row (strict chat templates
 * reject that) nor a half answer.
 */
export function historyPairs(turns: Turn[], maxPairs: number): HistoryTurn[] {
  const pairs: HistoryTurn[][] = [];
  for (let i = 0; i + 1 < turns.length; i++) {
    const q = turns[i];
    const a = turns[i + 1];
    if (q.role !== 'user' || a.role !== 'assistant') continue;
    if (a.error || a.pending || a.cancelled || !a.content.trim()) continue;
    pairs.push([{ role: 'user', content: q.content }, { role: 'assistant', content: a.content }]);
    i++;
  }
  return maxPairs > 0 ? pairs.slice(-maxPairs).flat() : [];
}

