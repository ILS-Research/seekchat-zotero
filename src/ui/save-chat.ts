/**
 * "Chat als .md speichern": asks for a file name with Zotero's file picker and
 * writes the chat history as Markdown.
 */
import { chatToMarkdown, exportFileName } from '../core/export';
import type { ChatSession } from '../core/session';
import { readPrefs } from '../prefs';
import { logError } from '../util/log';

/** Test hook: when set, the file picker is skipped and the file goes here. */
let testPath: string | null = null;

export function setSaveChatTestPath(path: string | null): void {
  testPath = path;
}

/** Runs a save action and shows the outcome on the button for a moment. */
export async function withFeedback(btn: HTMLButtonElement, action: () => Promise<unknown>, done: string): Promise<void> {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    await action();
    btn.textContent = done;
  } catch (e) {
    logError(e);
    btn.textContent = 'Fehler beim Speichern';
  }
  const win = btn.ownerDocument?.defaultView;
  win?.setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 2000);
}

export async function saveChat(session: ChatSession, subject: string, win: any): Promise<void> {
  try {
    const date = new Date();
    const text = chatToMarkdown(session.turns, { subject, model: readPrefs().model, date });
    let path = testPath;
    if (!path) {
      const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
      const fp = new FilePicker();
      fp.init(win, 'Chat als Markdown speichern', fp.modeSave);
      fp.appendFilter('Markdown', '*.md');
      fp.defaultString = exportFileName(subject, date);
      fp.defaultExtension = 'md';
      if ((await fp.show()) === fp.returnCancel) return;
      path = fp.file as string;
    }
    await Zotero.File.putContentsAsync(path, text);
  } catch (e) {
    logError(e);
  }
}
