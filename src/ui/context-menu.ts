/**
 * Item context menu entries:
 *   "Mit dieser Datei chatten"   – one item with a PDF (or the PDF itself): opens it in the reader
 *                                  with the "Chat mit PDF" section in view.
 *   "Mit dieser Auswahl chatten" – several items: library chat window with them as scope;
 *                                  only while ZotSeek is installed (no library chat without it).
 *
 * Zotero 8+ has Zotero.MenuManager (target "main/library/item"); Zotero 7 gets
 * the same entries added to #zotero-itemmenu directly.
 */
import { itemsScope } from '../core/library/library-context';
import { logError } from '../util/log';
import { getRegisteredPaneID, resolveAttachment } from './chat-section';
import { openLibraryChat } from './library-window';

const MENU_ID = 'seekchat-item-menu';
const FILE_ID = 'seekchat-menu-chat-file';
const SELECTION_ID = 'seekchat-menu-chat-selection';

let menuRegistration: string | false = false;

function selectedItems(): any[] {
  return Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() || [];
}

/** Synchronous check for the menu: the item is a PDF or has a PDF attachment. */
function hasPdf(item: any): boolean {
  if (item?.isPDFAttachment?.()) return true;
  if (!item?.isRegularItem?.()) return false;
  return Zotero.Items.get(item.getAttachments()).some((a: any) => a?.isPDFAttachment?.());
}

export function menuState(items = selectedItems()): { file: boolean; selection: boolean; selectionEnabled: boolean } {
  return {
    file: items.length === 1 && hasPdf(items[0]),
    selection: items.length > 1,
    selectionEnabled: !!(Zotero as any).ZotSeek,
  };
}

/** Opens the item's PDF in the reader and brings the chat section into view. */
export async function chatWithFile(item: any): Promise<void> {
  const win = Zotero.getMainWindow();
  const att = await resolveAttachment(item, 'library', win.document);
  if (!att) return;
  const reader = await Zotero.Reader.open(att.id);
  if (!reader) return;
  win.ZoteroContextPane.collapsed = false;
  const pane = win.document.getElementById('zotero-context-pane');
  const id = getRegisteredPaneID();
  for (let i = 0; i < 50; i++) {
    const section = id && pane?.querySelector(`[data-pane="${id}"]`);
    const host = section && ((section as Element).closest('item-pane-custom-section') || section);
    if (host && !(host as Element).hasAttribute('hidden')) {
      await ((host as Element).closest('item-details') as any)?.scrollToPane(id, 'smooth');
      (host as Element).querySelector('textarea')?.focus();
      return;
    }
    await Zotero.Promise.delay(100);
  }
}

export function chatWithSelection(items = selectedItems()): void {
  try {
    openLibraryChat(itemsScope(items));
  } catch (e) {
    logError(e);
  }
}

function onFile(): void {
  const [item] = selectedItems();
  if (item) chatWithFile(item).catch(logError);
}

function onSelection(): void {
  chatWithSelection();
}

/** Zotero 8+: MenuManager. Returns false if the API is missing (Zotero 7). */
export function registerMenus(pluginID: string, icon: string): boolean {
  const mm = (Zotero as any).MenuManager;
  if (!mm) return false;
  try {
    menuRegistration = mm.registerMenu({
      menuID: MENU_ID,
      pluginID,
      target: 'main/library/item',
      menus: [
        { menuType: 'separator', onShowing: (_e: any, ctx: any) => ctx.setVisible(menuState().file || menuState().selection) },
        {
          menuType: 'menuitem',
          l10nID: FILE_ID,
          icon,
          onShowing: (_e: any, ctx: any) => ctx.setVisible(menuState().file),
          onCommand: onFile,
        },
        {
          menuType: 'menuitem',
          l10nID: SELECTION_ID,
          icon,
          onShowing: (_e: any, ctx: any) => {
            const s = menuState();
            ctx.setVisible(s.selection);
            ctx.setEnabled(s.selectionEnabled);
          },
          onCommand: onSelection,
        },
      ],
    }) || false;
  } catch (e) {
    logError(e);
    menuRegistration = false;
  }
  return menuRegistration !== false;
}

export function unregisterMenus(): void {
  if (menuRegistration) (Zotero as any).MenuManager?.unregisterMenu(menuRegistration);
  menuRegistration = false;
}

/** Zotero 7: the same entries, added to the item context menu of a main window. */
export function addLegacyMenu(win: any): void {
  if (menuRegistration) return;
  const doc = win.document;
  const popup = doc.getElementById('zotero-itemmenu');
  if (!popup || doc.getElementById(FILE_ID)) return;
  const sep = doc.createXULElement('menuseparator');
  sep.id = `${MENU_ID}-separator`;
  const make = (id: string, onCommand: () => void) => {
    const m = doc.createXULElement('menuitem');
    m.id = id;
    m.setAttribute('data-l10n-id', id);
    m.addEventListener('command', onCommand);
    return m;
  };
  const file = make(FILE_ID, onFile);
  const selection = make(SELECTION_ID, onSelection);
  popup.append(sep, file, selection);
  popup.addEventListener('popupshowing', (e: any) => {
    if (e.target !== popup) return;
    const s = menuState();
    file.hidden = !s.file;
    selection.hidden = !s.selection;
    selection.disabled = !s.selectionEnabled;
    sep.hidden = !s.file && !s.selection;
  });
}

export function removeLegacyMenu(win: any): void {
  for (const id of [`${MENU_ID}-separator`, FILE_ID, SELECTION_ID]) win.document.getElementById(id)?.remove();
}
