/**
 * One chat per context (a PDF attachment, or a library scope). Sessions live in
 * memory for the Zotero session, so switching items and coming back keeps the chat.
 *
 * Library chat: one answer per question from all sources. (1) A planning call
 * makes follow-ups standalone and derives queries for ZotSeek, (2) ZotSeek is
 * searched and each book is asked like in the PDF chat (each skippable), (3) all
 * evidence is merged into numbered sources (stable across follow-ups, cited
 * sources carried over), (4) one streamed answer cites them as [n, S. x].
 */
import { createClient } from './llm';
import { stripThinking } from './llm/stream-parsers';
import { buildMessages, compressRanges, describeContext, type HistoryTurn } from './prompt';
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
  attachmentFor, buildSources, formatSources, interleave, sourceId, withoutBooks,
  type Evidence, type LibrarySource, type SourceNumbers,
} from './library/sources';
import { LibraryContextProvider } from './library/library-context';
import { logger } from '../util/log';
import { indexState, semanticPages } from './context/index-access';
import { bookKeysInScope, booksInScope, MAX_BOOKS_READ, splitBooks, unindexedBooks, type BookTarget } from './library/books';
import { diagnose as diagnoseSeekBook, readEnvironment as readSeekBookEnvironment, loadBookPages, MAX_PAGES, searchableBooks, SeekBookUnavailableError } from './seekbook/client';
import { buildExcerptMessages, parseExcerpts } from './library/book-excerpts';
import { buildPlanMessages, fallbackPlan, parsePlan, type SearchPlan } from './library/plan';
import { itemOfSource, libraryKeyOf, pdfTitle } from './library/zotero-items';
import { buildTerms, countMatchingPages, selectPagesByTerms } from './context/page-selection';
import { getPdfPages } from './context/pdf-context';
import { splitSourceCitations } from './citations';
import { diagnose, readEnvironment, ZotSeekUnavailableError } from './zotseek/client';
import { readPrefs, type SeekChatPrefs } from '../prefs';
import { resolveLimits } from './limits';
import { newAbortController } from '../util/env';
import { logError } from '../util/log';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Fixed hint from SeekChat shown after this answer as its own message (never sent to the model). */
  notice?: string;
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

const L = logger('Chat');
/** Excerpts kept of a source an earlier answer cited without page. */
const CARRIED_UNPAGED = 2;
/**
 * A follow-up that searches again only tops up the result so far: fewer hits per
 * query and a smaller budget (a share of the text budget, at least FOLLOWUP_MIN_CHARS).
 * Without this a new aspect ("and what is a backlog?") sent a prompt as large as the first.
 */
const FOLLOWUP_TOP_K = 8;
const FOLLOWUP_SHARE = 0.35;
const FOLLOWUP_MIN_CHARS = 12000;

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

