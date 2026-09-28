/**
 * One chat per context (for now: per PDF attachment). Sessions live in memory
 * for the Zotero session, so switching items and coming back keeps the chat.
 */
import { createClient } from './llm';
import { stripThinking } from './llm/stream-parsers';
import { buildMessages, DEFAULT_BOOK_PROMPT, describeContext, isNoMatch, type HistoryTurn } from './prompt';
import { UserFacingError } from './errors';
import { PdfContextProvider } from './context/pdf-context';
import { buildKeywordMessages, parseKeywords } from './context/keywords';
import {
  buildLanguageMessages, guessLanguage, normalizeLanguage, parseLanguageReply,
  type Language, type LanguageSource,
} from './context/language';
import type { FitInfo } from './context/fit';
import { chapterScope, type Outline } from './context/outline';
import type { ChapterScope, ContextProvider, LongDocStrategy } from './context/types';
import type { LlmClient } from './llm/types';
import type { LibrarySource } from './library/sources';
import { readPrefs, type SeekChatPrefs } from '../prefs';
import { resolveLimits } from './limits';
import { newAbortController } from '../util/env';
import { logError } from '../util/log';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Which part of the document the answer was based on. */
  meta?: string;
  error?: boolean;
  pending?: boolean;
  /** Library chat: the numbered sources the answer cites. */
  sources?: LibrarySource[];
  /** Library chat, source "books": the book this answer is about (page citations refer to its PDF). */
  book?: { attachmentID: number; label: string };
  /** Book answer without relevant passages (shown dimmed). */
  noMatch?: boolean;
  /** Every request sent to the model for this answer, in order (for the Markdown export). */
  requests?: LlmRequestLog[];
}

export interface LlmRequestLog {
  /** 'Spracherkennung' | 'Suchbegriffe' | 'Antwort' */
  purpose: string;
  model: string;
  temperature: number;
  maxTokens: number;
  numCtx?: number;
  messages: { role: string; content: string }[];
}

/** Strategies the user can pick for long documents; "vector" is not implemented yet. */
/** A book for the library chat's "books" source: its PDF and a label for the answer heading. */
export interface BookTarget {
  attachment: any;
  label: string;
}

export const IMPLEMENTED_STRATEGIES: LongDocStrategy[] = ['keywords', 'chapters'];

export class ChatSession {
  turns: Turn[] = [];
  /** Size check of the document against the current budget; null until analyzed. */
  fit: FitInfo | null = null;
  fitError: string | null = null;
  strategy: LongDocStrategy = 'keywords';
  /** Strategy "chapters": ids of checked outline nodes (see outline.ts). */
  readonly selectedChapters = new Set<string>();
  private outlinePromise: Promise<Outline> | null = null;
  /** Detected document language (model or guess) per provider key, cached; metadata wins when present. */
  private languages = new Map<string, { lang: Language | null; source: LanguageSource | null }>();
  private fitBudget = -1;
  private abortCtrl: AbortController | null = null;
  private listeners = new Set<() => void>();

  constructor(public readonly provider: ContextProvider) {}

