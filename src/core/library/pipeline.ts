/**
 * The library chat's pipeline for one question. (1) A planning call makes follow-ups standalone
 * and derives queries, (2) ZotSeek and SeekBook are searched and books are pre-read one by one
 * (each skippable), (3) all evidence is merged into numbered sources (stable across follow-ups,
 * cited sources carried over), (4) one streamed answer cites them as [n, S. x].
 *
 * The session owns the chat state; the pipeline reaches it only through PipelineHost.
 */
import { createClient } from '../llm';
import { stripThinking } from '../llm/stream-parsers';
import { buildMessages, compressRanges, describeContext, type HistoryTurn } from '../prompt';
import { languageName, t, tn } from '../../i18n';
import { UserFacingError } from '../errors';
import { getPdfPages, PdfContextProvider } from '../context/pdf-context';
import { buildTerms, countMatchingPages, selectPagesByTerms } from '../context/page-selection';
import { splitSourceCitations } from '../citations';
import type { LlmClient } from '../llm/types';
import {
  attachmentFor, buildSources, formatSources, interleave, sourceId, withoutBooks,
  type Evidence, type LibrarySource, type SourceNumbers,
} from './sources';
import type { LibraryContextProvider } from './library-context';
import { bookKeysInScope, booksInScope, MAX_BOOKS_READ, splitBooks, unindexedBooks, type BookTarget } from './books';
import {
  diagnose as diagnoseSeekBook, readEnvironment as readSeekBookEnvironment, loadBookPages, MAX_PAGES,
  searchableBooks, SeekBookUnavailableError,
} from '../seekbook/client';
import { buildExcerptMessages, parseExcerpts } from './book-excerpts';
import { buildPlanMessages, fallbackPlan, parsePlan, type SearchPlan } from './plan';
import { itemOfSource, libraryKeyOf, pdfTitle } from './zotero-items';
import { diagnose, readEnvironment, ZotSeekUnavailableError } from '../zotseek/client';
import type { SeekChatPrefs } from '../../prefs';
import { expandKeywords, recordingClient, resolveLanguage, type LanguageCache } from '../helper-calls';
import type { BookProgress, BookState, Turn } from '../turn';
import { newAbortController } from '../../util/env';
import { SharedCalls } from '../../util/abort';
import { content, logError, logger } from '../../util/log';

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

/** What the pipeline needs from the chat session. */
export interface PipelineHost {
  readonly turns: Turn[];
  /** Citation numbers per item, stable for the whole chat. */
  readonly sourceNumbers: SourceNumbers;
  /** One controller per book being read, so the session can skip a single book. */
  readonly bookCtrls: Map<number, AbortController>;
  readonly languages: LanguageCache;
  notify(): void;
  /** Prefs with the limits resolved for the current model. */
  answerPrefs(): Promise<SeekChatPrefs>;
}

/**
 * Sources cited in the answers still in the history window, with only the excerpts
 * those answers cited (pages named in [n, S. x]; a source cited without page keeps
 * its first CARRIED_UNPAGED excerpts). Follow-ups discuss this result, so it must be
 * small: before 0.9.6 every excerpt of a cited source came again and follow-ups crawled.
 */
