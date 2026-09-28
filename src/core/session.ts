/**
 * One chat per context (a PDF attachment, or a library scope). Sessions live in
 * memory for the Zotero session, so switching items and coming back keeps the chat.
 *
 * Library chat: one answer per question from all sources. (1) A planning call
 * makes the question standalone and derives search queries and keywords,
 * (2) ZotSeek is searched and books are pre-read (each skippable), (3) all
 * evidence is merged into numbered sources (stable across follow-ups, cited
 * sources carried over), (4) one streamed answer cites them as [n, S. x].
 */
import { createClient } from './llm';
import { stripThinking } from './llm/stream-parsers';
import { buildMessages, describeContext, type HistoryTurn } from './prompt';
import { languageName, t, tn } from '../i18n';
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
import {
  buildSources, formatSources, interleave, sourceId,
  type Evidence, type LibrarySource, type SourceNumbers,
} from './library/sources';
import { LibraryContextProvider } from './library/library-context';
import { bookPages, MAX_BOOKS_READ, type BookPages, type BookTarget } from './library/books';
import { buildExcerptMessages, parseExcerpts } from './library/book-excerpts';
import { buildPlanMessages, fallbackPlan, parsePlan, type SearchPlan } from './library/plan';
import { libraryKeyOf } from './library/zotero-items';
import { buildTerms } from './context/page-selection';
import { citedSourceNumbers } from './citations';
import { ZotSeekUnavailableError } from './zotseek/client';
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
  /** Library chat: the numbered sources in the prompt (numbers stable within the chat, not 1..n). */
  sources?: LibrarySource[];
  /** Library chat, source "books": what happened to each book (each can be skipped while running). */
  bookProgress?: BookProgress[];
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

export type { BookTarget };

export type BookState = 'waiting' | 'scanning' | 'reading' | 'found' | 'none' | 'nohits' | 'skipped' | 'error' | 'limit';

export interface BookProgress {
  label: string;
  attachmentID: number;
  state: BookState;
  /** State "found": number of passages. */
  found?: number;
  /** State "error": message. */
  error?: string;
}

/** Books in these states can still be skipped. */
export const SKIPPABLE: BookState[] = ['waiting', 'scanning', 'reading'];

