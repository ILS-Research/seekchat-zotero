/**
 * One chat per context (a PDF attachment, or a library scope). Sessions live in
 * memory for the Zotero session, so switching items and coming back keeps the chat.
 *
 * The session owns the chat state (turns, running question, stable source numbers)
 * and answers PDF questions itself; library questions go through LibraryPipeline
 * (library/pipeline.ts).
 */
import { createClient } from './llm';
import { stripThinking } from './llm/stream-parsers';
import { buildMessages, compressRanges, describeContext, type HistoryTurn } from './prompt';
import { languageName, t, tn } from '../i18n';
import { UserFacingError } from './errors';
import { currentReaderPage, PdfContextProvider } from './context/pdf-context';
import type { FitInfo } from './context/fit';
import { chapterScope, type Outline } from './context/outline';
import type { ChapterScope, ContextProvider, LongDocStrategy } from './context/types';
import { contextNotesText } from './context/notes';
import { indexState, semanticPages } from './context/index-access';
import type { SourceNumbers } from './library/sources';
import { LibraryContextProvider } from './library/library-context';
import { LibraryPipeline, type PipelineHost } from './library/pipeline';
import { expandKeywords, recordingClient, resolveLanguage, type LanguageCache } from './helper-calls';
import { historyPairs, SKIPPABLE, type BookTarget, type Turn } from './turn';
import { readPrefs, type SeekChatPrefs } from '../prefs';
import { resolveLimits } from './limits';
import { newAbortController } from '../util/env';
import { LruMap } from '../util/lru';
import { content, logError, logger } from '../util/log';

const L = logger('Chat');
/** Strategies the user can pick for long documents ("vector" also needs the document in SeekBook or ZotSeek). */
export const IMPLEMENTED_STRATEGIES: LongDocStrategy[] = ['vector', 'keywords', 'chapters'];