export function carriedSources(turns: Turn[], maxTurns: number): LibrarySource[] {
  const answers = turns.filter((t) => t.role === 'assistant' && !t.error && !t.pending && t.sources?.length);
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
export function knownSources(turns: Turn[]): LibrarySource[] {
  const latest = new Map<number, LibrarySource>();
  for (const turn of turns) {
    if (turn.role === 'assistant' && !turn.error && !turn.pending) for (const s of turn.sources || []) latest.set(s.n, s);
  }
  return Array.from(latest.values()).sort((a, b) => a.n - b.n);
}


export class LibraryPipeline {
  constructor(private host: PipelineHost) {}

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
  async answer(
    answer: Turn,
    library: LibraryContextProvider,
    question: string,
    history: HistoryTurn[],
    ctrl: AbortController,
    opts: { zotseek: boolean; seekbook: boolean; books: BookTarget[]; skipIndexedBooks: boolean },
  ): Promise<void> {
    const prefs = await this.host.answerPrefs();
    const base = createClient(prefs);
    const t0 = Date.now();
    L.info(`library question in ${library.describe()}: ${content(question)} — sources: ${[opts.zotseek && 'ZotSeek', opts.seekbook && 'SeekBook', opts.books.length && `${opts.books.length} keyword books`].filter(Boolean).join(', ') || 'none'}${history.length ? `, ${history.length} history turns` : ''}`);
    const status = (text: string) => {
      L.info(`[${Date.now() - t0} ms] ${text}`);
      answer.meta = text;
      this.host.notify();
    };
    const notes: string[] = [];
    const scope = library.describe();

    // Without ZotSeek's endpoint (and no other source) there is nothing to plan for: fail before any model call.
    // (Follow-ups may still load pages of known sources, which needs no ZotSeek.)
    const missing = opts.zotseek ? diagnose(readEnvironment()) : null;
    if (missing && !opts.books.length && !opts.seekbook && !history.length) throw new ZotSeekUnavailableError(missing);
    const known = knownSources(this.host.turns);

    const searches = opts.zotseek || opts.seekbook;

    // 1. Planning: standalone question for follow-ups, queries for ZotSeek and SeekBook. Books make their own search terms.
    let plan = fallbackPlan(question);
    if (history.length || searches) {
      status(t('meta.planning'));
      const client = recordingClient(base, answer, () => t('purpose.plan'));
      plan = await this.planSearch(client, prefs, question, history, scope, ctrl.signal, known);
      L.info(`plan${plan.fromModel ? '' : ' (fallback)'}: question ${content(plan.question)}, queries ${content(plan.queries, 400)}, search ${plan.search ?? '-'}`);
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
    const carried = carriedSources(this.host.turns, prefs.historyTurns);
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
      this.host.notify();
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
      numbers: this.host.sourceNumbers,
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
    this.host.notify();

    // 4. One answer from all sources.
    const client = recordingClient(base, answer, () => t('purpose.answer'));
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
        this.host.notify();
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
    const keywordsByLanguage = new SharedCalls<string[]>(ctrl.signal);
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
    keywordsByLanguage: SharedCalls<string[]>, mayAnswer: () => boolean,
  ): Promise<Evidence[]> {
    const progress = answer.bookProgress![index];
    const bookCtrl = newAbortController();
    this.host.bookCtrls.set(index, bookCtrl);
    const onAbort = () => bookCtrl.abort();
    ctrl.signal.addEventListener('abort', onAbort);
    const step = (state: BookState) => {
      if (progress.state === 'skipped') throw new Error('skipped');
      L.info(`book "${book.label}": ${state}`);
      progress.state = state;
      this.host.notify();
    };
    try {
      const provider = new PdfContextProvider(book.attachment);
      let purpose = t('purpose.language');
      const client = recordingClient(base, answer, () => `${purpose} – ${book.label}`);

      // 1. Language of the book (metadata, else detected by the model; cached per book).
      step('language');
      const { lang, source } = await resolveLanguage(this.host.languages, provider, client, prefs, bookCtrl.signal);
      progress.language = lang ? languageName(lang.code) : undefined;
      progress.languageSource = source ?? undefined;

      // 2. Search terms in that language, shared by all books of the same language in this question.
      step('keywords');
      purpose = t('purpose.keywords');
      // Shared by the books of this language; a skipped book stops only its own wait (SharedCalls).
      const keywords = await keywordsByLanguage.get(
        lang?.code || '?', (signal) => expandKeywords(provider, client, prefs, plan.question, '', lang, signal), bookCtrl.signal,
      );
      progress.keywords = keywords;
      this.host.notify();

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
      this.host.bookCtrls.delete(index);
      this.host.notify();
    }
  }
}