/** Strategies the user can pick for long documents; "vector" is not implemented yet. */
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
    const done = this.turns.filter((t) => !t.error && !t.pending && t.content);
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
   * Asks the session's source. Library chat options: `zotseek` searches ZotSeek (the
   * session's provider), `books` pre-reads these books; both go into one answer.
   */
  async ask(question: string, opts: { zotseek?: boolean; books?: BookTarget[] } = {}): Promise<void> {
    if (this.busy || !question.trim()) return;
    const q = question.trim();
    const prefs = readPrefs();
    const history = this.history(prefs.historyTurns);
    const answer: Turn = { role: 'assistant', content: '', pending: true };
    const library = this.provider instanceof LibraryContextProvider ? this.provider : null;
    const books = library ? opts.books || [] : [];
    if (books.length) answer.bookProgress = books.map((b) => ({ label: b.label, attachmentID: b.attachment.id, state: 'waiting' }));
    this.turns.push({ role: 'user', content: q }, answer);
    const ctrl = newAbortController();
    this.abortCtrl = ctrl;
    this.runningTurn = answer;
    this.notify();
    try {
      if (library) {
        await this.run(answer, ctrl, () => this.answerLibrary(answer, library, q, history, ctrl, { zotseek: opts.zotseek !== false, books }));
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

  /** Prefs with the limits resolved for the current model (auto: one cached server round trip). */
  private async answerPrefs(): Promise<SeekChatPrefs> {
    const prefs = readPrefs();
    if (!prefs.model) throw new UserFacingError(t('error.noModel'));
    const limits = await resolveLimits(prefs);
    return { ...prefs, numCtx: limits.numCtx, maxTokens: limits.maxTokens, contextChars: limits.contextChars };
  }

  /** Sources cited in the answers still in the history window, latest excerpts, by number. */
  private carriedSources(maxTurns: number): LibrarySource[] {
    const answers = this.turns.filter((t) => t.role === 'assistant' && !t.error && !t.pending && t.sources?.length);
    const latest = new Map<string, LibrarySource>();
    for (const turn of answers) for (const s of turn.sources!) latest.set(sourceId(s), s);
    const cited = new Map<string, LibrarySource>();
    for (const turn of answers.slice(Math.max(0, answers.length - maxTurns))) {
      const byN = new Map(turn.sources!.map((s) => [s.n, s]));
      for (const n of citedSourceNumbers(turn.content, (x) => byN.has(x))) {
        const id = sourceId(byN.get(n)!);
        cited.set(id, latest.get(id)!);
      }
    }
    return Array.from(cited.values()).sort((a, b) => a.n - b.n);
  }

  /** Step 1: standalone question, queries and keywords; the question itself if the model fails. */
  private async planSearch(
    client: LlmClient, prefs: SeekChatPrefs, question: string, history: HistoryTurn[], scope: string, books: boolean, signal: AbortSignal,
  ): Promise<SearchPlan> {
    try {
      const reply = await client.streamChat(
        { model: prefs.model, messages: buildPlanMessages({ question, history, scope, books }), temperature: 0.1, maxTokens: 768, numCtx: 8192, signal },
        () => {},
      );
      return parsePlan(reply, question);
    } catch (e) {
      if (signal.aborted) throw e;
      logError(e);
      return fallbackPlan(question);
    }
  }

  /** The library chat's pipeline for one question (see the header comment). */
  private async answerLibrary(
    answer: Turn,
    library: LibraryContextProvider,
    question: string,
    history: HistoryTurn[],
    ctrl: AbortController,
    opts: { zotseek: boolean; books: BookTarget[] },
  ): Promise<void> {
    const prefs = await this.answerPrefs();
    const base = createClient(prefs);
    const status = (text: string) => {
      answer.meta = text;
      this.notify();
    };
    const notes: string[] = [];
    const scope = library.describe();

    // 1. Planning: needed for follow-ups (standalone question) and books (keywords).
    let plan = fallbackPlan(question);
    if (history.length || opts.books.length) {
      status(t('meta.planning'));
      const client = this.recordingClient(base, answer, () => t('purpose.plan'));
      plan = await this.planSearch(client, prefs, question, history, scope, opts.books.length > 0, ctrl.signal);
      if (!plan.fromModel) {
        notes.push(t('meta.planFailed'));
      } else {
        if (plan.question !== question) notes.push(t('meta.understood', { question: plan.question }));
        if (opts.zotseek) notes.push(t('meta.queries', { queries: plan.queries.map((x) => `„${x}“`).join(', ') }));
        if (opts.books.length) notes.push(plan.keywords.length ? t('meta.keywords', { keywords: plan.keywords.join(', ') }) : t('meta.noKeywords'));
      }
    }

    // 2. Evidence from each source.
    let zotseek: Evidence[] = [];
    if (opts.zotseek) {
      status(t('meta.searchingZotSeek'));
      try {
        zotseek = await library.searchEvidence(plan.queries, ctrl.signal);
      } catch (e: any) {
        // With books there is still something to answer from.
        if (!opts.books.length || !(e instanceof ZotSeekUnavailableError)) throw e;
        notes.push(t('meta.zotseekSkipped', { message: e.message }));
      }
    }
    const fromBooks = opts.books.length ? await this.readBooks(answer, opts.books, plan, base, prefs, ctrl, status) : [];
    if (ctrl.signal.aborted) throw new Error('aborted');
    if (answer.bookProgress) notes.push(this.booksSummary(answer.bookProgress));

    // 3. One numbered source list; sources cited before come first and keep their numbers.
    const set = buildSources(interleave(zotseek, ...fromBooks), prefs.contextChars, {
      numbers: this.sourceNumbers,
      carried: this.carriedSources(prefs.historyTurns),
    });
    if (!set.sources.length) {
      const onlyZotSeek = !opts.books.length;
      throw new UserFacingError(onlyZotSeek && set.withoutText ? t('error.onlyNoText', { scope })
        : onlyZotSeek ? t('error.noPassages', { scope }) : t('error.nothingFound', { scope }));
    }
    const books = set.sources.filter((s) => s.origin === 'book').length;
    const context = {
      title: scope,
      body: formatSources(set.sources),
      mode: 'excerpt' as const,
      includedPages: [],
      totalPages: 0,
      library: {
        sources: set.sources, scope, passagesUsed: set.passagesUsed, withoutText: set.withoutText, overBudget: set.overBudget,
        origins: { zotseek: set.sources.length - books, books }, carried: set.carried,
      },
    };
    if (set.carried) notes.push(tn('meta.carried', set.carried));
    answer.sources = set.sources;
    answer.meta = [`${prefs.model} · ${describeContext(context)}`, ...notes].join('\n');
    this.notify();

    // 4. One answer from all sources.
    const client = this.recordingClient(base, answer, () => t('purpose.answer'));
    let raw = '';
    await client.streamChat(
      {
        model: prefs.model,
        messages: buildMessages({ systemPrompt: '', context, history, question }),
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
  }

  /** "Bücher: 2 mit Fundstellen, 1 ohne Stichworttreffer, 1 übersprungen" */
  private booksSummary(progress: BookProgress[]): string {
    const count = (...states: BookState[]) => progress.filter((b) => states.includes(b.state)).length;
    const parts = [
      [count('found'), 'books.found'], [count('none'), 'books.none'], [count('nohits'), 'books.nohits'],
      [count('skipped'), 'books.skipped'], [count('error'), 'books.failed'], [count('limit'), 'books.limit'],
    ] as const;
    return t('meta.books', {
      parts: parts.filter(([n]) => n).map(([n, key]) => t(key, { n, max: MAX_BOOKS_READ })).join(', '),
    });
  }

  /**
   * Books: keyword search in each (cheap, local), then the best ones with hits are
   * pre-read by the model, two at a time. Each book has its own abort controller,
   * so skipBook() cancels just that one. Returns one evidence list per book read.
   */
  private async readBooks(
    answer: Turn,
    books: BookTarget[],
    plan: SearchPlan,
    base: LlmClient,
    prefs: SeekChatPrefs,
    ctrl: AbortController,
    status: (text: string) => void,
  ): Promise<Evidence[][]> {
    const progress = answer.bookProgress!;
    const terms = buildTerms(plan.question, plan.keywords);
    const skipped = (i: number) => progress[i].state === 'skipped';
    const scans: (BookPages | null)[] = books.map(() => null);
    status(t('meta.scanningBooks'));
    for (let i = 0; i < books.length && !ctrl.signal.aborted; i++) {
      if (skipped(i)) continue;
      progress[i].state = 'scanning';
      this.notify();
      try {
        const scan = await bookPages(books[i], terms, prefs.contextChars);
        if (skipped(i)) continue;
        scans[i] = scan;
        progress[i].state = scan.matchedPages ? 'waiting' : 'nohits';
      } catch (e: any) {
        if (!(e instanceof UserFacingError)) logError(e);
        if (!skipped(i)) {
          progress[i].state = 'error';
          progress[i].error = String(e?.message || e);
        }
      }
      this.notify();
    }
    const ranked = books.map((_, i) => i)
      .filter((i) => !skipped(i) && (scans[i]?.matchedPages ?? 0) > 0)
      .sort((a, b) => scans[b]!.matchedPages - scans[a]!.matchedPages);
    for (const i of ranked.slice(MAX_BOOKS_READ)) progress[i].state = 'limit';
    const queue = ranked.slice(0, MAX_BOOKS_READ);
    const results = new Map<number, Evidence[]>();
    const total = queue.length;
    let done = 0;
    status(t('meta.readingBooks', { done, n: total }));
    const worker = async () => {
      while (queue.length && !ctrl.signal.aborted) {
        const i = queue.shift()!;
        if (!skipped(i)) results.set(i, await this.readBook(answer, i, books[i], scans[i]!, plan, base, prefs, ctrl));
        done++;
        status(t('meta.readingBooks', { done, n: total }));
      }
    };
    await Promise.all([worker(), worker()]);
    return ranked.filter((i) => results.has(i)).map((i) => results.get(i)!);
  }

  private async readBook(
    answer: Turn, index: number, book: BookTarget, scan: BookPages, plan: SearchPlan,
    base: LlmClient, prefs: SeekChatPrefs, ctrl: AbortController,
  ): Promise<Evidence[]> {
    const progress = answer.bookProgress![index];
    const bookCtrl = newAbortController();
    this.bookCtrls.set(index, bookCtrl);
    const onAbort = () => bookCtrl.abort();
    ctrl.signal.addEventListener('abort', onAbort);
    progress.state = 'reading';
    this.notify();
    try {
      const client = this.recordingClient(base, answer, () => t('purpose.excerpts', { label: book.label }));
      const reply = await client.streamChat(
        {
          model: prefs.model,
          messages: buildExcerptMessages({ question: plan.question, book: book.label, pages: scan.pages, totalPages: scan.totalPages }),
          temperature: 0.1,
          maxTokens: Math.min(prefs.maxTokens, 4096),
          numCtx: prefs.numCtx,
          signal: bookCtrl.signal,
        },
        () => {},
      );
      const excerpts = parseExcerpts(reply, scan.pages.map((p) => p.pageNumber));
      progress.state = excerpts.length ? 'found' : 'none';
      progress.found = excerpts.length;
      const item = book.attachment.parentItem || book.attachment;
      return excerpts.map((e) => ({
        itemKey: item.key, libraryKey: libraryKeyOf(item.libraryID), label: book.label, origin: 'book' as const,
        attachmentID: book.attachment.id, text: e.text, page: e.page,
      }));
    } catch (e: any) {
      if (bookCtrl.signal.aborted) {
        progress.state = 'skipped';
      } else {
        if (!(e instanceof UserFacingError)) logError(e);
        progress.state = 'error';
        progress.error = String(e?.message || e);
      }
      return [];
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      this.bookCtrls.delete(index);
      this.notify();
    }
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
    const status = (text: string) => {
      answer.meta = text;
      this.notify();
    };
    let purpose = t('purpose.answer');
    const client = this.recordingClient(createClient(prefs), answer, () => purpose);
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
    if (needKeywords) {
      if (!IMPLEMENTED_STRATEGIES.includes(this.strategy)) notes.push(t('meta.strategyFallback'));
      status(t('meta.detectLanguage'));
      purpose = t('purpose.language');
      const { lang, source } = await this.resolveLanguage(provider, client, prefs, ctrl.signal);
      const sourceText = t(source === 'metadata' ? 'meta.languageMetadata' : source === 'model' ? 'meta.languageModel' : 'meta.languageGuess');
      notes.push(lang ? t('meta.language', { language: languageName(lang.code), source: sourceText }) : t('meta.languageUnknown'));
      status(t('meta.makeKeywords'));
      purpose = t('purpose.keywords');
      keywords = await this.expandKeywords(provider, client, prefs, question, lastQuestion, lang, ctrl.signal);
      notes.push(keywords.length ? t('meta.keywords', { keywords: keywords.join(', ') }) : t('meta.noKeywords'));
    }
    purpose = t('purpose.answer');
    const context = await provider.build(`${question}\n${lastQuestion}`, prefs.contextChars, { keywords, chapters });
    answer.meta = [`${prefs.model} · ${describeContext(context)}`, ...notes].join('\n');
    this.notify();
    let raw = '';
    await client.streamChat(
      {
        model: prefs.model,
        messages: buildMessages({ systemPrompt: prefs.systemPrompt, context, history, question }),
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
