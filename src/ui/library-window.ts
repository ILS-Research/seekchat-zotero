/**
 * The library chat window (content/libraryChat.xhtml), opened from the toolbar
 * button next to ZotSeek's. One window; opening it again brings it forward and
 * switches to the scope of the current Zotero selection.
 *
 * Scope on opening: several selected items, else the selected collection, else
 * the selected library. A single item is left to the PDF chat in the item pane.
 */
import {
  collectionScope, itemsScope, libraryScope, LibraryContextProvider, type LibraryScope,
} from '../core/library/library-context';
import { openSourceCitation } from '../core/library/zotero-items';
import { getSession, type ChatSession } from '../core/session';
import { getZotSeekStatus, type ZotSeekStatus } from '../core/zotseek/client';
import { formatCount } from '../core/context/fit';
import { describeCoverage, scopeCoverage, ZOTSEEK_COVERAGE_PREFS, type Coverage } from '../core/library/coverage';
import { seekBookChoice } from '../core/library/source-rules';
import { getSeekBookStatus, type SeekBookStatus } from '../core/seekbook/client';
import { booksInScope } from '../core/library/books';
import { MAX_BOOKS_READ, type BookTarget } from '../core/library/books';
import { readPrefs } from '../prefs';
import { logError } from '../util/log';
import { renderTurn } from './turn-view';
import { t, tn } from '../i18n';
import { saveChat, withFeedback } from './save-chat';
import { saveLibraryChatAsNote } from './save-note';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const WINDOW_URL = 'chrome://seekchat/content/libraryChat.xhtml';
const WINDOW_NAME = 'seekchat-library';

let chatWindow: any = null;
let view: LibraryChatView | null = null;
/** Scope for the next window load (set before openDialog). */
let pendingScope: LibraryScope | null = null;
let prefsPaneID: string | null = null;

export function setPrefsPaneID(id: string | null): void {
  prefsPaneID = id;
}

export function getPrefsPaneID(): string | null {
  return prefsPaneID;
}

/** The scope the user means by the current selection in the main window. */
export function currentScope(win: any = Zotero.getMainWindow()): LibraryScope {
  const pane = win.ZoteroPane;
  const items = (pane.getSelectedItems?.() || []) as any[];
  if (items.length > 1) return itemsScope(items);
  const collection = pane.getSelectedCollection?.();
  if (collection) return collectionScope(collection);
  return libraryScope(pane.getSelectedLibraryID?.() ?? Zotero.Libraries.userLibraryID);
}

/**
 * Scopes offered in the window: the current Zotero selection (several items),
 * the selected collection, every library that ZotSeek can search, and the
 * scope in use (kept even if the selection moved on).
 */
export function scopeChoices(current: LibraryScope | null, win: any = Zotero.getMainWindow()): LibraryScope[] {
  const list: LibraryScope[] = [];
  const add = (make: () => LibraryScope) => {
    try {
      const s = make();
      if (!list.some((x) => x.key === s.key)) list.push(s);
    } catch {
      // not searchable (e.g. feeds): not offered
    }
  };
  const pane = win?.ZoteroPane;
  const items = (pane?.getSelectedItems?.() || []) as any[];
  if (items.length > 1) add(() => itemsScope(items));
  const collection = pane?.getSelectedCollection?.();
  if (collection) add(() => collectionScope(collection));
  for (const lib of Zotero.Libraries.getAll()) {
    if (lib.libraryType === 'user' || lib.libraryType === 'group') add(() => libraryScope(lib.libraryID));
  }
  if (current && !list.some((x) => x.key === current.key)) list.unshift(current);
  return list;
}

export function openLibraryChat(scope?: LibraryScope): void {
  try {
    const target = scope || currentScope();
    if (chatWindow && !chatWindow.closed) {
      view?.setScope(target);
      chatWindow.focus();
      return;
    }
    pendingScope = target;
    chatWindow = Zotero.getMainWindow().openDialog(WINDOW_URL, WINDOW_NAME, 'chrome,centerscreen,resizable,dialog=no');
  } catch (e) {
    logError(e);
  }
}

export function getLibraryChatWindow(): any {
  return chatWindow && !chatWindow.closed ? chatWindow : null;
}

export function onLibraryWindowLoad(win: any): void {
  try {
    const root = win.document.getElementById('seekchat-library-root');
    view = new LibraryChatView(win, root);
    view.setScope(pendingScope || currentScope());
    pendingScope = null;
  } catch (e) {
    logError(e);
  }
}

export function onLibraryWindowUnload(win: any): void {
  if (win === chatWindow) chatWindow = null;
  view?.dispose();
  view = null;
}

export function closeLibraryChat(): void {
  getLibraryChatWindow()?.close();
}

