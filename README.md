# SeekChat

Zotero plugin (Zotero 7–10): chat with a PDF using a self-hosted model (Ollama or any
OpenAI-compatible server). Stage 2 of the plan in `../ideas-zotseek.md`; library-wide chat via
ZotSeek comes later.

## Use

- Install `dist/seekchat-<version>.xpi` (Tools → Plugins → gear → Install Plugin From File).
- Settings → SeekChat: choose interface (Ollama/OpenAI-compatible), server URL, "Verbindung testen",
  pick a chat model. A server that is not on this computer must be listed under
  "Erlaubte entfernte Hosts" (it then receives PDF text and questions).
- Select an item with a PDF, or open a PDF in the reader: the item pane / reader side pane shows the
  section "Chat mit PDF". Citations like [S. 12] in answers open the PDF at that page.

## How it works

- PDF text comes from Zotero's PDF worker, split into pages (form feed = page break), cached per attachment.
- If the whole PDF fits into "PDF-Text pro Frage", it is sent in full. Otherwise page 1 plus the pages
  that best match the question (BM25 keyword score; evenly spread pages for questions without terms).
- The model is told to cite pages as [S. N]; N is the physical page number, not the printed page label.
- Ollama is called through its native `/api/chat` so `num_ctx` can be set; its `/v1` endpoint cannot,
  and Ollama's default context would silently cut the document.
- Chats live in memory per PDF until Zotero restarts.

## Layout

| Path | Purpose |
|---|---|
| `src/core/llm/` | Model clients (Ollama, OpenAI-compatible), stream parsers, HTTP with host check |
| `src/core/host-guard.ts` | Loopback + explicit allow-list, same rules as the ILS ZotSeek fork |
| `src/core/context/` | `ContextProvider` interface; `pdf-context.ts` (PDF pages), `page-selection.ts` |
| `src/core/prompt.ts`, `citations.ts` | Prompt building, citation parsing |
| `src/core/session.ts` | Chat state per context, streaming, abort |
| `src/ui/chat-section.ts` | Item pane section (library and reader) |
| `src/ui/preferences.ts`, `content/preferences.xhtml` | Settings pane |

New sources (ZotSeek passages for library chat, collections) are new `ContextProvider`s; the session,
prompt and UI stay as they are.

## Build

Everything runs in Docker (`docker/Dockerfile`, Node 22); the host needs only Docker (or sudo docker).

```
./build.sh          # npm install, tests, typecheck, build, dist/seekchat-<version>.xpi
./build.sh test     # tests only
./build.sh build    # build + xpi only
./build.sh shell    # shell in the build container
```

The version comes from `package.json`.

Release: `scripts/publish.py <portal>/data/downloads` copies `dist/seekchat-<version>.xpi` to
`downloads/seekchat/` and regenerates `updates.json`; installed copies update themselves. Full output of each run: `logs/build.log`.

## E2E tests

`./e2e/run.sh` runs a real Zotero (version pinned in `e2e/Dockerfile`) headless under Xvfb in
Docker, with the E2E build of the plugin and a mock Ollama server. Scenarios (`test/e2e/scenarios.ts`):
plugin loads, PDF import and page extraction, streamed answer, chat in the library item pane and in
the reader side pane, citation link opens the right page. Results, Zotero log and screenshots land in
`e2e/out/`, the run log in `logs/e2e.log`.
