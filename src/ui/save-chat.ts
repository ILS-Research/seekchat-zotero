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
