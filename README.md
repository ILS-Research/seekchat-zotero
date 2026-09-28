# SeekChat

Zotero plugin (Zotero 7–10): chat with a PDF, and with the whole library, a collection or selected
items via ZotSeek, using a self-hosted model (Ollama or any OpenAI-compatible server). Plan and
status: `../ideas-zotseek.md` (German).

## Use

- Install `dist/seekchat-<version>.xpi` (Tools → Plugins → gear → Install Plugin From File).
- Settings → SeekChat: choose interface (Ollama/OpenAI-compatible), server URL, "Verbindung testen",
  pick a chat model. A server that is not on this computer must be listed under
  "Erlaubte entfernte Hosts" (it then receives PDF text and questions).
- Select an item with a PDF, or open a PDF in the reader: the item pane / reader side pane shows the
  section "Chat mit PDF". Citations like [S. 12] in answers open the PDF at that page.
- Library chat (needs ZotSeek with "AI Agent Access" and Zotero's local HTTP server): the speech-bubble
  button right next to ZotSeek's toolbar button opens the chat window. Its scope is the current
  selection (several items, else the collection, else the library). Citations like [2, S. 12] open
  the source's PDF at that page; a source list follows each answer. The scope can be changed in the
  window; a note says what ZotSeek cannot see there (PDFs without parent item, excluded books,
  abstract-only mode). Without ZotSeek the button is not shown; the PDF chat works as before.

## How it works

- PDF text comes from Zotero's PDF worker, split into pages (form feed = page break), cached per attachment.
- If the whole PDF fits into "PDF-Text pro Frage", it is sent in full. Otherwise page 1 plus the pages
  that best match the question (BM25 keyword score; evenly spread pages for questions without terms).
- The model is told to cite pages as [S. N]; N is the physical page number, not the printed page label.
- Ollama is called through its native `/api/chat` so `num_ctx` can be set; its `/v1` endpoint cannot,
  and Ollama's default context would silently cut the document.
- Chats live in memory per PDF until Zotero restarts.
- Library chat: ZotSeek's `/zotseek/search` returns ranked passages; they are grouped into numbered
  sources within the text budget. Hits without text never reach the prompt. There is no fallback:
  without the endpoint there is no library chat.

## Layout

| Path | Purpose |
|---|---|
| `src/core/llm/` | Model clients (Ollama, OpenAI-compatible), stream parsers, HTTP with host check |
| `src/core/host-guard.ts` | Loopback + explicit allow-list, same rules as the ILS ZotSeek fork |
| `src/core/context/` | `ContextProvider` interface; `pdf-context.ts` (PDF pages), `page-selection.ts` |
| `src/core/prompt.ts`, `citations.ts` | Prompt building, citation parsing |
| `src/core/session.ts` | Chat state per context, streaming, abort |
| `src/core/zotseek/client.ts` | ZotSeek REST client: status check, passage search |
| `src/core/library/` | Library chat: numbered sources, `LibraryContextProvider`, citation targets |
| `src/ui/chat-section.ts` | Item pane section (library and reader) |
| `src/ui/library-window.ts`, `content/libraryChat.xhtml` | Library chat window |
| `src/ui/toolbar-button.ts` | Button next to ZotSeek's |
| `src/ui/preferences.ts`, `content/preferences.xhtml` | Settings pane |

New sources are new `ContextProvider`s; the session, prompt and turn rendering stay as they are.

## Build

Everything runs in Docker (`docker/Dockerfile`, Node 22); the host needs only Docker (or sudo docker).

```
./build.sh          # npm install, tests, typecheck, build, dist/seekchat-<version>.xpi
./build.sh test     # tests only
./build.sh build    # build + xpi only
./build.sh shell    # shell in the build container
```

The version comes from `package.json`.

Release: `scripts/publish.py ../zotero_selfhost_src/data/downloads` copies `dist/seekchat-<version>.xpi` to
`downloads/seekchat/` and regenerates `updates.json`; installed copies update themselves. Full output of each run: `logs/build.log`.

## E2E tests

`./e2e/run.sh` runs a real Zotero (version pinned in `e2e/Dockerfile`) headless under Xvfb in
Docker, with the E2E build of the plugin and a mock Ollama server. Scenarios (`test/e2e/scenarios.ts`):
PDF chat (import, page text, streaming, section in library and reader, citation links, long documents,
keywords, chapters) and library chat (ZotSeek stand-in endpoints on Zotero's HTTP server, sources and
citations, scopes, toolbar button, window). Optional live scenarios against a real model server run
with `E2E_LIVE_URL=https://ollama.ils.local E2E_LIVE_MODEL=<model> ./e2e/run.sh`. Results, Zotero log and screenshots land in
`e2e/out/`, the run log in `logs/e2e.log`.
