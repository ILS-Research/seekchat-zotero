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
import { describeCoverage, scopeCoverage } from '../core/library/coverage';
import { readPrefs } from '../prefs';
import { logError } from '../util/log';
import { renderTurn } from './turn-view';
import { saveChat } from './save-chat';

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
  private statusEl: HTMLElement;
  private modelEl: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
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
    this.zotseekBox = this.checkbox('seekchat-source-zotseek', 'ZotSeek', true, (on) => {
      this.useZotSeek = on;
      this.render();
    });
    // Planned: own vector index for whole books (ZotSeek only indexes the beginning of long documents).
    const booksBox = this.checkbox('seekchat-source-books', 'Bücher (eigener Index)', false, () => {});
    booksBox.disabled = true;
    const books = booksBox.parentElement!;
    books.classList.add('disabled');
    books.append(this.doc.createTextNode(' '), this.el('span', 'seekchat-badge', 'noch ohne Funktion'));
    this.messages = this.el('div', 'seekchat-messages');
    this.input = this.el('textarea', 'seekchat-input') as HTMLTextAreaElement;
    this.input.placeholder = 'Frage an die Bibliothek … (Enter senden, Shift+Enter neue Zeile)';
    this.sendBtn = this.button('Senden', () => (this.session?.busy ? this.session.stop() : this.send()));
    this.clearBtn = this.button('Neuer Chat', () => this.session?.clear());
    const settings = this.button('⚙ Einstellungen', () => this.openSettings());
    const close = this.button('Schließen', () => this.win.close());
    const inputRow = this.el('div', 'seekchat-library-row');
    this.input.style.flex = '1';
    inputRow.append(this.input, this.sendBtn);
    const footer = this.el('div', 'seekchat-library-footer');
    this.saveBtn = this.button('⤓ Chat als .md', () => {
      if (this.session && this.scope) void saveChat(this.session, this.scope.label, this.win);
    });
    this.saveBtn.className = 'seekchat-save';
    footer.append(settings, this.saveBtn, this.el('span', 'spacer'), this.clearBtn, close);
    root.replaceChildren(
      row('Umfang:', this.scopeEl, this.statusEl),
      row('', this.coverageEl),
      row('Quellen:', this.zotseekBox.parentElement!, books),
      // Plain text instead of a tooltip: title tooltips do not show in this chrome window.
      row('', this.el('div', 'seekchat-library-note',
        'ZotSeek ist für Paper gebaut: Bücher nur, wenn dort „Bücher ausschließen“ aus ist, und PDF-Inhalte nur im ' +
        'Modus „full“. Pro Eintrag höchstens 100–200 Abschnitte (bei Büchern meist nur die ersten Kapitel); Schluss ' +
        'beim ersten Literaturverzeichnis; PDFs ohne übergeordneten Eintrag fehlen. Ganze Bücher: Chat mit dem PDF ' +
        'im Eintragsbereich. Ein eigener Index für Bücher ist geplant.')),
      row('Modell:', this.modelEl),
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
    this.win.document.title = `SeekChat – ${scope.label}`;
    this.fillScopes();
    this.render();
    void this.checkStatus();
    void this.checkCoverage(scope);
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

  /** What ZotSeek cannot see in this scope (standalone PDFs, excluded books, abstract-only mode). */
  private async checkCoverage(scope: LibraryScope): Promise<void> {
    this.coverageEl.textContent = '';
    try {
      const text = describeCoverage(await scopeCoverage(scope));
      if (this.scope?.key === scope.key) this.coverageEl.textContent = text;
    } catch (e) {
      logError(e);
    }
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
    if (!q || !this.session || this.session.busy || !this.useZotSeek) return;
    if (!(await this.checkStatus())) return;
    this.input.value = '';
    void this.session.ask(q);
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

  private render(): void {
    const s = this.session;
    const available = this.status?.available === true && this.useZotSeek;
    this.statusEl.className = `seekchat-library-status${this.status && !available ? ' unavailable' : ''}`;
    this.statusEl.textContent = !this.status ? 'Prüfe ZotSeek …'
      : this.status.available ? `ZotSeek: ${formatCount(this.status.stats.indexedPapers)} Einträge indexiert`
      : this.status.message;
    const model = readPrefs().model;
    this.modelEl.textContent = model || 'Kein Modell gewählt – siehe Einstellungen';
    this.input.disabled = !available;
    this.sendBtn.disabled = !available && !s?.busy;
    this.sendBtn.textContent = s?.busy ? 'Stopp' : 'Senden';
    this.clearBtn.disabled = !s || s.turns.length === 0;
    this.saveBtn.disabled = !s || s.busy || s.turns.length === 0;

    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 40;
    const turns = s?.turns || [];
    if (!turns.length) {
      this.messages.replaceChildren(this.el('div', 'seekchat-library-empty', !this.useZotSeek
        ? 'Keine Quelle ausgewählt. Bitte oben unter „Quellen“ ZotSeek anhaken.'
        : available
        ? `Fragen an ${this.scope?.label}. Die Antwort stützt sich auf die passendsten Textstellen, die ZotSeek findet, ` +
          'und nennt die Quellen als [Nr., S. x].'
        : this.status ? 'Chat über die Bibliothek ist gerade nicht möglich (siehe oben). Der Chat mit einzelnen PDFs im ' +
          'Eintragsbereich funktioniert weiterhin.' : ''));
      return;
    }
    const onSource = (source: any, page?: number) => {
      openSourceCitation(source, page).then(() => Zotero.getMainWindow().focus()).catch(logError);
    };
    this.messages.replaceChildren(...turns.map((t) => renderTurn(this.doc, t, { onSource }, 'Suche in der Bibliothek …')));
    if (atBottom || s?.busy) this.messages.scrollTop = this.messages.scrollHeight;
  }

  dispose(): void {
    this.unsubscribe?.();
    if (this.renderTimer) this.win.clearTimeout(this.renderTimer);
  }
}
