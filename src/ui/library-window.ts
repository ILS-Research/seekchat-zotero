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
import { readPrefs } from '../prefs';
import { logError } from '../util/log';
import { renderTurn } from './turn-view';

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

/** The scope the user means by the current selection in the main window. */
export function currentScope(win: any = Zotero.getMainWindow()): LibraryScope {
  const pane = win.ZoteroPane;
  const items = (pane.getSelectedItems?.() || []) as any[];
  if (items.length > 1) return itemsScope(items);
  const collection = pane.getSelectedCollection?.();
  if (collection) return collectionScope(collection);
  return libraryScope(pane.getSelectedLibraryID?.() ?? Zotero.Libraries.userLibraryID);
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
  private scopeEl: HTMLElement;
  private statusEl: HTMLElement;
  private modelEl: HTMLElement;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
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
    this.scopeEl = this.el('span', 'seekchat-library-scope');
    this.statusEl = this.el('span', 'seekchat-library-status');
    this.modelEl = this.el('span', 'seekchat-library-status');
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
    footer.append(settings, this.el('span', 'spacer'), this.clearBtn, close);
    root.replaceChildren(
      row('Umfang:', this.scopeEl, this.statusEl),
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
    this.render();
    void this.checkStatus();
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
    const available = this.status?.available === true;
    this.scopeEl.textContent = this.scope?.label || '';
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

    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 40;
    const turns = s?.turns || [];
    if (!turns.length) {
      this.messages.replaceChildren(this.el('div', 'seekchat-library-empty', available
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
