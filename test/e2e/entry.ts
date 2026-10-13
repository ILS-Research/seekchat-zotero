/**
 * Entry point of the E2E build: the normal plugin plus the harness. When the
 * pref seekchat.e2e.resultsPath is set (only in the E2E profile), the harness
 * runs all scenarios after startup, writes the results and quits Zotero.
 */
import '../../src/index';
import { setUserAgent } from '../../src/core/llm/http';
import { runAll } from './harness';

const plugin = Zotero.SeekChat;
const startup = plugin.startup.bind(plugin);
plugin.startup = async (info: any) => {
  await startup(info);
  // Test traffic is recognizable in the server log: "SeekChatZot/<v> (e2e)" or the tag of E2E_USER_AGENT_TAG.
  setUserAgent(info.version, Zotero.Prefs.get('seekchat.e2e.userAgentTag') || 'e2e');
  const results = Zotero.Prefs.get('seekchat.e2e.resultsPath');
  Zotero.debug(`[SeekChat E2E] harness installed, resultsPath=${results}`);
  if (results) void runAll();
};
