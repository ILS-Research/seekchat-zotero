/**
 * Entries in Zotero's Tools menu: the tool chat (always) and the library chat (only while ZotSeek is installed,
 * like its toolbar button; disabled since 1.0.0-rc.4, commented out below). Added per main window to #menu_ToolsPopup, in every Zotero version.
 */
import { t } from '../i18n';
import { logError } from '../util/log';
// import { openLibraryChat } from './library-window'; // library chat disabled (1.0.0-rc.4)
import { openToolsChat } from './tools-window';

const SEP_ID = 'seekchat-tools-menu-separator';
const TOOLS_ID = 'seekchat-tools-menu-tools-chat';
const LIBRARY_ID = 'seekchat-tools-menu-library-chat';
const listeners = new WeakMap<any, (e: any) => void>();

export function addToolsMenu(win: any): void {
  const doc = win.document;
  const popup = doc.getElementById('menu_ToolsPopup');
  if (!popup || doc.getElementById(TOOLS_ID)) return;
  const make = (id: string, label: string, icon: string, onCommand: () => void) => {
    const m = doc.createXULElement('menuitem');
    m.id = id;
    m.setAttribute('label', label);
    m.setAttribute('class', 'menuitem-iconic');
    m.setAttribute('image', icon);
    m.addEventListener('command', () => {
      try {
        onCommand();
      } catch (e) {
        logError(e);
      }
    });
    return m;
  };
  const sep = doc.createXULElement('menuseparator');
  sep.id = SEP_ID;
  const tools = make(TOOLS_ID, t('menu.toolsChat'), 'chrome://seekchat/content/icons/seekchat-tools.svg', () => openToolsChat());
  popup.append(sep, tools);
  // Library chat disabled (1.0.0-rc.4). To bring it back, restore these lines (and the import above):
  // const library = make(LIBRARY_ID, t('menu.libraryChat'), 'chrome://seekchat/content/icons/seekchat.svg', () => openLibraryChat());
  // popup.append(library);
  // const onShowing = (e: any) => {
  //   if (e.target === popup) library.hidden = !(Zotero as any).ZotSeek;
  // };
  // popup.addEventListener('popupshowing', onShowing);
  // listeners.set(win, onShowing);
}

export function removeToolsMenu(win: any): void {
  const doc = win.document;
  const onShowing = listeners.get(win);
  if (onShowing) doc.getElementById('menu_ToolsPopup')?.removeEventListener('popupshowing', onShowing);
  listeners.delete(win);
  for (const id of [SEP_ID, TOOLS_ID, LIBRARY_ID]) doc.getElementById(id)?.remove();
}
