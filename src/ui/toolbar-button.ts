/**
 * Toolbar button for the library chat, placed right after ZotSeek's button in
 * the items toolbar. It exists only while ZotSeek's button does: plugins start
 * in no fixed order, so a MutationObserver adds ours when ZotSeek's appears and
 * removes it when ZotSeek goes away. Built like ZotSeek's (a clone of Zotero's
 * lookup button), so both look the same.
 */
import { logError } from '../util/log';
import { openLibraryChat } from './library-window';
import { t } from '../i18n';

const BUTTON_ID = 'seekchat-toolbar-button';
const ZOTSEEK_BUTTON_ID = 'zotseek-toolbar-button';
const ICON = 'chrome://seekchat/content/icons/seekchat.svg';

const observers = new WeakMap<any, MutationObserver>();

function createButton(doc: any): any {
  const lookup = doc.getElementById('zotero-tb-lookup');
  let button: any;
  if (lookup) {
    button = lookup.cloneNode(true);
    for (const attr of ['command', 'oncommand', 'onmousedown', 'type']) button.removeAttribute(attr);
  } else {
    button = doc.createXULElement('toolbarbutton');
    button.setAttribute('class', 'zotero-tb-button');
  }
  button.id = BUTTON_ID;
  button.setAttribute('label', 'SeekChat');
  button.setAttribute('tooltiptext', t('lib.tooltip'));
  button.style.listStyleImage = `url("${ICON}")`;
  button.addEventListener('command', () => openLibraryChat());
  return button;
}

/** Puts our button right after ZotSeek's, or removes it if ZotSeek's is gone. */
function sync(win: any): void {
  const doc = win.document;
  const zotseek = doc.getElementById(ZOTSEEK_BUTTON_ID);
  const ours = doc.getElementById(BUTTON_ID);
  if (!zotseek) {
    ours?.remove();
    return;
  }
  if (ours && ours.previousElementSibling === zotseek) return;
  zotseek.after(ours || createButton(doc));
}

export function addToolbarButton(win: any): void {
  try {
    const toolbar = win.document.getElementById('zotero-items-toolbar');
    if (!toolbar || observers.has(win)) return;
    sync(win);
    const observer = new win.MutationObserver(() => sync(win));
    observer.observe(toolbar, { childList: true });
    observers.set(win, observer);
  } catch (e) {
    logError(e);
  }
}

export function removeToolbarButton(win: any): void {
  observers.get(win)?.disconnect();
  observers.delete(win);
  win.document.getElementById(BUTTON_ID)?.remove();
}

export function getToolbarButton(win: any = Zotero.getMainWindow()): any {
  return win.document.getElementById(BUTTON_ID);
}
