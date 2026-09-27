/**
 * SeekChat: chat with a PDF in Zotero using a self-hosted model.
 * Entry point; bootstrap.js calls startup()/shutdown() and the window hooks.
 */
import { clearPageCache } from './core/context/pdf-context';
import { stopAllSessions } from './core/session';
import { registerChatSection, unregisterChatSection } from './ui/chat-section';
import { onPrefsLoad } from './ui/preferences';
import { log, logError } from './util/log';

const FTL = 'seekchat-main.ftl';
const CSS_ID = 'seekchat-stylesheet';

class SeekChatPlugin {
  info = { id: '', version: '', rootURI: '' };
  onPrefsLoad = onPrefsLoad;

  async startup(info: { id: string; version: string; rootURI: string }): Promise<void> {
    this.info = info;
    for (const win of Zotero.getMainWindows()) this.onMainWindowLoad(win);
    registerChatSection(info);
    Zotero.PreferencePanes.register({
      pluginID: info.id,
      src: `${info.rootURI}content/preferences.xhtml`,
      label: 'SeekChat',
      image: `${info.rootURI}content/icons/seekchat.svg`,
    });
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
    } catch (e) {
      logError(e);
    }
  }

  onMainWindowUnload(win: any): void {
    win.document.getElementById(CSS_ID)?.remove();
    win.document.querySelector(`link[href="${FTL}"]`)?.remove();
  }

  shutdown(): void {
    stopAllSessions();
    unregisterChatSection();
    clearPageCache();
    for (const win of Zotero.getMainWindows()) this.onMainWindowUnload(win);
  }
}

Zotero.SeekChat = new SeekChatPlugin();