class LibraryChatView {
  private doc: Document;
  private scopeEl: HTMLSelectElement;
  private scopeOptions: LibraryScope[] = [];
  private coverageEl: HTMLElement;
  private zotseekBox: HTMLInputElement;
  /** Source "ZotSeek" (papers from ZotSeek's index); without any source there is nothing to ask. */
  private useZotSeek = true;
  /** Source "books by keyword search": each book in the scope is asked like in the PDF chat. */
  private useBooks = false;
  private books: BookTarget[] | null = null;
  /** Running book search of the current scope (send() waits for it). */
  private booksReady: Promise<void> = Promise.resolve();
  private booksEl!: HTMLElement;
  /** Source "books (own index)" = SeekBook, allowed or locked by seekBookChoice(). */
  private seekbookBox: HTMLInputElement;
  private seekbookEl: HTMLElement;
  private useSeekBook = false;
  private seekbook: SeekBookStatus | null = null;
  private coverage: Coverage | null = null;
  private prefObservers: any[] = [];
  private onFocus = () => {
    void this.checkStatus();
    void this.refreshSources();
  };
  private statusEl: HTMLElement;
  private modelEl: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private noteBtn: HTMLButtonElement;
  private session: ChatSession | null = null;
  private scope: LibraryScope | null = null;
  private status: ZotSeekStatus | null = null;
  private unsubscribe: (() => void) | null = null;
  private renderTimer: any = null;

  constructor(private win: any, root: HTMLElement) {
    this.doc = win.document;
    const row = (label: string, ...content: HTMLElement[]) => {
      const r = this.el('div', 'seekchat-library-row');
      r.append(this.el('span', 'seekchat-library-label', label), ...content);
      return r;
    };
    this.scopeEl = this.el('select', 'seekchat-library-scope') as HTMLSelectElement;
    this.scopeEl.addEventListener('change', () => {
      const chosen = this.scopeOptions[this.scopeEl.selectedIndex];
      if (chosen) this.setScope(chosen);
    });
    // The Zotero selection may have changed since the list was built.
    this.scopeEl.addEventListener('focus', () => this.fillScopes());
    this.coverageEl = this.el('div', 'seekchat-library-note seekchat-library-coverage');
    this.statusEl = this.el('span', 'seekchat-library-status');
    this.modelEl = this.el('span', 'seekchat-library-status');
    this.zotseekBox = this.checkbox('seekchat-source-zotseek', t('lib.sourceZotSeek'), true, (on) => {
      this.useZotSeek = on;
      this.render();
    });
    // Live: ZotSeek's settings (books, SeekBook binding, indexing mode) and plugins switched on or off meanwhile.
    for (const pref of ZOTSEEK_COVERAGE_PREFS) {
      this.prefObservers.push(Zotero.Prefs.registerObserver(pref, () => void this.refreshSources(), true));
    }
    // Gecko's 4th argument (wantsUntrusted): also synthetic focus events, e.g. from tests; the handler only re-checks.
    (this.win as any).addEventListener('focus', this.onFocus, false, true);
    const keywordBooksBox = this.checkbox('seekchat-source-books-keywords', t('lib.sourceBooksKeywords'), false, (on) => {
      this.useBooks = on;
      this.render();
    });
    this.booksEl = this.el('div', 'seekchat-library-note seekchat-library-books');
    // SeekBook: own full-text index for whole books. Allowed or locked by seekBookChoice().
    this.seekbookBox = this.checkbox('seekchat-source-books', t('lib.sourceBooksIndex'), false, (on) => {
      this.useSeekBook = on;
      this.render();
    });
    this.seekbookBox.disabled = true;
    const books = this.seekbookBox.parentElement!;
    this.seekbookEl = this.el('div', 'seekchat-library-note seekchat-library-seekbook');
    this.messages = this.el('div', 'seekchat-messages');
    this.input = this.el('textarea', 'seekchat-input') as HTMLTextAreaElement;
    this.input.placeholder = t('lib.placeholder');
    this.sendBtn = this.button(t('common.send'), () => (this.session?.busy ? this.session.stop() : this.send()));
    this.clearBtn = this.button(t('common.newChat'), () => this.session?.clear());
    const settings = this.button(t('common.settings'), () => this.openSettings());
    const close = this.button(t('common.close'), () => this.win.close());
    const inputRow = this.el('div', 'seekchat-library-row');
    this.input.style.flex = '1';
    inputRow.append(this.input, this.sendBtn);
    const footer = this.el('div', 'seekchat-library-footer');
    this.saveBtn = this.button(t('common.saveMdShort'), () => {
      if (this.session && this.scope) void saveChat(this.session, this.scope.label, this.win);
    });
    this.saveBtn.className = 'seekchat-save';
    this.noteBtn = this.button(t('common.saveNoteShort'), () => {
      const s = this.session;
      const scope = this.scope;
      if (s && scope) void withFeedback(this.noteBtn, () => saveLibraryChatAsNote(s, scope), t('common.noteSaved'));
    });
    this.noteBtn.className = 'seekchat-save seekchat-save-note';
    footer.append(settings, this.saveBtn, this.noteBtn, this.el('span', 'spacer'), this.clearBtn, close);
    root.replaceChildren(
      row(t('lib.scope'), this.scopeEl, this.statusEl),
      row('', this.coverageEl),
      row(t('lib.sources'), this.zotseekBox.parentElement!, keywordBooksBox.parentElement!, books),
      row('', this.booksEl),
      row('', this.seekbookEl),
      // Plain text instead of a tooltip: title tooltips do not show in this chrome window.
      row('', this.el('div', 'seekchat-library-note seekchat-library-zotseek-note', t('lib.zotseekNote'))),
      row(t('lib.model'), this.modelEl),
      this.messages,
      inputRow,
      footer,
    );
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
  }