export class ChatSession {
  turns: Turn[] = [];
  /** Size check of the document against the current budget; null until analyzed. */
  fit: FitInfo | null = null;
  fitError: string | null = null;
  strategy: LongDocStrategy = 'keywords';
  /** PDF chat: IDs of the notes the user added as context (kept while Zotero runs). */
  contextNotes = new Set<number>();
  /** Strategy "chapters": ids of checked outline nodes (see outline.ts). */
  readonly selectedChapters = new Set<string>();
  private outlinePromise: Promise<Outline> | null = null;
  /** Detected document language (model or guess) per provider key, cached; metadata wins when present. */
  private languages: LanguageCache = new Map();
  private fitBudget = -1;
  private abortCtrl: AbortController | null = null;
  /** Library chat: citation numbers per item, stable for the whole chat. */
  private sourceNumbers: SourceNumbers = new Map();
  /** Library chat: the answer being produced and one controller per book being read. */
  private runningTurn: Turn | null = null;
  private bookCtrls = new Map<number, AbortController>();
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
    this.sourceNumbers = new Map();
    this.notify();
  }

  /** Library chat: skips one book of the running question; the others go on. */
  skipBook(turn: Turn, index: number): void {
    const book = turn.bookProgress?.[index];
    if (!book || turn !== this.runningTurn || !SKIPPABLE.includes(book.state)) return;
    book.state = 'skipped';
    this.bookCtrls.get(index)?.abort();
    this.notify();
  }

  stop(): void {
    this.abortCtrl?.abort();
  }

  /** Completed question/answer pairs, newest last, for follow-up questions. */
  private history(maxTurns: number): HistoryTurn[] {
    return historyPairs(this.turns, maxTurns);
  }

  /**
   * Asks the session's source. Library chat options: `zotseek` searches ZotSeek (the
   * session's provider), `seekbook` searches SeekBook's book index, `books` pre-reads
   * these books (those SeekBook can search are left to it); all go into one answer.
   */
  async ask(question: string, opts: { zotseek?: boolean; seekbook?: boolean; books?: BookTarget[]; skipIndexedBooks?: boolean } = {}): Promise<void> {
    if (this.busy || !question.trim()) return;
    const q = question.trim();
    const prefs = readPrefs();
    const history = this.history(prefs.historyTurns);
    const answer: Turn = { role: 'assistant', content: '', pending: true };
    const library = this.provider instanceof LibraryContextProvider ? this.provider : null;
    const books = library ? opts.books || [] : [];
    // The book list is made in answerLibrary, once it is clear which books are read (split, follow-up without search).
    const split = !!(opts.seekbook || opts.skipIndexedBooks);
    this.turns.push({ role: 'user', content: q }, answer);
    const ctrl = newAbortController();
    this.abortCtrl = ctrl;
    this.runningTurn = answer;
    this.notify();
    try {
      if (library) {
        await this.run(answer, ctrl, () => new LibraryPipeline(this.pipelineHost()).answer(answer, library, q, history, ctrl, { zotseek: opts.zotseek !== false, seekbook: !!opts.seekbook, books, skipIndexedBooks: split }));
        // After the first answer: say once that follow-ups can load pages and search in named documents (7e-2).
        const answers = this.turns.filter((x) => x.role === 'assistant' && !x.error);
        if (!answer.error && answers.length === 1 && !this.turns.some((x) => x.notice)) answer.notice = t('lib.followupHint');
      } else {
        // Follow-ups ("und in Kapitel 3?") retrieve with the previous question as well.
        const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
        await this.run(answer, ctrl, () => this.answerInto(answer, this.provider, q, lastQuestion, history, ctrl));
      }
    } finally {
      for (const b of answer.bookProgress || []) if (SKIPPABLE.includes(b.state)) b.state = 'skipped';
      this.abortCtrl = null;
      this.runningTurn = null;
      this.bookCtrls.clear();
      this.notify();
    }
  }

  /** Runs one answer; errors and cancelling end up in the answer turn. */
  private async run(answer: Turn, ctrl: AbortController, body: () => Promise<void>): Promise<void> {
    try {
      await body();
      if (!answer.content.trim()) answer.content = t('common.noAnswer');
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        answer.cancelled = true;
        answer.content = (answer.content ? answer.content + '\n' : '') + t('common.cancelled');
        if (answer.meta?.endsWith('…')) answer.meta = answer.meta.replace(/\s*[^·\n]*…$/, ` ${t('meta.cancelled')}`);
      } else {
        if (!(e instanceof UserFacingError)) logError(e);
        answer.error = true;
        answer.content = t('common.error', { message: String(e?.message || e) });
      }
    } finally {
      answer.pending = false;
      this.notify();
    }
  }

  /** The session state the library pipeline works on (getters: clear() replaces turns and numbers). */
  private pipelineHost(): PipelineHost {
    const self = this;
    return {
      get turns() { return self.turns; },
      get sourceNumbers() { return self.sourceNumbers; },
      bookCtrls: this.bookCtrls,
      languages: this.languages,
      notify: () => this.notify(),
      answerPrefs: () => this.answerPrefs(),
    };
  }

  /** Prefs with the limits resolved for the current model (auto: one cached server round trip). */
  private async answerPrefs(): Promise<SeekChatPrefs> {
    const prefs = readPrefs();
    if (!prefs.model) throw new UserFacingError(t('error.noModel'));
    const limits = await resolveLimits(prefs);
    return { ...prefs, numCtx: limits.numCtx, maxTokens: limits.maxTokens, contextChars: limits.contextChars };
  }

  /** PDF chat: size check, keywords if needed, then the streamed answer into `answer`. */
  private async answerInto(
    answer: Turn,
    provider: ContextProvider,
    question: string,
    lastQuestion: string,
    history: HistoryTurn[],
    ctrl: AbortController,
  ): Promise<void> {
    const prefs = await this.answerPrefs();
    const t0 = Date.now();
    L.info(`PDF question in ${provider.describe()}: ${content(question)}`);
    const status = (text: string) => {
      L.info(`[${Date.now() - t0} ms] ${text}`);
      answer.meta = text;
      this.notify();
    };
    let purpose = t('purpose.answer');
    const client = recordingClient(createClient(prefs), answer, () => purpose);
    const fit = provider === this.provider && this.fit?.budgetChars === prefs.contextChars
      ? this.fit : await provider.analyze(prefs.contextChars);
    const notes: string[] = [];
    let keywords: string[] = [];
    let chapters: ChapterScope | undefined;
    // Chapters that fit into the budget are sent whole, without the keyword call.
    let needKeywords = !fit.fits;
    if (!fit.fits && this.strategy === 'chapters') {
      const scope = chapterScope(await this.outline(), this.selectedChapters);
      if (!scope) throw new UserFacingError(t('error.noChapters'));
      chapters = { titles: scope.titles, pages: scope.pages };
      needKeywords = scope.tokens > fit.budgetTokens;
      if (needKeywords) notes.push(t('meta.chaptersOver'));
    }
    let rankedPages: { page: number; pageEnd?: number }[] | undefined;
    if (!fit.fits && this.strategy === 'vector' && provider instanceof PdfContextProvider && provider.kind === 'pdf') {
      // Semantic search in SeekBook (books) or ZotSeek (other PDFs); keywords when that is not possible.
      const state = await indexState(provider.attachment);
      const where = state.kind === 'seekbook' ? 'SeekBook' : 'ZotSeek';
      if (state.ready) {
        status(t('meta.semanticSearching', { index: where }));
        try {
          const hits = await L.time(`${where} pages`, () => semanticPages(provider.attachment, [question, lastQuestion], ctrl.signal), (h) => `${h.length} pages`);
          if (hits.length) {
            rankedPages = hits;
            needKeywords = false;
            notes.push(t('meta.semanticPages', { index: where, n: hits.length }));
          } else {
            notes.push(t('meta.semanticNoHits', { index: where }));
          }
        } catch (e: any) {
          if (ctrl.signal.aborted) throw e;
          notes.push(t('meta.semanticFailed', { index: where, message: String(e?.message || e) }));
        }
      } else {
        notes.push(t('meta.semanticNotReady', { index: where }));
      }
    }
    if (needKeywords) {
      status(t('meta.detectLanguage'));
      purpose = t('purpose.language');
      const { lang, source } = await resolveLanguage(this.languages, provider, client, prefs, ctrl.signal);
      const sourceText = t(source === 'metadata' ? 'meta.languageMetadata' : source === 'model' ? 'meta.languageModel' : 'meta.languageGuess');
      notes.push(lang ? t('meta.language', { language: languageName(lang.code), source: sourceText }) : t('meta.languageUnknown'));
      status(t('meta.makeKeywords'));
      purpose = t('purpose.keywords');
      keywords = await expandKeywords(provider, client, prefs, question, lastQuestion, lang, ctrl.signal);
      notes.push(keywords.length ? t('meta.keywords', { keywords: keywords.join(', ') }) : t('meta.noKeywords'));
    }
    purpose = t('purpose.answer');
    const notesCtx = contextNotesText(Array.from(this.contextNotes), prefs.contextChars);
    if (notesCtx.length) notes.push(tn('meta.notesContext', notesCtx.length, { titles: notesCtx.map((n) => `„${n.title}“`).join(', ') }));
    const currentPage = provider instanceof PdfContextProvider && provider.kind === 'pdf' ? currentReaderPage(provider.attachment) ?? undefined : undefined;
    const context = await provider.build(`${question}\n${lastQuestion}`, prefs.contextChars, { keywords, chapters, rankedPages, notes: notesCtx, currentPage });
    if (context.aroundPages?.length && context.mode === 'excerpt') {
      notes.push(t('meta.currentPage', { page: currentPage!, pages: compressRanges(context.aroundPages) }));
    }
    answer.meta = [`${prefs.model} · ${describeContext(context)}`, ...notes].join('\n');
    this.notify();
    let raw = '';
    await client.streamChat(
      {
        model: prefs.model,
        messages: buildMessages({ systemPrompt: prefs.systemPrompt, context, history, question }),
        temperature: prefs.temperature,
        maxTokens: prefs.maxTokens,
        think: prefs.thinking,
        signal: ctrl.signal,
      },
      (delta) => {
        raw += delta;
        answer.content = stripThinking(raw);
        this.notify();
      },
    );
  }
}

const sessions = new LruMap<string, ChatSession>(500, (s) => s.busy);

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
