/* SeekChat bootstrap: registers chrome, loads the bundle, delegates to Zotero.SeekChat. */
var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;

  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "seekchat", rootURI + "content/"],
    ["locale", "seekchat", "en-US", rootURI + "locale/en-US/"],
    ["locale", "seekchat", "de", rootURI + "locale/de/"],
  ]);

  const ctx = { rootURI, Zotero };
  ctx._globalThis = ctx;
  try {
    Services.scriptloader.loadSubScript(rootURI + "content/scripts/seekchat.js", ctx);
    await Zotero.SeekChat.startup({ id, version, rootURI });
  } catch (e) {
    Zotero.debug("[SeekChat] startup failed: " + e);
    Zotero.logError(e);
  }
}

function onMainWindowLoad({ window }) {
  Zotero.SeekChat?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  Zotero.SeekChat?.onMainWindowUnload(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.SeekChat?.shutdown();
  delete Zotero.SeekChat;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