  private el(tag: string, cls?: string, text?: string): HTMLElement {
    const e = this.doc.createElementNS(HTML_NS, tag) as HTMLElement;
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** Checkbox inside its label; returns the input (its parent is the label). */
  private checkbox(id: string, label: string, checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
    const wrap = this.el('label', 'seekchat-library-source');
    const box = this.el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.id = id;
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    wrap.append(box, this.doc.createTextNode(` ${label}`));
    return box;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = this.el('button', '', label) as HTMLButtonElement;
    b.addEventListener('click', onClick);
    return b;
  }

  setScope(scope: LibraryScope): void {
    if (this.scope?.key === scope.key && this.session) {
      void this.checkStatus();
      return;
    }
    this.unsubscribe?.();
    this.scope = scope;
    this.session = getSession(new LibraryContextProvider(scope));
    this.unsubscribe = this.session.subscribe(() => this.scheduleRender());
    this.win.document.title = t('lib.windowTitle', { scope: scope.label });
    this.fillScopes();
    this.render();
    void this.checkStatus();
    void this.refreshSources();
    this.booksReady = this.findBooks(scope);
  }

  private fillScopes(): void {
    this.scopeOptions = scopeChoices(this.scope);
    this.scopeEl.replaceChildren(...this.scopeOptions.map((s) => {
      const o = this.el('option', '', s.label) as HTMLOptionElement;
      o.value = s.key;
      return o;
    }));
    this.scopeEl.selectedIndex = Math.max(0, this.scopeOptions.findIndex((s) => s.key === this.scope?.key));
  }

  private async findBooks(scope: LibraryScope): Promise<void> {
    this.books = null;
    this.render();
    try {
      const books = await booksInScope(scope);
      if (this.scope?.key === scope.key) this.books = books;
    } catch (e) {
      logError(e);
      this.books = [];
    }
    this.render();
  }

  /**
   * SeekBook's status and what ZotSeek covers in the scope (its books: own
   * index, through SeekBook or excluded). Both decide whether "Books (own
   * index)" may be switched on; re-run on focus and when ZotSeek's prefs change.
   */
  private async refreshSources(): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    try {
      this.seekbook = await getSeekBookStatus();
      const coverage = await scopeCoverage(scope, this.seekbook.available);
      if (this.scope?.key === scope.key) this.coverage = coverage;
    } catch (e) {
      logError(e);
    }
    this.render();
  }

  /** ZotSeek can be switched off while the window is open; checked on open, scope change and before each question. */
  private async checkStatus(): Promise<boolean> {
    try {
      this.status = await getZotSeekStatus();
    } catch (e) {
      logError(e);
      this.status = { available: false, reason: 'error', message: String(e) };
    }
    this.render();
    return this.status.available;
  }

  private async send(): Promise<void> {
    const q = this.input.value.trim();
    if (!q || !this.session || this.session.busy) return;
    const zotseek = this.useZotSeek && (await this.checkStatus());
    const seekbook = this.seekbookUsable();
    // The book search may still run right after opening; without waiting the books would silently be left out.
    if (this.useBooks && this.books === null) await this.booksReady;
    const books = this.useBooks ? this.books || [] : [];
    if (!zotseek && !seekbook && !books.length) return;
    this.input.value = '';
    void this.session.ask(q, { zotseek, seekbook, books });
  }

