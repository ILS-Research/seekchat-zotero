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
// Ollama only: context window in tokens (num_ctx). Ollama's default is small
// and would silently cut the document off.
pref("extensions.zotero.seekchat.numCtx", 16384);
// Maximum answer length in tokens.
pref("extensions.zotero.seekchat.maxTokens", 2048);
// Budget of document text sent per question, in characters (~3.5 chars per token).
// Must fit into numCtx together with the answer.
pref("extensions.zotero.seekchat.contextChars", 40000);
// Previous question/answer pairs sent along for follow-up questions.
pref("extensions.zotero.seekchat.historyTurns", 4);
// Empty = built-in default prompt.
pref("extensions.zotero.seekchat.systemPrompt", "");
// Comma-separated host names that may serve the chat model in addition to
// this computer. Empty = loopback only. Hosts listed here receive the PDF text
// and all questions.
pref("extensions.zotero.seekchat.allowedRemoteHosts", "");
// Library chat (needs ZotSeek): passages requested per question (1-100).
pref("extensions.zotero.seekchat.libraryTopK", 30);
// "auto": context window, answer length and text budget from the model (server info minus 20 %),
// "manual": the three values above.
pref("extensions.zotero.seekchat.limitsMode", "auto");
// UI language: "" = follow Zotero, or "en" / "de".
pref("extensions.zotero.seekchat.locale", "");
