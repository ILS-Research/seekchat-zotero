/**
 * The "Chat mit PDF" section in Zotero's item pane. It shows up in the library
 * (for a selected item with a PDF, or the PDF itself) and in the reader's
 * context pane (for the open PDF).
 */
import { t } from '../i18n';
import { describeItem, PdfContextProvider } from '../core/context/pdf-context';
import { getSession, type ChatSession } from '../core/session';
import { LongDocPanel } from './long-doc-panel';
import { TurnListView } from './turn-view';
import { saveChat, withFeedback } from './save-chat';
import { saveAnswerAsNote, savePdfChatAsNote } from './save-note';
import { readPrefs } from '../prefs';
import { logError } from '../util/log';

const PANE_ID = 'seekchat-pdf-chat';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
let registeredPaneID: string | false = false;

/** The PDF the chat is about: the one open in the reader, the selected PDF, or the item's best PDF. */
export async function resolveAttachment(item: any, tabType: string, doc: Document): Promise<any | null> {
  if (tabType === 'reader') {
    const win: any = doc.defaultView;
    const reader = Zotero.Reader.getByTabID(win?.Zotero_Tabs?.selectedID);
    const att = reader && Zotero.Items.get(reader.itemID);
    if (att?.isPDFAttachment?.()) return att;
  }
  if (!item) return null;
  if (item.isPDFAttachment?.()) return item;
  if (item.isRegularItem?.()) {
    const best = await item.getBestAttachment();
    if (best?.isPDFAttachment?.()) return best;
    for (const id of item.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att?.isPDFAttachment?.()) return att;
    }
  }
  return null;
}

class ChatView {
  private root: HTMLElement;
  private target: HTMLElement;
  private longDoc: LongDocPanel;
  private messages: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;
  private noteBtn: HTMLButtonElement;
  private session: ChatSession | null = null;
  private attachment: any = null;
  private unsubscribe: (() => void) | null = null;
  private renderTimer: any = null;
  private turnList = new TurnListView();

  constructor(private doc: Document, body: HTMLElement) {
    this.root = this.el('div', 'seekchat');
    this.target = this.el('div', 'seekchat-target');
    this.longDoc = new LongDocPanel(doc);
    this.notesBox = this.el('details', 'seekchat-notes');
    this.messages = this.el('div', 'seekchat-messages');
    this.input = this.el('textarea', 'seekchat-input') as HTMLTextAreaElement;
    this.input.placeholder = t('pdf.placeholder');
    this.sendBtn = this.el('button') as HTMLButtonElement;
    this.clearBtn = this.el('button') as HTMLButtonElement;
    this.clearBtn.textContent = t('common.newChat');
    const actions = this.el('div', 'seekchat-actions');
    const hint = this.el('span', 'seekchat-hint');
    const spacer = this.el('span', 'spacer');
    actions.append(hint, spacer, this.clearBtn, this.sendBtn);
    // Small, at the very bottom: download the whole chat as Markdown.
    this.saveBtn = this.el('button', 'seekchat-save') as HTMLButtonElement;
    this.saveBtn.textContent = t('common.saveMd');
    this.saveBtn.addEventListener('click', () => {
      if (this.session && this.attachment) void saveChat(this.session, `PDF ${describeItem(this.attachment)}`, this.doc.defaultView);
    });
    this.noteBtn = this.el('button', 'seekchat-save seekchat-save-note') as HTMLButtonElement;
    this.noteBtn.textContent = t('common.saveNote');
    this.noteBtn.addEventListener('click', () => {
      const s = this.session;
      const att = this.attachment;
      if (s && att) void withFeedback(this.noteBtn, () => savePdfChatAsNote(s, `PDF ${describeItem(att)}`, att), t('common.noteSaved'));
    });
    const saveRow = this.el('div', 'seekchat-save-row');
    saveRow.append(this.noteBtn, this.saveBtn);
    this.root.append(this.target, this.longDoc.root, this.notesBox, this.messages, this.input, actions, saveRow);
    body.replaceChildren(this.root);

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.sendBtn.addEventListener('click', () => (this.session?.busy ? this.session.stop() : this.send()));
    this.clearBtn.addEventListener('click', () => this.session?.clear());
    this.hintEl = hint;
  }

  private hintEl: HTMLElement;
  private notesBox: HTMLElement;
  private notesKey = '';

