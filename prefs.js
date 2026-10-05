// SeekChat default preferences (extensions.zotero.seekchat.*).
// Zotero prefs only support string, int and bool: temperature is an integer percent.

// "ollama" (native /api/chat, lets us set the context window) or
// "openai" (any OpenAI-compatible /v1/chat/completions server).
pref("extensions.zotero.seekchat.provider", "ollama");
// Ollama: server root, e.g. https://ollama.example.local
// OpenAI-compatible: base including /v1, e.g. https://llm.example.local/v1
pref("extensions.zotero.seekchat.baseUrl", "http://127.0.0.1:11434");
pref("extensions.zotero.seekchat.apiKey", "");
pref("extensions.zotero.seekchat.model", "");
pref("extensions.zotero.seekchat.temperaturePercent", 20);
// Manual limits: context window the server uses, in tokens. Never sent (Ollama would reload the model);
// only the text budget is based on it.
pref("extensions.zotero.seekchat.numCtx", 16384);
// Maximum answer length in tokens.
pref("extensions.zotero.seekchat.maxTokens", 2048);
// Budget of document text sent per question, in characters (~3.5 chars per token).
// Must fit into numCtx together with the answer.
pref("extensions.zotero.seekchat.contextChars", 40000);
// Previous question/answer pairs sent along for follow-up questions.
pref("extensions.zotero.seekchat.historyTurns", 4);
// Reasoning phase of thinking models (Qwen 3 …) for answers: better on hard questions, much slower. Helper calls never think.
pref("extensions.zotero.seekchat.thinking", false);
// Empty = built-in default prompt.
pref("extensions.zotero.seekchat.systemPrompt", "");
// Comma-separated host names that may serve the chat model in addition to
// this computer. Empty = loopback only. Hosts listed here receive the PDF text
// and all questions.
pref("extensions.zotero.seekchat.allowedRemoteHosts", "");
// With an API key, remote servers must use https. For a self-signed or otherwise invalid certificate of such a
// server, a certificate exception can be added for the session.
pref("extensions.zotero.seekchat.allowInvalidCerts", false);
pref("extensions.zotero.seekchat.certificates", "");
// Library chat (needs ZotSeek): passages requested per question (1-100).
pref("extensions.zotero.seekchat.libraryTopK", 30);
// "auto": context window, answer length and text budget from the model (server info minus 20 %),
// "manual": the three values above.
pref("extensions.zotero.seekchat.limitsMode", "auto");
// UI language: "" = follow Zotero, or "en" / "de".
pref("extensions.zotero.seekchat.locale", "");
// Log questions, search terms and removed page lines as text (debugging). Off: only their length is logged,
// since debug output is often attached to bug reports.
pref("extensions.zotero.seekchat.logContent", false);
// Tool chat: tools switched off (names, comma-separated) and tool settings (tools.<tool>.<option>).
pref("extensions.zotero.seekchat.tools.disabled", "");
pref("extensions.zotero.seekchat.tools.import_references.parser", "zotero");
pref("extensions.zotero.seekchat.tools.import_references.pdf", "find");
pref("extensions.zotero.seekchat.tools.search_library.zotseek", "on");
pref("extensions.zotero.seekchat.tools.search_library.seekbook", "on");