  get busy(): boolean {
    return this.abortCtrl !== null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { logError(e); }
    }
  }

  /**
   * Checks whether the whole document fits into the context budget. Cached
   * per budget, so changing the setting re-checks on the next open.
   */
  async analyze(): Promise<void> {
    const budget = (await resolveLimits(readPrefs())).contextChars;
    if (this.fitBudget === budget && (this.fit || this.fitError)) return;
    this.fitBudget = budget;
    this.fit = null;
    this.fitError = null;
    this.notify();
    try {
      this.fit = await this.provider.analyze(budget);
    } catch (e: any) {
      if (!(e instanceof UserFacingError)) logError(e);
      this.fitError = String(e?.message || e);
    }
    this.notify();
  }

  setStrategy(strategy: LongDocStrategy): void {
    if (!IMPLEMENTED_STRATEGIES.includes(strategy)) return;
    this.strategy = strategy;
    this.notify();
  }

  /** Table of contents of the document, loaded once per session. */
  outline(): Promise<Outline> {
    this.outlinePromise ??= this.provider.outline().catch((e) => {
      this.outlinePromise = null;
      throw e;
    });
    return this.outlinePromise;
  }

  /** Called by the chapter tree after the selection changed. */
  chaptersChanged(): void {
    this.notify();
  }

  clear(): void {
    this.stop();
    this.turns = [];
    this.notify();
  }

  stop(): void {
    this.abortCtrl?.abort();
  }

  /** Completed question/answer pairs, newest last, for follow-up questions. */
  private history(maxTurns: number): HistoryTurn[] {
    // Book answers stay out: there can be many, each with its own page numbering.
    const done = this.turns.filter((t) => !t.error && !t.pending && t.content && !t.book);
    return done.slice(Math.max(0, done.length - maxTurns * 2)).map((t) => ({ role: t.role, content: t.content }));
  }

  /**
   * Language of the document: the item's "Language" field, else a short model
   * call on the first pages, else a local stopword guess. Resolved once.
   */
  private async resolveLanguage(
    provider: ContextProvider,
    client: LlmClient,
    prefs: SeekChatPrefs,
    signal: AbortSignal,
  ): Promise<{ lang: Language | null; source: LanguageSource | null }> {
    // Metadata is read every time, so a language entered later applies at once;
    // only the detected language is cached.
    const fromMetadata = normalizeLanguage(provider.metadataLanguage());
    if (fromMetadata) return { lang: fromMetadata, source: 'metadata' };
    const cached = this.languages.get(provider.key);
    if (cached) return cached;
    const remember = (v: { lang: Language | null; source: LanguageSource | null }) => {
      this.languages.set(provider.key, v);
      return v;
    };
    const sample = await provider.sampleText(3000);
    try {
      const reply = await client.streamChat(
        { model: prefs.model, messages: buildLanguageMessages(sample), temperature: 0, maxTokens: 64, numCtx: 4096, signal },
        () => {},
      );
      const fromModel = parseLanguageReply(reply);
      if (fromModel) return remember({ lang: fromModel, source: 'model' });
    } catch (e) {
      if (signal.aborted) throw e;
      logError(e);
    }
    const guessed = guessLanguage(sample);
    return remember({ lang: guessed, source: guessed ? 'guess' : null });
  }

  /** Strategy "keywords": one short, low-temperature model call that expands the question into search terms. */
  private async expandKeywords(
    provider: ContextProvider,
    client: LlmClient,
    prefs: SeekChatPrefs,
    question: string,
    previousQuestion: string,
    language: Language | null,
    signal: AbortSignal,
  ): Promise<string[]> {
    try {
      const reply = await client.streamChat(
        {
          model: prefs.model,
          messages: buildKeywordMessages({ question, previousQuestion, docTitle: provider.describe(), language }),
          temperature: 0.2,
          maxTokens: 512,
          numCtx: 4096,
          signal,
        },
        () => {},
      );
      return parseKeywords(reply);
    } catch (e) {
      if (signal.aborted) throw e;
      // The answer still works with the question alone; the meta line tells the user.
      logError(e);
      return [];
    }
  }

  /** Model client that records each request into the answer turn. */
  private recordingClient(client: LlmClient, answer: Turn, purpose: () => string): LlmClient {
    return {
      listModels: (signal) => client.listModels(signal),
      modelInfo: (model, signal) => client.modelInfo(model, signal),
      streamChat: (req, onDelta) => {
        (answer.requests ??= []).push({
          purpose: purpose(),
          model: req.model,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          numCtx: req.numCtx,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        });
        return client.streamChat(req, onDelta);
      },
    };
  }

  /**
   * Asks the session's source. Library chat options: `zotseek` answers from ZotSeek
   * passages (the session's provider), `books` answers each book separately like the
   * PDF chat (one queue of answers, cancellable with stop()).
   */
  async ask(question: string, opts: { zotseek?: boolean; books?: BookTarget[] } = {}): Promise<void> {
    if (this.busy || !question.trim()) return;
    const q = question.trim();
    const prefs = readPrefs();
    const history = this.history(prefs.historyTurns);
    // Follow-ups ("und in Kapitel 3?") retrieve with the previous question as well.
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const books = opts.books || [];
    const useMain = opts.zotseek !== false;

    const main: Turn | null = useMain ? { role: 'assistant', content: '', pending: true } : null;
    const bookTurns: Turn[] = books.map((b, i) => ({
      role: 'assistant', content: '', pending: true,
      book: { attachmentID: b.attachment.id, label: b.label },
      meta: `Buch ${i + 1} von ${books.length} · wartet`,
    }));
    this.turns.push({ role: 'user', content: q }, ...(main ? [main] : []), ...bookTurns);
    const ctrl = newAbortController();
    this.abortCtrl = ctrl;
    this.notify();
    try {
      if (main) await this.answerInto(main, this.provider, q, lastQuestion, history, ctrl, { chapters: true });
      for (let i = 0; i < bookTurns.length; i++) {
        const t = bookTurns[i];
        if (ctrl.signal.aborted) {
          t.content = '[abgebrochen]';
          t.meta = `Buch ${i + 1} von ${books.length} · nicht mehr bearbeitet`;
          t.pending = false;
          continue;
        }
        const left = bookTurns.length - i - 1;
        const progress = `Buch ${i + 1} von ${books.length}${left ? ` · noch ${left} ausstehend` : ''}`;
        await this.answerInto(t, new PdfContextProvider(books[i].attachment), q, lastQuestion, [], ctrl, { book: true, progress });
      }
    } finally {
      this.abortCtrl = null;
      this.notify();
    }
  }

  /** One answer from one source into `answer`: size check, keywords if needed, then the streamed answer. */
  private async answerInto(
    answer: Turn,
    provider: ContextProvider,
    question: string,
    lastQuestion: string,
    history: HistoryTurn[],
    ctrl: AbortController,
    opts: { chapters?: boolean; book?: boolean; progress?: string },
  ): Promise<void> {
    let prefs = readPrefs();
    const status = (text: string) => {
      answer.meta = opts.progress ? `${opts.progress} · ${text}` : text;
      this.notify();
    };
    let raw = '';
    try {
      if (!prefs.model) throw new UserFacingError('Kein Chat-Modell gewählt (SeekChat-Einstellungen).');
      // Auto limits need one server round trip per model (cached); without an answer the manual values apply.
      const limits = await resolveLimits(prefs);
      prefs = { ...prefs, numCtx: limits.numCtx, maxTokens: limits.maxTokens, contextChars: limits.contextChars };
      let purpose = 'Antwort';
      const client = this.recordingClient(createClient(prefs), answer, () => purpose);
      if (opts.progress) status('lese PDF …');
      const fit = provider === this.provider && this.fit?.budgetChars === prefs.contextChars
        ? this.fit : await provider.analyze(prefs.contextChars);
      const notes: string[] = [];
      let keywords: string[] = [];
      let chapters: ChapterScope | undefined;
      // Chapters that fit into the budget are sent whole, without the keyword call.
      let needKeywords = !fit.fits;
      if (opts.chapters && !fit.fits && this.strategy === 'chapters') {
        const scope = chapterScope(await this.outline(), this.selectedChapters);
        if (!scope) throw new UserFacingError('Keine Kapitel ausgewählt. Bitte oben im Inhaltsverzeichnis Kapitel ankreuzen.');
        chapters = { titles: scope.titles, pages: scope.pages };
        needKeywords = scope.tokens > fit.budgetTokens;
        if (needKeywords) notes.push('Auswahl größer als das Budget: Suche innerhalb der Kapitel.');
      }
      if (needKeywords) {
        if (opts.chapters && !IMPLEMENTED_STRATEGIES.includes(this.strategy)) {
          notes.push('Gewählte Strategie noch nicht verfügbar, nutze Stichwort-Erweiterung.');
        }
        status('Bestimme Dokumentsprache …');
        purpose = 'Spracherkennung';
        const { lang, source } = await this.resolveLanguage(provider, client, prefs, ctrl.signal);
        const sourceText = source === 'metadata' ? 'aus Metadaten' : source === 'model' ? 'vom Modell erkannt' : 'geschätzt';
        notes.push(lang ? `Dokumentsprache: ${lang.name} (${sourceText})` : 'Dokumentsprache unbekannt, Suchbegriffe auf Deutsch und Englisch.');
        status('Erzeuge Suchbegriffe …');
        purpose = 'Suchbegriffe';
        keywords = await this.expandKeywords(provider, client, prefs, question, lastQuestion, lang, ctrl.signal);
        notes.push(keywords.length ? `Suchbegriffe: ${keywords.join(', ')}` : 'Keine Suchbegriffe erhalten, suche nur mit der Frage.');
      }
      purpose = 'Antwort';
      const context = await provider.build(`${question}\n${lastQuestion}`, prefs.contextChars, { keywords, chapters });
      const head = `${prefs.model} · ${describeContext(context)}`;
      answer.meta = [opts.progress ? `${opts.progress} · ${head}` : head, ...notes].join('\n');
      answer.sources = context.library?.sources;
      this.notify();
      // The PDF prompt setting asks for [S. N]; the library chat has its own citation format,
      // book answers the PDF format plus a marker for "nothing relevant".
      const systemPrompt = context.library ? '' : opts.book ? DEFAULT_BOOK_PROMPT : prefs.systemPrompt;
      await client.streamChat(
        {
          model: prefs.model,
          messages: buildMessages({ systemPrompt, context, history, question }),
          temperature: prefs.temperature,
          maxTokens: prefs.maxTokens,
          numCtx: prefs.numCtx,
          signal: ctrl.signal,
        },
        (delta) => {
          raw += delta;
          answer.content = stripThinking(raw);
          this.notify();
        },
      );
      if (opts.book && isNoMatch(answer.content)) {
        answer.noMatch = true;
        answer.content = 'Keine passenden Stellen in diesem Buch gefunden.';
      }
      if (!answer.content.trim()) answer.content = '(keine Antwort erhalten)';
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        answer.content = (answer.content ? answer.content + '\n' : '') + '[abgebrochen]';
        if (answer.meta?.endsWith('…')) answer.meta = answer.meta.replace(/\s*[^·]*…$/, ' abgebrochen');
      } else {
        if (!(e instanceof UserFacingError)) logError(e);
        answer.error = true;
        answer.content = `Fehler: ${e?.message || e}`;
      }
    } finally {
      answer.pending = false;
      this.notify();
    }
  }
}

const sessions = new Map<string, ChatSession>();

export function getSession(provider: ContextProvider): ChatSession {
  let s = sessions.get(provider.key);
  if (!s) {
    s = new ChatSession(provider);
    sessions.set(provider.key, s);
  }
  return s;
}

export function stopAllSessions(): void {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}