  private openSettings(): void {
    const main = Zotero.getMainWindow();
    Zotero.Utilities.Internal.openPreferences(prefsPaneID || undefined);
    main?.focus();
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = this.win.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 60);
  }

  /** SeekBook chosen, ready and not locked (ZotSeek already bringing its books). */
  private seekbookUsable(): boolean {
    return this.useSeekBook && this.seekbook?.available === true && !this.seekbookBox.disabled;
  }

  private render(): void {
    const s = this.session;
    this.renderSources();
    const zotseekOk = this.status?.available === true && this.useZotSeek;
    const nBooks = this.books?.length ?? 0;
    const booksOk = this.useBooks && nBooks > 0;
    const seekbookOk = this.seekbookUsable();
    const available = zotseekOk || booksOk || seekbookOk;
    this.booksEl.textContent = !this.useBooks ? ''
      : this.books === null ? t('lib.booksSearching')
      : !nBooks ? t('lib.booksNone')
      : tn('lib.books', nBooks, { max: MAX_BOOKS_READ });
    this.statusEl.className = `seekchat-library-status${this.status && !this.status.available && this.useZotSeek ? ' unavailable' : ''}`;
    this.statusEl.textContent = !this.status ? t('lib.checking')
      : this.status.available ? t('lib.indexed', { n: formatCount(this.status.stats.indexedPapers) })
      : this.status.message;
    const model = readPrefs().model;
    this.modelEl.textContent = model || t('common.noModel');
    this.input.disabled = !available;
    this.sendBtn.disabled = !available && !s?.busy;
    this.sendBtn.textContent = s?.busy ? t('common.stop') : t('common.send');
    this.clearBtn.disabled = !s || s.turns.length === 0;
    this.saveBtn.disabled = !s || s.busy || s.turns.length === 0;
    if (!this.noteBtn.textContent?.includes('✓')) this.noteBtn.disabled = this.saveBtn.disabled;

    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 40;
    const turns = s?.turns || [];
    if (!turns.length) {
      this.messages.replaceChildren(this.el('div', 'seekchat-library-empty', !this.useZotSeek && !this.useBooks && !this.useSeekBook
        ? t('lib.noSource')
        : available
        ? t('lib.intro', { scope: this.scope?.label || '' }) +
          (zotseekOk ? t('lib.introZotSeek', { pageLabel: t('cite.page') }) : '') +
          (seekbookOk ? t('lib.introSeekBook', { pageLabel: t('cite.page') }) : '') +
          (booksOk ? t('lib.introBooks', { n: nBooks, pageLabel: t('cite.page') }) : '')
        : this.status ? t('lib.unavailable') : ''));
      return;
    }
    const onSource = (source: any, page?: number, attachmentID?: number) => {
      openSourceCitation(source, page, attachmentID).then(() => Zotero.getMainWindow().focus()).catch(logError);
    };
    const onSkipBook = (turn: any, index: number) => s?.skipBook(turn, index);
    this.messages.replaceChildren(...turns.map((turn) => renderTurn(this.doc, turn, { onSource, onSkipBook }, t('lib.searching'))));
    if (atBottom || s?.busy) this.messages.scrollTop = this.messages.scrollHeight;
  }

  /** Coverage line (only with ZotSeek chosen) and the SeekBook switch with its reason. */
  private renderSources(): void {
    this.coverageEl.textContent = this.useZotSeek && this.coverage ? describeCoverage(this.coverage) : '';
    const choice = seekBookChoice({
      seekbook: this.seekbook,
      useZotSeek: this.useZotSeek,
      zotseekAvailable: this.status?.available === true,
      zotseekBooks: this.coverage?.bookMode ?? 'excluded',
    });
    this.seekbookBox.disabled = !choice.enabled;
    this.seekbookBox.parentElement!.classList.toggle('disabled', !choice.enabled);
    if (!choice.enabled && this.useSeekBook) {
      this.useSeekBook = false;
      this.seekbookBox.checked = false;
    }
    const notes: string[] = [];
    if (!this.seekbook) notes.push(t('lib.checking'));
    else if (!this.seekbook.available) notes.push(this.seekbook.message);
    else if (choice.reason === 'viaZotSeek') notes.push(t('lib.seekbookViaZotSeek'));
    else {
      notes.push(t('lib.seekbookReady', { n: formatCount(this.seekbook.indexedBooks) }));
      if (choice.reason === 'nativeToo' && this.useSeekBook) notes.push(t('lib.seekbookNativeToo'));
      if (this.useSeekBook && this.useBooks) notes.push(t('lib.seekbookSplitsBooks'));
    }
    this.seekbookEl.textContent = notes.join(' ');
  }

  dispose(): void {
    for (const o of this.prefObservers) Zotero.Prefs.unregisterObserver(o);
    this.prefObservers = [];
    this.win.removeEventListener('focus', this.onFocus);
    this.unsubscribe?.();
    if (this.renderTimer) this.win.clearTimeout(this.renderTimer);
  }
}
