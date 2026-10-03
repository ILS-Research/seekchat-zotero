/**
 * Toolbar buttons in the items toolbar. The library chat's sits right after ZotSeek's button and exists only
 * while ZotSeek's does: plugins start in no fixed order, so a MutationObserver adds ours when ZotSeek's
 * appears and removes it when ZotSeek goes away. The tool chat's needs no ZotSeek: it follows the library
 * chat's button, else ZotSeek's, else Zotero's lookup button. Both are built like ZotSeek's (a clone of
 * Zotero's lookup button), so all look the same.
 */
import { logError } from '../util/log';
import { openLibraryChat } from './library-window';
import { openToolsChat } from './tools-window';
import { t } from '../i18n';

const BUTTON_ID = 'seekchat-toolbar-button';
const TOOLS_BUTTON_ID = 'seekchat-tools-toolbar-button';
const TOOLS_ICON = 'chrome://seekchat/content/icons/seekchat-tools.svg';
const ZOTSEEK_BUTTON_ID = 'zotseek-toolbar-button';
const ICON = 'chrome://seekchat/content/icons/seekchat.svg';

const observers = new WeakMap<any, MutationObserver>();

function createButton(doc: any, id: string, label: string, tooltip: string, icon: string, onCommand: () => void): any {
  const lookup = doc.getElementById('zotero-tb-lookup');
  let button: any;
  if (lookup) {
    button = lookup.cloneNode(true);
    for (const attr of ['command', 'oncommand', 'onmousedown', 'type']) button.removeAttribute(attr);
  } else {
    button = doc.createXULElement('toolbarbutton');
    button.setAttribute('class', 'zotero-tb-button');
  }
  button.id = id;
  button.setAttribute('label', label);
  button.setAttribute('tooltiptext', tooltip);
  button.style.listStyleImage = `url("${icon}")`;
  button.addEventListener('command', onCommand);
  return button;
}

/** Library chat button right after ZotSeek's (or gone with it), tool chat button after that. */
function sync(win: any): void {
  const doc = win.document;
  const zotseek = doc.getElementById(ZOTSEEK_BUTTON_ID);
  const ours = doc.getElementById(BUTTON_ID);
  if (!zotseek) {
    ours?.remove();
  } else if (!ours || ours.previousElementSibling !== zotseek) {
    zotseek.after(ours || createButton(doc, BUTTON_ID, 'SeekChat', t('lib.tooltip'), ICON, () => openLibraryChat()));
  }
  const tools = doc.getElementById(TOOLS_BUTTON_ID);
  const anchor = doc.getElementById(BUTTON_ID) || zotseek || doc.getElementById('zotero-tb-lookup');
  if (tools && (anchor ? tools.previousElementSibling === anchor : tools.parentElement)) return;
  const button = tools || createButton(doc, TOOLS_BUTTON_ID, t('tools.buttonLabel'), t('tools.tooltip'), TOOLS_ICON, () => openToolsChat());
  if (anchor) anchor.after(button);
  else doc.getElementById('zotero-items-toolbar')?.append(button);
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
  win.document.getElementById(TOOLS_BUTTON_ID)?.remove();
}

export function getToolbarButton(win: any = Zotero.getMainWindow()): any {
  return win.document.getElementById(BUTTON_ID);
}

export function getToolsToolbarButton(win: any = Zotero.getMainWindow()): any {
  return win.document.getElementById(TOOLS_BUTTON_ID);
}
