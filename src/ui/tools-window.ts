/**
 * The tool chat window (content/toolsChat.xhtml): a general chat whose model acts in Zotero through tools
 * (core/tools/). One window; opening it again brings it forward. Items the tools create go to the target
 * chosen at the top: the collection selected in Zotero, or a library.
 */
import { getToolSession, type ToolChatSession } from '../core/tools/session';
import type { ToolTarget } from '../core/tools/types';
import { readPrefs } from '../prefs';
import { logError } from '../util/log';
import { TurnListView } from './turn-view';
import { t } from '../i18n';
import { getPrefsPaneID } from './library-window';
import { choiceAvailable, effectiveOption, isToolEnabled, setToolEnabled, setToolOption, storedOption } from '../core/tools/settings';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const WINDOW_URL = 'chrome://seekchat/content/toolsChat.xhtml';
const WINDOW_NAME = 'seekchat-tools';

let chatWindow: any = null;
let view: ToolsChatView | null = null;

/**
 * Targets offered: the collection selected in the main window, then every library the user may edit; the
 * target in use stays in the list. Keys: "c<id>" for collections, "l<id>" for libraries.
 */
export function targetChoices(current: ToolTarget | null, win: any = Zotero.getMainWindow()): ToolTarget[] {
  const list: ToolTarget[] = [];
  const add = (target: ToolTarget) => {
    if (!list.some((x) => targetKey(x) === targetKey(target))) list.push(target);
  };
  const collection = win?.ZoteroPane?.getSelectedCollection?.();
  if (collection && Zotero.Libraries.get(collection.libraryID)?.editable) {
    add({ libraryID: collection.libraryID, collectionID: collection.id, label: t('tools.targetCollection', { name: collection.name }) });
  }
  const selectedLib = win?.ZoteroPane?.getSelectedLibraryID?.();
  const libs = Zotero.Libraries.getAll().filter((l: any) => (l.libraryType === 'user' || l.libraryType === 'group') && l.editable);
  libs.sort((a: any, b: any) => Number(b.libraryID === selectedLib) - Number(a.libraryID === selectedLib));
  for (const lib of libs) add({ libraryID: lib.libraryID, label: lib.name });
  if (current && !list.some((x) => targetKey(x) === targetKey(current))) list.unshift(current);
  return list;
}

export function targetKey(target: ToolTarget): string {
  return target.collectionID ? `c${target.collectionID}` : `l${target.libraryID}`;
}

export function openToolsChat(): void {
  try {
    if (chatWindow && !chatWindow.closed) {
      view?.refreshTargets();
      chatWindow.focus();
      return;
    }
    chatWindow = Zotero.getMainWindow().openDialog(WINDOW_URL, WINDOW_NAME, 'chrome,centerscreen,resizable,dialog=no');
  } catch (e) {
    logError(e);
  }
}

export function getToolsChatWindow(): any {
  return chatWindow && !chatWindow.closed ? chatWindow : null;
}

export function getToolsChatView(): ToolsChatView | null {
  return view;
}

export function onToolsWindowLoad(win: any): void {
  try {
    view = new ToolsChatView(win, win.document.getElementById('seekchat-tools-root'), getToolSession());
  } catch (e) {
    logError(e);
  }
}

export function onToolsWindowUnload(win: any): void {
  if (win === chatWindow) chatWindow = null;
  view?.dispose();
  view = null;
}

export function closeToolsChat(): void {
  getToolsChatWindow()?.close();
}

export class ToolsChatView {
  private doc: Document;
  private targetEl: HTMLSelectElement;
  private targets: ToolTarget[] = [];
  target: ToolTarget | null = null;
  private modelEl: HTMLElement;
  /** Collapsible list of all tools with on/off switch and settings. */
  private toolsBox: HTMLDetailsElement;
  private onFocus = () => this.renderTools();
  private messages: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private unsubscribe: () => void;
  private renderTimer: any = null;
  private turnList = new TurnListView();

  constructor(private win: any, root: HTMLElement, readonly session: ToolChatSession) {
    this.doc = win.document;
    const row = (label: string, ...content: HTMLElement[]) => {
      const r = this.el('div', 'seekchat-library-row');
      r.append(this.el('span', 'seekchat-library-label', label), ...content);
      return r;
    };
    this.targetEl = this.el('select', 'seekchat-library-scope seekchat-tools-target') as HTMLSelectElement;
    this.targetEl.addEventListener('change', () => {
      this.target = this.targets[this.targetEl.selectedIndex] || this.target;
    });
    this.targetEl.addEventListener('focus', () => this.refreshTargets());
    this.modelEl = this.el('span', 'seekchat-library-status');
    this.toolsBox = this.el('details', 'seekchat-tools-list') as HTMLDetailsElement;
    // Plugins (zotero-reference) may be switched on or off while the window is open.
    this.win.addEventListener('focus', this.onFocus, false, true);
    this.messages = this.el('div', 'seekchat-messages');
    this.input = this.el('textarea', 'seekchat-input') as HTMLTextAreaElement;
    this.input.placeholder = t('tools.placeholder');
    this.input.style.flex = '1';
    this.sendBtn = this.button(t('common.send'), () => (this.session.busy ? this.session.stop() : this.send()));
    this.clearBtn = this.button(t('common.newChat'), () => this.session.clear());
    const settings = this.button(t('common.settings'), () => {
      Zotero.Utilities.Internal.openPreferences(getPrefsPaneID() || undefined);
    });
    const close = this.button(t('common.close'), () => this.win.close());
    const inputRow = this.el('div', 'seekchat-library-row');
    inputRow.append(this.input, this.sendBtn);
    const footer = this.el('div', 'seekchat-library-footer');
    footer.append(settings, this.el('span', 'spacer'), this.clearBtn, close);
    root.replaceChildren(
      row(t('tools.target'), this.targetEl),
      row(t('lib.model'), this.modelEl),
      this.toolsBox,
      this.messages,
      inputRow,
      footer,
    );
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.win.document.title = t('tools.windowTitle');
    this.unsubscribe = this.session.subscribe(() => this.scheduleRender());
    this.refreshTargets();
    this.renderTools();
    this.render();
  }