  /** Child notes of the PDF's item, with a checkbox each: ticked ones go along as context. */
  private renderNotes(): void {
    const s = this.session;
    const parent = this.attachment?.parentItem;
    const notes: any[] = parent ? Zotero.Items.get(parent.getNotes()).filter((n: any) => n && !n.deleted) : [];
    const key = `${this.attachment?.id}:${notes.map((n) => `${n.id}/${n.version}`).join(',')}:${s ? Array.from(s.contextNotes).join(',') : ''}`;
    if (key === this.notesKey) return;
    this.notesKey = key;
    const open = (this.notesBox as any).open;
    const summary = this.el('summary');
    const n = s ? notes.filter((x) => s.contextNotes.has(x.id)).length : 0;
    summary.textContent = `${t('pdf.notesTitle')}${n ? ` (${n})` : ''}`;
    const children: HTMLElement[] = [summary];
    if (!notes.length) {
      children.push(Object.assign(this.el('div', 'seekchat-hint'), { textContent: t('pdf.notesNone') }));
    } else {
      for (const note of notes) {
        const label = this.el('label', 'seekchat-note-choice');
        const box = this.el('input') as HTMLInputElement;
        box.type = 'checkbox';
        box.checked = !!s?.contextNotes.has(note.id);
        box.dataset.noteId = String(note.id);
        box.addEventListener('change', () => {
          if (!s) return;
          if (box.checked) s.contextNotes.add(note.id);
          else s.contextNotes.delete(note.id);
          this.render();
        });
        label.append(box, this.doc.createTextNode(` ${note.getNoteTitle() || t('pdf.untitledNote')}`));
        children.push(label);
      }
      children.push(Object.assign(this.el('div', 'seekchat-hint'), { textContent: t('pdf.notesHint') }));
    }
    this.notesBox.replaceChildren(...children);
    (this.notesBox as any).open = open;
    this.notesBox.hidden = !this.attachment;
  }

  private el(tag: string, cls?: string): HTMLElement {
    const e = this.doc.createElementNS(HTML_NS, tag) as HTMLElement;
    if (cls) e.className = cls;
    return e;
  }

  setAttachment(att: any | null): void {
    if (att && this.attachment?.id === att.id) {
      void this.session?.analyze();
      return this.render();
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.attachment = att;
    this.session = att ? getSession(new PdfContextProvider(att)) : null;
    if (this.session) this.unsubscribe = this.session.subscribe(() => this.scheduleRender());
    this.longDoc.setSession(this.session);
    this.render();
    // Size check on opening: does the whole document fit into the context?
    void this.session?.analyze();
  }

  private send(): void {
    const q = this.input.value.trim();
    if (!q || !this.session || this.session.busy) return;
    this.input.value = '';
    void this.session.ask(q);
  }

  /** Streaming updates arrive per token; repaint at most every 60 ms. */
  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 60);
  }

  private render(): void {
    const s = this.session;
    const prefs = readPrefs();
    this.target.textContent = this.attachment
      ? t('pdf.target', { label: describeItem(this.attachment) })
      : t('pdf.none');
    this.input.disabled = !s;
    this.sendBtn.disabled = !s;
    this.sendBtn.textContent = s?.busy ? t('common.stop') : t('common.send');
    this.clearBtn.disabled = !s || s.turns.length === 0;
    this.saveBtn.disabled = !s || s.busy || s.turns.length === 0;
    if (!this.noteBtn.textContent?.includes('✓')) this.noteBtn.disabled = this.saveBtn.disabled;
    this.longDoc.render();
    this.renderNotes();
    this.hintEl.textContent = prefs.model ? t('common.model', { model: prefs.model }) : t('common.noModel');

    const atBottom = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight < 40;
    const attachmentID = this.attachment?.id;
    const onPage = (page: number) => Zotero.Reader.open(attachmentID, { pageIndex: page - 1 }).catch(logError);
    const att = this.attachment;
    const onSaveAnswer = (turn: any, btn: HTMLButtonElement) => {
      if (!s || !att) return;
      btn.disabled = true;
      saveAnswerAsNote(s, turn, { attachment: att, subject: `PDF ${describeItem(att)}` })
        .then(() => { turn.noteSaved = true; this.notesKey = ''; this.render(); })
        .catch((e) => { btn.disabled = false; logError(e); });
    };
    this.turnList.update(this.messages, s?.turns || [], { onPage, onSaveAnswer }, s);
    if (atBottom || s?.busy) this.messages.scrollTop = this.messages.scrollHeight;
  }

  dispose(): void {
    this.unsubscribe?.();
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }
}

const views = new WeakMap<HTMLElement, ChatView>();

export function registerChatSection(info: { id: string; rootURI: string }): void {
  const icon = `${info.rootURI}content/icons/seekchat.svg`;
  registeredPaneID = Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: info.id,
    header: { l10nID: 'seekchat-section-header', icon },
    sidenav: { l10nID: 'seekchat-section-sidenav', icon },
    onInit: ({ body, doc }: any) => {
      views.set(body, new ChatView(doc, body));
    },
    onDestroy: ({ body }: any) => {
      views.get(body)?.dispose();
      views.delete(body);
    },
    onItemChange: ({ item, tabType, setEnabled }: any) => {
      setEnabled(tabType === 'reader' || !!item?.isRegularItem?.() || !!item?.isPDFAttachment?.());
      return true;
    },
    onRender: () => {},
    onAsyncRender: async ({ body, item, tabType, doc }: any) => {
      try {
        views.get(body)?.setAttachment(await resolveAttachment(item, tabType, doc));
      } catch (e) {
        logError(e);
      }
    },
  });
}

/** The namespaced pane ID Zotero assigned (used by the E2E tests to find the section). */
export function getRegisteredPaneID(): string | false {
  return registeredPaneID;
}

export function unregisterChatSection(): void {
  if (registeredPaneID) Zotero.ItemPaneManager.unregisterSection(registeredPaneID);
  registeredPaneID = false;
}