/** Strategies the user can pick for long documents; "vector" is not implemented yet. */
export const IMPLEMENTED_STRATEGIES: LongDocStrategy[] = ['vector', 'keywords', 'chapters'];

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
        { model: prefs.model, messages: buildLanguageMessages(sample), temperature: 0, maxTokens: 64, numCtx: prefs.numCtx, think: false, signal },
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
          numCtx: prefs.numCtx,
          think: false,
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
        const why = purpose();
        L.info(`model call: ${why}`);
        (answer.requests ??= []).push({
          purpose: why,
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
        await this.run(answer, ctrl, () => this.answerLibrary(answer, library, q, history, ctrl, { zotseek: opts.zotseek !== false, seekbook: !!opts.seekbook, books, skipIndexedBooks: split }));
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

  /**
   * Sources cited in the answers still in the history window, with only the excerpts
   * those answers cited (pages named in [n, S. x]; a source cited without page keeps
   * its first CARRIED_UNPAGED excerpts). Follow-ups discuss this result, so it must be
   * small: before 0.9.6 every excerpt of a cited source came again and follow-ups crawled.
   */
  private carriedSources(maxTurns: number): LibrarySource[] {
    const answers = this.turns.filter((t) => t.role === 'assistant' && !t.error && !t.pending && t.sources?.length);
    const latest = new Map<string, LibrarySource>();
    for (const turn of answers) for (const s of turn.sources!) latest.set(sourceId(s), s);
    const cited = new Map<string, { source: LibrarySource; pages: Set<number>; unpaged: boolean }>();
    for (const turn of answers.slice(Math.max(0, answers.length - maxTurns))) {
      const byN = new Map(turn.sources!.map((s) => [s.n, s]));
      for (const seg of splitSourceCitations(turn.content, (x) => byN.has(x))) {
        if (seg.type !== 'source') continue;
        const id = sourceId(byN.get(seg.n)!);
        const entry = cited.get(id) || { source: latest.get(id)!, pages: new Set<number>(), unpaged: false };
        if (seg.page) entry.pages.add(seg.page);
        else entry.unpaged = true;
        cited.set(id, entry);
      }
    }
    return Array.from(cited.values()).map(({ source, pages, unpaged }) => {
      const onPages = source.excerpts.filter((e) => e.page && pages.has(e.page));
      const rest = unpaged ? source.excerpts.filter((e) => !onPages.includes(e)).slice(0, CARRIED_UNPAGED) : [];
      return { ...source, excerpts: [...onPages, ...rest] };
    }).filter((s) => s.excerpts.length).sort((a, b) => a.n - b.n);
  }

  /** All sources of earlier answers in this chat, latest excerpts, by number. */
  private knownSources(): LibrarySource[] {
    const latest = new Map<number, LibrarySource>();
    for (const turn of this.turns) {
      if (turn.role === 'assistant' && !turn.error && !turn.pending) for (const s of turn.sources || []) latest.set(s.n, s);
    }
    return Array.from(latest.values()).sort((a, b) => a.n - b.n);
  }

  /**
   * 7e-2: loads what the planner asked for. Pages come from the source's PDF (the book's
   * PDF it was read from, else the item's best PDF); documents are searched with ZotSeek
   * within that item only. Results go into the prompt first; every step is noted in the meta.
   */
  private async loadRequested(
    plan: SearchPlan, known: LibrarySource[], library: LibraryContextProvider,
    notes: string[], status: (text: string) => void, signal: AbortSignal,
  ): Promise<Evidence[]> {
    const out: Evidence[] = [];
    const byN = new Map(known.map((s) => [s.n, s]));
    for (const req of plan.loadPages || []) {
      const source = byN.get(req.source)!;
      status(t('meta.loadingPages', { n: source.n, pages: compressRanges(req.pages) }));
      try {
        const item = itemOfSource(source);
        // The PDF the requested pages belong to (a book can have several).
        const id = attachmentFor(source, req.pages[0]);
        const att = (id && Zotero.Items.get(id))
          || (item?.isAttachment?.() ? item : await item?.getBestAttachment?.());
        if (!att?.isPDFAttachment?.()) throw new UserFacingError(t('error.noPdf'));
        // Indexed books: SeekBook's cleaned pages (no running headers), else the PDF's own text.
        let pages: { pageNumber: number; text: string }[] | null = null;
        let via = 'PDF';
        if (item?.itemType === 'book' && diagnoseSeekBook(readSeekBookEnvironment()) === null) {
          pages = await this.seekBookPages(item, att, req.pages, signal);
          if (pages) via = 'SeekBook';
        }
        if (!pages) pages = (await getPdfPages(att)).filter((p) => req.pages.includes(p.pageNumber) && p.text);
        if (!pages.length) throw new UserFacingError(t('error.noSuchPages'));
        L.info(`load pages [${source.n}] ${compressRanges(req.pages)} via ${via}: ${pages.length} pages`);
        for (const p of pages) {
          out.push({ itemKey: source.itemKey, libraryKey: source.libraryKey, label: source.label, origin: source.origin ?? 'zotseek',
            attachmentID: att.id, attachmentTitle: pdfTitle(att), text: p.text, page: p.pageNumber, loaded: true });
        }
        notes.push(t('meta.loadedPages', { n: source.n, pageLabel: t('cite.page'), pages: compressRanges(pages.map((p) => p.pageNumber)) }));
      } catch (e: any) {
        if (signal.aborted) throw e;
        if (!(e instanceof UserFacingError)) logError(e);
        notes.push(t('meta.loadFailed', { what: `[${source.n}] ${t('cite.page')} ${compressRanges(req.pages)}`, message: String(e?.message || e) }));
      }
    }
    for (const req of plan.loadDocuments || []) {
      const source = req.source !== undefined ? byN.get(req.source) : undefined;
      const item = source ? itemOfSource(source) : library.findItem(req.title || '');
      const name = source ? `[${source.n}] ${source.label}` : `„${req.title}“`;
      status(t('meta.searchingDocument', { name }));
      try {
        if (!item) throw new UserFacingError(t('error.documentNotFound'));
        const target = { itemKey: item.key, libraryKey: libraryKeyOf(item.libraryID) };
        // Books: SeekBook first (ZotSeek usually excludes books or has only their first chapters), then ZotSeek.
        let found: Evidence[] = [];
        let via = 'ZotSeek';
        if (item.itemType === 'book' && diagnoseSeekBook(readSeekBookEnvironment()) === null) {
          try {
            found = (await library.searchBookIndex([req.query], [item.key], signal, FOLLOWUP_TOP_K)).filter((e) => e.text);
            via = 'SeekBook';
          } catch (e: any) {
            if (!(e instanceof SeekBookUnavailableError)) throw e;
          }
        }
        if (!found.length) {
          found = (await library.searchInItem(req.query, target, signal)).filter((e) => e.text);
          via = 'ZotSeek';
        }
        out.push(...found);
        notes.push(t('meta.searchedDocument', { name, query: req.query, n: found.length, via }));
      } catch (e: any) {
        if (signal.aborted) throw e;
        if (!(e instanceof UserFacingError)) logError(e);
        notes.push(t('meta.loadFailed', { what: name, message: String(e?.message || e) }));
      }
    }
    return out;
  }

  /**
   * Pages of an indexed book from SeekBook (`/seekbook/pages`, runs of consecutive pages, at most 10 per request).
   * Null when SeekBook cannot serve them (book not indexed, error): the caller reads the PDF instead.
   */
  private async seekBookPages(item: any, att: any, wanted: number[], signal: AbortSignal): Promise<{ pageNumber: number; text: string }[] | null> {
    const libraryKey = libraryKeyOf(item.libraryID);
    if (!libraryKey) return null;
    const runs: [number, number][] = [];
    for (const p of [...wanted].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && p === last[1] + 1 && p - last[0] < MAX_PAGES) last[1] = p;
      else runs.push([p, p]);
    }
    const out: { pageNumber: number; text: string }[] = [];
    try {
      for (const [from, to] of runs) {
        const res = await loadBookPages(libraryKey, att.key, from, to, signal);
        for (const p of res.pages) out.push({ pageNumber: p.page, text: p.text });
      }
    } catch (e: any) {
      if (signal.aborted) throw e;
      L.info(`SeekBook pages not available (${e?.message || e}), reading the PDF`);
      return null;
    }
    return out.length ? out : null;
  }

  /** Step 1: standalone question and ZotSeek queries; the question itself if the model fails. */
  private async planSearch(
    client: LlmClient, prefs: SeekChatPrefs, question: string, history: HistoryTurn[], scope: string, signal: AbortSignal,
    known: LibrarySource[],
  ): Promise<SearchPlan> {
    try {
      // From the second question on, the planner may ask to load pages or search in a named document (7e-2).
      const sources = history.length ? known.map((s) => ({ n: s.n, label: s.label, book: s.origin === 'book' })) : undefined;
      const reply = await client.streamChat(
        { model: prefs.model, messages: buildPlanMessages({ question, history, scope, sources }), temperature: 0.1, maxTokens: 1024, numCtx: prefs.numCtx, think: false, signal },
        () => {},
      );
      return parsePlan(reply, question, sources ? new Set(known.map((s) => s.n)) : undefined);
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
    opts: { zotseek: boolean; seekbook: boolean; books: BookTarget[]; skipIndexedBooks: boolean },
  ): Promise<void> {
    const prefs = await this.answerPrefs();
    const base = createClient(prefs);
    const t0 = Date.now();
    L.info(`library question in ${library.describe()}: "${question.slice(0, 120)}" — sources: ${[opts.zotseek && 'ZotSeek', opts.seekbook && 'SeekBook', opts.books.length && `${opts.books.length} keyword books`].filter(Boolean).join(', ') || 'none'}${history.length ? `, ${history.length} history turns` : ''}`);
    const status = (text: string) => {
      L.info(`[${Date.now() - t0} ms] ${text}`);
      answer.meta = text;
      this.notify();
    };
    const notes: string[] = [];
    const scope = library.describe();

    // Without ZotSeek's endpoint (and no other source) there is nothing to plan for: fail before any model call.
    // (Follow-ups may still load pages of known sources, which needs no ZotSeek.)
    const missing = opts.zotseek ? diagnose(readEnvironment()) : null;
    if (missing && !opts.books.length && !opts.seekbook && !history.length) throw new ZotSeekUnavailableError(missing);
    const known = this.knownSources();

    const searches = opts.zotseek || opts.seekbook;

    // 1. Planning: standalone question for follow-ups, queries for ZotSeek and SeekBook. Books make their own search terms.
    let plan = fallbackPlan(question);
    if (history.length || searches) {
      status(t('meta.planning'));
      const client = this.recordingClient(base, answer, () => t('purpose.plan'));
      plan = await this.planSearch(client, prefs, question, history, scope, ctrl.signal, known);
      L.info(`plan${plan.fromModel ? '' : ' (fallback)'}: question "${plan.question.slice(0, 120)}", queries ${JSON.stringify(plan.queries)}`, plan);
      if (!plan.fromModel) {
        notes.push(t('meta.planFailed'));
      } else {
        if (plan.question !== question) notes.push(t('meta.understood', { question: plan.question }));
        if (searches && (!history.length || plan.search)) notes.push(t('meta.queries', { queries: plan.queries.map((x) => `„${x}“`).join(', ') }));
      }
    }

    // From the second question on the chat discusses the result so far: the cited passages come again, pages and
    // documents asked for are loaded, and the sources are searched again only when the planner says the question
    // needs new material (or planning failed and nothing is carried).
    const carried = this.carriedSources(prefs.historyTurns);
    const followUp = history.length > 0 && known.length > 0;
    const searchNow = !followUp || plan.search === true || (!plan.fromModel && !carried.length);
    if (followUp) notes.push(t(searchNow ? 'meta.followupSearch' : 'meta.followupNoSearch'));
    const topUp = followUp && searchNow;
    const topK = topUp ? FOLLOWUP_TOP_K : undefined;
    const budget = topUp ? Math.min(prefs.contextChars, Math.max(FOLLOWUP_MIN_CHARS, Math.round(prefs.contextChars * FOLLOWUP_SHARE))) : prefs.contextChars;
    L.info(`follow-up: ${followUp}, new search: ${searchNow}, carried sources: ${carried.length} (${carried.reduce((n, c) => n + c.excerpts.length, 0)} excerpts)`);

    // Books SeekBook can search go to its index, the rest to the keyword reading (M4).
    let bookKeys: string[] | undefined;
    let indexedBooks: Set<string> | null = null;
    let keywordBooks = searchNow ? opts.books : [];
    if (searchNow && (opts.seekbook || (opts.skipIndexedBooks && opts.books.length))) {
      bookKeys = bookKeysInScope(library.scope);
      try {
        indexedBooks = await searchableBooks(library.scope.libraryKey || 'user', bookKeys, ctrl.signal);
      } catch (e: any) {
        if (!(e instanceof SeekBookUnavailableError)) throw e;
      }
      if (opts.books.length) {
        const split = splitBooks(opts.books, indexedBooks);
        keywordBooks = split.keyword;
        if (split.indexed.length) notes.push(tn('meta.booksViaSeekBook', split.indexed.length));
        L.info(`books split: ${split.indexed.length} via index, ${split.keyword.length} by keywords${indexedBooks ? '' : ' (SeekBook coverage unknown)'}`);
      }
    }
    if (searchNow && opts.seekbook && indexedBooks && !opts.books.length) {
      // Step 6: books SeekBook cannot search are missing from the answer unless the keyword reading covers them.
      const missing = unindexedBooks(await booksInScope(library.scope), indexedBooks);
      if (missing.length) {
        const names = [...new Set(missing.map((b) => b.label.replace(/ · .*$/, '')))];
        notes.push(tn('meta.booksNotIndexed', names.length, { names: names.slice(0, 5).join('; ') + (names.length > 5 ? ' …' : '') }));
        L.info(`books not indexed in SeekBook: ${names.length}`);
      }
    }
    if (keywordBooks.length && !answer.bookProgress) {
      answer.bookProgress = keywordBooks.map((b) => ({ label: b.label, attachmentID: b.attachment.id, state: 'waiting' as BookState }));
      this.notify();
    }
    // 2. Evidence: pages and documents asked for (7e-2), then each source.
    const loaded = await this.loadRequested(plan, known, library, notes, status, ctrl.signal);
    const others = keywordBooks.length > 0 || loaded.length > 0;
    let zotseek: Evidence[] = [];
    if (opts.zotseek && searchNow) {
      status(t('meta.searchingZotSeek'));
      try {
        zotseek = await L.time('ZotSeek search', () => library.searchEvidence(plan.queries, ctrl.signal, topK), (r) => `${r.length} passages`);
      } catch (e: any) {
        // With other sources or loaded pages there is still something to answer from.
        if ((!others && !opts.seekbook) || !(e instanceof ZotSeekUnavailableError)) throw e;
        notes.push(t('meta.zotseekSkipped', { message: e.message }));
      }
    }
    let seekbook: Evidence[] = [];
    if (opts.seekbook && searchNow) {
      status(t('meta.searchingSeekBook'));
      try {
        seekbook = await L.time('SeekBook search', () => library.searchBookIndex(plan.queries, bookKeys, ctrl.signal, topK), (r) => `${r.length} passages`);
        // ZotSeek indexing books itself would bring the same books again.
        const covered = new Set(seekbook.map(sourceId));
        if (indexedBooks) for (const key of indexedBooks) covered.add(sourceId({ libraryKey: library.scope.libraryKey ?? null, itemKey: key }));
        const before = zotseek.length;
        zotseek = withoutBooks(zotseek, covered);
        if (zotseek.length < before) notes.push(tn('meta.zotseekBookDuplicates', before - zotseek.length));
        notes.push(tn('meta.seekbookPassages', seekbook.length, { books: new Set(seekbook.map(sourceId)).size }));
      } catch (e: any) {
        if ((!others && !opts.zotseek) || !(e instanceof SeekBookUnavailableError)) throw e;
        notes.push(t('meta.seekbookSkipped', { message: e.message }));
      }
    }
    const fromBooks = keywordBooks.length ? await this.readBooks(answer, keywordBooks, plan, base, prefs, ctrl, status) : [];
    if (ctrl.signal.aborted) throw new Error('aborted');
    if (answer.bookProgress) notes.push(this.booksSummary(answer.bookProgress));

    // 3. One numbered source list; sources cited before come first and keep their numbers.
    const set = buildSources([...loaded, ...interleave(zotseek, seekbook, ...fromBooks)], budget, {
      numbers: this.sourceNumbers,
      carried,
    });
    if (!set.sources.length) {
      const onlyZotSeek = !opts.books.length && !opts.seekbook;
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
    L.info(`[${Date.now() - t0} ms] sources: ${set.sources.length} (${books} books), ${set.passagesUsed} excerpts, ${set.chars} chars, ${set.overBudget} over budget, ${set.withoutText} without text, ${set.carried} carried; answering`);
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
        think: prefs.thinking,
        signal: ctrl.signal,
      },
      (delta) => {
        raw += delta;
        answer.content = stripThinking(raw);
        this.notify();
      },
    );
    L.info(`[${Date.now() - t0} ms] answer done: ${answer.content.length} chars`);
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
   * Books, each like in the PDF chat: language, search terms in that language
   * (one model call per language and question, shared by the books), local
   * keyword check (no hit: done, no model call), page selection as in the PDF chat,
   * then the question answered from those pages. Two books at a time; each has its
   * own abort controller, so skipBook() cancels just that one. At most
   * MAX_BOOKS_READ books get the answering call. Returns one evidence list per book.
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
    const keywordsByLanguage = new Map<string, Promise<string[]>>();
    const results = new Map<number, Evidence[]>();
    const queue = books.map((_, i) => i);
    let answering = 0;
    let done = 0;
    status(t('meta.readingBooks', { done, n: books.length }));
    const worker = async () => {
      while (queue.length && !ctrl.signal.aborted) {
        const i = queue.shift()!;
        if (answer.bookProgress![i].state !== 'skipped') {
          results.set(i, await this.readBook(answer, i, books[i], plan, base, prefs, ctrl, keywordsByLanguage, () => answering++ < MAX_BOOKS_READ));
        }
        done++;
        status(t('meta.readingBooks', { done, n: books.length }));
      }
    };
    await Promise.all([worker(), worker()]);
    return books.map((_, i) => results.get(i)).filter((r): r is Evidence[] => !!r?.length);
  }

  private async readBook(
    answer: Turn, index: number, book: BookTarget, plan: SearchPlan,
    base: LlmClient, prefs: SeekChatPrefs, ctrl: AbortController,
    keywordsByLanguage: Map<string, Promise<string[]>>, mayAnswer: () => boolean,
  ): Promise<Evidence[]> {
    const progress = answer.bookProgress![index];
    const bookCtrl = newAbortController();
    this.bookCtrls.set(index, bookCtrl);
    const onAbort = () => bookCtrl.abort();
    ctrl.signal.addEventListener('abort', onAbort);
    const step = (state: BookState) => {
      if (progress.state === 'skipped') throw new Error('skipped');
      L.info(`book "${book.label}": ${state}`);
      progress.state = state;
      this.notify();
    };
    try {
      const provider = new PdfContextProvider(book.attachment);
      let purpose = t('purpose.language');
      const client = this.recordingClient(base, answer, () => `${purpose} – ${book.label}`);

      // 1. Language of the book (metadata, else detected by the model; cached per book).
      step('language');
      const { lang, source } = await this.resolveLanguage(provider, client, prefs, bookCtrl.signal);
      progress.language = lang ? languageName(lang.code) : undefined;
      progress.languageSource = source ?? undefined;

      // 2. Search terms in that language, shared by all books of the same language in this question.
      step('keywords');
      purpose = t('purpose.keywords');
      const langKey = lang?.code || '?';
      let pending = keywordsByLanguage.get(langKey);
      if (!pending) {
        pending = this.expandKeywords(provider, client, prefs, plan.question, '', lang, bookCtrl.signal);
        keywordsByLanguage.set(langKey, pending);
        // A skipped book must not leave its books-mates without search terms.
        pending.catch(() => keywordsByLanguage.delete(langKey));
      }
      const keywords = await pending;
      progress.keywords = keywords;
      this.notify();

      // 3. Keyword check and page selection as in the PDF chat (whole book if it fits).
      const all = await getPdfPages(book.attachment);
      const terms = buildTerms(plan.question, keywords);
      if (!countMatchingPages(all, terms)) {
        step('nohits');
        return [];
      }
      if (!mayAnswer()) {
        step('limit');
        return [];
      }
      const selection = selectPagesByTerms(all, terms, prefs.contextChars);
      progress.pages = selection.pages.map((p) => p.pageNumber);
      progress.totalPages = all.length;

      // 4. The question, answered from these pages.
      step('reading');
      purpose = t('purpose.bookAnswer');
      const reply = await client.streamChat(
        {
          model: prefs.model,
          messages: buildExcerptMessages({
            question: plan.question, book: book.label, pages: selection.pages, totalPages: all.length,
            language: lang?.name ?? null, complete: selection.mode === 'full',
          }),
          temperature: 0.1,
          maxTokens: Math.min(prefs.maxTokens, 4096),
          numCtx: prefs.numCtx,
          think: false,
          signal: bookCtrl.signal,
        },
        () => {},
      );
      const excerpts = parseExcerpts(reply, progress.pages);
      step(excerpts.length ? 'found' : 'none');
      progress.found = excerpts.length;
      const item = book.attachment.parentItem || book.attachment;
      return excerpts.map((e) => ({
        itemKey: item.key, libraryKey: libraryKeyOf(item.libraryID), label: book.label, origin: 'book' as const,
        attachmentID: book.attachment.id, attachmentTitle: pdfTitle(book.attachment), text: e.text, page: e.page,
      }));
    } catch (e: any) {
      if (bookCtrl.signal.aborted || progress.state === 'skipped') {
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
    const t0 = Date.now();
    L.info(`PDF question in ${provider.describe()}: "${question.slice(0, 120)}"`);
    const status = (text: string) => {
      L.info(`[${Date.now() - t0} ms] ${text}`);
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
    let rankedPages: { page: number; pageEnd?: number }[] | undefined;
    if (!fit.fits && this.strategy === 'vector' && provider instanceof PdfContextProvider) {
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
    const context = await provider.build(`${question}\n${lastQuestion}`, prefs.contextChars, { keywords, chapters, rankedPages });
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