  /** The tool list: a checkbox per tool, its description and settings (unavailable choices disabled). */
  renderTools(): void {
    const tools = this.session.registry.all();
    const on = tools.filter((x) => isToolEnabled(x.spec.name)).length;
    const summary = this.el('summary', '', t('tools.available', { on, n: tools.length }));
    const list = this.el('div', 'seekchat-tools-items');
    for (const tool of tools) {
      const name = tool.spec.name;
      const item = this.el('div', 'seekchat-tools-item');
      item.dataset.tool = name;
      const label = this.el('label', 'seekchat-library-source');
      const box = this.el('input') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = isToolEnabled(name);
      box.addEventListener('change', () => {
        setToolEnabled(name, box.checked);
        this.renderTools();
        this.render();
      });
      label.append(box, this.doc.createTextNode(` ${tool.label()}`));
      item.append(label, this.el('div', 'seekchat-library-note', tool.description()));
      for (const option of tool.options || []) {
        const select = this.el('select', 'seekchat-tools-option') as HTMLSelectElement;
        select.dataset.option = option.key;
        select.disabled = !box.checked;
        const stored = storedOption(tool, option);
        for (const choice of option.choices) {
          const usable = choiceAvailable(option, choice.value);
          const o = this.el('option', '', usable ? choice.label : `${choice.label} – ${choice.unavailableHint || t('tools.optionUnavailable')}`) as HTMLOptionElement;
          o.value = choice.value;
          o.disabled = !usable;
          select.append(o);
        }
        select.value = stored;
        select.addEventListener('change', () => {
          setToolOption(tool, option.key, select.value);
          this.renderTools();
        });
        const optRow = this.el('div', 'seekchat-library-row seekchat-tools-option-row');
        optRow.append(this.el('span', 'seekchat-library-label', option.label), select);
        // A stored choice that is not available (plugin missing): another one applies meanwhile.
        if (!choiceAvailable(option, stored)) {
          const used = effectiveOption(tool, option);
          optRow.append(this.el('span', 'seekchat-library-note seekchat-library-coverage', t('tools.optionFallback', {
            choice: option.choices.find((c) => c.value === used)?.label || used,
          })));
        }
        item.append(optRow);
      }
      list.append(item);
    }
    this.toolsBox.replaceChildren(summary, list);
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

  /** Re-reads the Zotero selection; the first choice (selected collection or library) is taken if none was picked. */
  refreshTargets(): void {
    this.targets = targetChoices(this.target);
    this.target ??= this.targets[0] || null;
    this.targetEl.replaceChildren(...this.targets.map((x) => {
      const o = this.el('option', '', x.label) as HTMLOptionElement;
      o.value = targetKey(x);
      return o;
    }));
    this.targetEl.selectedIndex = Math.max(0, this.targets.findIndex((x) => this.target && targetKey(x) === targetKey(this.target)));
  }

  /** Picks a target by key (tests, later: from the context). */
  setTarget(key: string): void {
    this.refreshTargets();
    const found = this.targets.find((x) => targetKey(x) === key);
    if (found) this.target = found;
    this.refreshTargets();
  }

  async send(): Promise<void> {
    const q = this.input.value.trim();
    if (!q || this.session.busy || !this.target) return;
    this.input.value = '';
    await this.session.ask(q, this.target);
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
    this.modelEl.textContent = readPrefs().model || t('common.noModel');
    this.sendBtn.textContent = s.busy ? t('common.stop') : t('common.send');
    this.sendBtn.disabled = !s.busy && !this.target;
    this.clearBtn.disabled = s.turns.length === 0;
    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 40;
    if (!s.turns.length) {
      this.turnList.reset();
      const none = !s.registry.all().some((x) => isToolEnabled(x.spec.name));
      this.messages.replaceChildren(this.el('div', 'seekchat-library-empty', t(none ? 'tools.introNone' : 'tools.intro')));
      return;
    }
    this.turnList.update(this.messages, s.turns, {
      onToolConfirm: (run, ok) => s.confirm(run, ok),
      onToolToggle: (run, i, checked) => s.toggleItem(run, i, checked),
      onShowItem: (id) => {
        const main = Zotero.getMainWindow();
        main?.ZoteroPane?.selectItem(id);
        main?.focus();
      },
    }, s, t('tools.thinking'));
    // Follow a running answer to the end – but not while a tool waits for the user: ticking an item in its preview
    // would otherwise jump to the end of the chat each time.
    const waiting = s.turns.some((turn) => turn.toolRuns?.some((run) => run.state === 'confirm'));
    if (atBottom || (s.busy && !waiting)) this.messages.scrollTop = this.messages.scrollHeight;
  }

  dispose(): void {
    this.win.removeEventListener('focus', this.onFocus);
    this.unsubscribe();
    if (this.renderTimer) this.win.clearTimeout(this.renderTimer);
  }
}
