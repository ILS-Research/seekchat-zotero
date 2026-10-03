/**
 * SeekChat: chat with a PDF in Zotero using a self-hosted model.
 * Entry point; bootstrap.js calls startup()/shutdown() and the window hooks.
 */
import { clearPageCache } from './core/context/pdf-context';
import { stopAllSessions } from './core/session';
import { registerChatSection, unregisterChatSection } from './ui/chat-section';
import { onPrefsLoad } from './ui/preferences';
import {
  closeLibraryChat, onLibraryWindowLoad, onLibraryWindowUnload, openLibraryChat, setPrefsPaneID,
} from './ui/library-window';
import { addToolbarButton, removeToolbarButton } from './ui/toolbar-button';
import { closeToolsChat, onToolsWindowLoad, onToolsWindowUnload, openToolsChat } from './ui/tools-window';
import { stopToolSession } from './core/tools/session';
import { addLegacyMenu, registerMenus, removeLegacyMenu, unregisterMenus } from './ui/context-menu';
import { log, logError } from './util/log';

const FTL = 'seekchat-main.ftl';
const CSS_ID = 'seekchat-stylesheet';

class SeekChatPlugin {
  info = { id: '', version: '', rootURI: '' };
  onPrefsLoad = onPrefsLoad;
  onLibraryWindowLoad = onLibraryWindowLoad;
  onLibraryWindowUnload = onLibraryWindowUnload;
  openLibraryChat = openLibraryChat;
  onToolsWindowLoad = onToolsWindowLoad;
  onToolsWindowUnload = onToolsWindowUnload;
  openToolsChat = openToolsChat;

  async startup(info: { id: string; version: string; rootURI: string }): Promise<void> {
    this.info = info;
    // Zotero 8+: MenuManager; Zotero 7: menu items added per window in onMainWindowLoad.
    registerMenus(info.id, `${info.rootURI}content/icons/seekchat.svg`);
    for (const win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
    registerChatSection(info);
    const paneID = Zotero.PreferencePanes.register({
      pluginID: info.id,
      src: `${info.rootURI}content/preferences.xhtml`,
      label: 'SeekChat',
      image: `${info.rootURI}content/icons/seekchat.svg`,
    });
    Promise.resolve(paneID).then((id: any) => setPrefsPaneID(typeof id === 'string' ? id : null)).catch(logError);
    log(`started ${info.version}`);
  }

  onMainWindowLoad(win: any): void {
    try {
      win.MozXULElement?.insertFTLIfNeeded(FTL);
      if (!win.document.getElementById(CSS_ID)) {
        const link = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'link');
        link.id = CSS_ID;
        link.rel = 'stylesheet';
        link.href = 'chrome://seekchat/content/chat.css';
        win.document.documentElement.appendChild(link);
      }
      addToolbarButton(win);
      addLegacyMenu(win);
    } catch (e) {
      logError(e);
    }
  }

  onMainWindowUnload(win: any): void {
    removeToolbarButton(win);
    removeLegacyMenu(win);
    win.document.getElementById(CSS_ID)?.remove();
    win.document.querySelector(`link[href="${FTL}"]`)?.remove();
  }

  shutdown(): void {
    unregisterMenus();
    closeLibraryChat();
    closeToolsChat();
    stopAllSessions();
    stopToolSession();
    unregisterChatSection();
    clearPageCache();
    for (const win of Zotero.getMainWindows()) this.onMainWindowUnload(win);
  }
}

Zotero.SeekChat = new SeekChatPlugin();
