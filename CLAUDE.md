# SeekChat (Zotero plugin)

Chat with a PDF (item pane section) and with the library via ZotSeek (own window, button next to
ZotSeek's) in Zotero 7–10, using a self-hosted model (Ollama native API or any OpenAI-compatible server). Plan and status: `../ideas-zotseek.md` (German) — keep it updated
when scope or decisions change. User-facing UI text is English with a German translation: every string goes through `t()` in `src/i18n.ts`
(add the key to both tables); prompts to the model are English in code. Section header and context menu use Fluent (`locale/*.ftl`).

**Open review:** `REVIEW_OPUS_5.5_NODOCS.md` (German, code review of v0.12.0) — implement it following its
"Umsetzungsplan" step by step and update the status column there as steps are done.

## Commands

The host (production server) has no usable Node. **Everything runs in Docker** via the scripts;
they use `docker` or fall back to `sudo docker`, and run containers with the caller's uid.

| Task | Command | Log |
|---|---|---|
| Deps, unit tests, typecheck, build, `dist/seekchat-<v>.xpi` | `./build.sh` | `logs/build.log` |
| Unit tests only | `./build.sh test` | `logs/build.log` |
| Build + xpi only | `./build.sh build` | `logs/build.log` |
| E2E build only (`dist/seekchat-<v>-e2e.xpi`) | `./build.sh e2e` | `logs/build.log` |
| E2E run (real Zotero under Xvfb + mock LLM) | `./e2e/run.sh` | `logs/e2e.log`, `e2e/out/` |
| Shell in build container | `./build.sh shell` | |
| Publish built xpi to the portal downloads | `scripts/publish.py ../zotero_selfhost_src/data/downloads` | |

- Scripts write their **full output** to `logs/*.log` (tee, line-buffered). Run them with output
  discarded and read the log tail: `./e2e/run.sh >/dev/null 2>&1; tail -12 logs/e2e.log`.
- The version comes from `package.json` only; `manifest.json` keeps `0.0.0` and is stamped at build.
- `manifest.json` has `update_url` → `<portal>/downloads/seekchat/updates.json`; `scripts/publish.py` copies the
  xpi there and regenerates `updates.json` from all published versions (host python3, no Docker needed).
  The portal serves `data/downloads/` publicly (see the selfhost README, section Downloads). The E2E profile
  disables updates.
- Portal: `https://zotero.ils.local` (this server; until IT switches DNS, `/etc/hosts` maps it to 192.168.125.23).
  Its reverse proxy serves a certificate signed by the in-house CA ILS_GuM (`e2e/certs/ils-gum-ca.crt`, installed in
  the host's system store too); the build image, the E2E image and Zotero's profile trust it (E2E scenario "portal").
  `build.sh` copies `e2e/certs/*.crt` to the generated, git-ignored `docker/certs/`.
- Never commit unless asked. Git repo on branch `master`.

## Layout

| Path | Purpose |
|---|---|
| `bootstrap.js` | Registers chrome (`chrome://seekchat/`), loads `content/scripts/seekchat.js` into a sandbox, calls `Zotero.SeekChat.startup/shutdown` |
| `src/index.ts` | Plugin object `Zotero.SeekChat`: window hooks (FTL + `content/chat.css`), section + pref pane registration |
| `src/prefs.ts` | Typed prefs `extensions.zotero.seekchat.*` (defaults in `prefs.js`) |
| `src/core/host-guard.ts`, `src/core/tls.ts` | Loopback + explicit allow-list for model hosts (same rules as `../zotseek-src` fork); with an API key https only (except loopback); "Accept invalid certificate" = session cert override (copy of SeekBook's `tls.ts`) |
| `src/core/llm/` | `OllamaClient` (`/api/chat`, sets `num_ctx`), `OpenAiClient` (`/chat/completions`), stream parsers, HTTP with host check and `redirect: 'error'` |
| `src/core/context/` | `ContextProvider` interface; `pdf-context.ts` (PDF worker text, split on `\f`), `page-selection.ts` (full text or page 1 + BM25 pages) |
| `src/core/prompt.ts`, `citations.ts` | Messages (system prompt + document), `[S. N]` citation parsing |
| `src/core/seekbook/client.ts`, `src/core/library/source-rules.ts` | SeekBook over REST (`/seekbook/stats`, `/search`, `/books`, `/pages`); which sources may be combined (SeekBook locked while ZotSeek includes it) |
| `src/core/zotseek/client.ts` | ZotSeek REST (`/zotseek/search`, `/zotseek/stats`) on Zotero's local server: status/diagnosis, passage search. No fallback: without the endpoint there is no library chat |
| `src/core/library/` | Library chat without UI: `sources.ts` (`Evidence` from all sources → numbered sources, stable numbers, carry-over; **the PDF is kept per excerpt** — `attachmentFor()` picks the PDF a citation opens, `pageGroups()` groups pages per PDF for list, export and note), `plan.ts` (planning call: standalone question, queries, keywords as JSON), `books.ts` + `book-excerpts.ts` (keyword scan per book, pre-reading prompt `[Page N]` passages), `library-context.ts` (`LibraryContextProvider`, scopes, multi-query ZotSeek search), `zotero-items.ts` (library keys, `openSourceCitation`) |
| `src/ui/library-window.ts`, `content/libraryChat.xhtml` | Library chat window (one instance; the xhtml calls `Zotero.SeekChat.onLibraryWindowLoad`, the plugin builds the DOM) |
| `src/ui/toolbar-button.ts` | Button right after `#zotseek-toolbar-button`, kept in sync by a MutationObserver (plugin start order is not fixed) |
| `src/ui/turn-view.ts`, `src/ui/markdown.ts` | Rendering of one chat turn (safe Markdown subset, page or source citations, source list), shared by section and window |
| `src/core/library/coverage.ts` | What ZotSeek cannot see in a scope (standalone PDFs, excluded books, abstract mode), from Zotero and ZotSeek's global prefs |
| `src/core/session.ts` | One `ChatSession` per provider key, streaming, abort; in memory only. Library chat pipeline: plan → ZotSeek + SeekBook + keyword books (two at a time, each skippable via `skipBook`; books SeekBook has indexed skip the keyword reading, also when ZotSeek brings SeekBook) → merged sources → one answer |
| `src/ui/chat-section.ts` | Item pane section via `Zotero.ItemPaneManager.registerSection` (library + reader context pane) |
| `src/ui/preferences.ts`, `content/preferences.xhtml` | Settings pane (fields wired manually, not via `preference=` binding) |
| `src/core/context/clean.ts` | Running headers/footers removed in `getPdfPages` (copy of SeekBook's rules) |
| `src/core/context/index-access.ts` | PDF chat strategy "semantic": SeekBook (books) / ZotSeek (other PDFs), index state, hand-over |
| `src/util/log.ts` | `logger(module)`: `[SeekChat:<module>] [LEVEL] …` to Browser Console + `Zotero.debug`, `time()` for durations. Log every step that can take long (model calls are logged in `src/core/llm/index.ts`). Text from the user or the document goes through `content()` (only its length unless the hidden pref `seekchat.logContent` is on) |
| `test/*.test.ts` | Unit tests (Node test runner, bundled by esbuild), no Zotero |
| `test/e2e/` | E2E harness + scenarios, compiled **into** the E2E build only (`test/e2e/entry.ts`) |
| `e2e/` | E2E image (Zotero tarball, Xvfb, mock LLM, fixture PDF generator), `run.sh`, `run-in-container.sh` |

Extending: new sources are new `ContextProvider`s; session, prompt and turn rendering stay. The library chat
(`src/core/library/`) is one: ZotSeek's REST `/zotseek/search` (`granularity=passages`, text in
`matchedChunk.snippet`) via `src/core/zotseek/client.ts`, see `../ideas-zotseek.md`.

## Pitfalls (learned the hard way)

- **SeekChat must work without ZotSeek** (PDF chat only). Nothing outside `src/core/zotseek/` may assume ZotSeek;
  never fall back to other search paths (`api.search()` etc.) when `/zotseek/search` is unavailable.
- Requests to Zotero's local server (`127.0.0.1:<Zotero.Server.port>`) need the header `Zotero-Allowed-Request`,
  since our fetch carries a browser user agent. E2E tests stand in for ZotSeek by registering
  `Zotero.Server.Endpoints[...]` directly.

- **`Zotero.Prefs.get/set(key, true)` means "global": no `extensions.zotero.` prefix.** Use the
  default (no second argument) so keys match `prefs.js` and `user.js`. ZotSeek upstream uses
  `true` everywhere, so its real keys are `zotseek.*`, not what its `prefs.js` declares.
- The plugin runs in a bootstrap sandbox: `AbortController`, `TextDecoder`, sometimes `fetch` are
  missing. Use `src/util/env.ts`, which borrows them from the main window.
- `Zotero.Reader.open(itemID, { pageIndex })` is 0-based; citations `[S. N]` are physical pages
  (1-based), not printed page labels.
- Item pane sections render lazily; in the reader the context pane starts **collapsed** in a fresh
  profile. E2E scenarios open it (`ZoteroContextPane.collapsed = false`) and scroll to the pane.
- Find the section by the namespaced id from `getRegisteredPaneID()` on any `[data-pane]` element,
  not by a fixed element name.
- Chrome windows ignore synthetic events unless the listener opts in (Gecko's 4th `addEventListener` argument,
  `wantsUntrusted`); tests dispatch `focus` on the library window.
- Stand-in endpoints on `Zotero.Server.Endpoints` need `init(requestData)` with a parameter: Zotero picks the call
  style by `init.length`, and `init()` without one waits for a callback that never comes.
- The section header needs Fluent ids (`locale/*/seekchat-main.ftl`, inserted per window);
  everything else in the UI goes through `t()` (`src/i18n.ts`).
- **PDF outline:** Zotero 10's reader loads the outline only while its sidebar shows the outline view,
  so `reader._internalReader._state.outline` stays `null` otherwise. `src/core/context/pdf-outline.ts`
  reads it from the file instead, with Zotero's own pdf.js (`resource://zotero/reader/pdf/build/pdf.mjs`)
  imported into the main window via `win.eval("import(...)")` (the sandbox lacks DOM/Worker APIs).
- Zotero's PDF worker joins lines of the same font into running text; headings rarely sit on their
  own line. Running page headers/footers (title, page number, license) precede every page's text.
- Real-document checks: put PDFs into `test/assets/` (ignored by git); the E2E scenario
  "assets" writes `e2e/out/assets-report.json` (pages, timings, fit, outline, keyword selection).
- **Ollama reloads the model whenever `num_ctx` changes (5–6 s each).** All calls use the resolved `prefs.numCtx`;
  never give helper calls their own context size. Thinking models reason by default and Ollama hides that in
  `message.thinking`: helper calls send `think: false`, answers `think: prefs.thinking` (default off).
- Ollama's `/v1` endpoint ignores `num_ctx`; with its small default context the PDF is silently
  truncated. Keep Ollama on the native API.
- Log lines must go to `Services.console` (see `src/util/log.ts`): a sandbox's `console`, even the main window's
  called from the sandbox, never reaches the Browser Console. E2E "logging reaches the Browser Console" checks it.
- Live run with a real book index: `E2E_SEEKBOOK_XPI=../seekbook-zotero_src/dist/seekbook-<v>.xpi E2E_TIMEOUT=3000
  E2E_LIVE_URL=… ./e2e/run.sh` (indexes `test/assets/JIRASOFTWARESERVER071-290216.pdf` with qwen3-embedding:8b).
- Follow-ups must stay small (a new search is only a top-up: `FOLLOWUP_TOP_K`, `FOLLOWUP_SHARE` in session.ts); carried sources hold only cited excerpts, and a new search only runs when the planner
  sets `"search": true` (mock: `e2e/mock-*.mjs` decides by the question's words).
- Test PDFs must not start every page with the same sentence (it counts as a running header and is removed):
  `e2e/make-pdf.mjs` rotates its filler sentences; `seekchat-headers.pdf` has a real header, footer and page labels.
- Library window: the SeekBook switch stays locked until ZotSeek's status **and** the scope coverage are known
  (SeekBook's status arrives first; unlocking on it alone let the box flash up as allowed).

## E2E

- `e2e/run.sh` → builds the E2E xpi, builds image `seekchat-e2e` (Zotero version pinned by
  `ZOTERO_VERSION` in `e2e/Dockerfile`), runs a fresh profile with the xpi sideloaded, the mock
  LLM on `127.0.0.1:11434` and prefs `seekchat.e2e.*` set in `user.js`.
- The harness waits for the main window, runs `test/e2e/scenarios.ts` in order, writes
  `e2e/out/results.json`, screenshots (`screenshot-final.png`, one per failure) and quits Zotero.
  `e2e/out/zotero.log` has Zotero's debug output (grep `SeekChat`).
- No results usually means Zotero hung on a modal dialog (e.g. missing data dir) — check the
  first lines of `zotero.log`. Timeout: `E2E_TIMEOUT` (seconds, default 240).
- Scenarios share state through `ctx`; add new ones at the end. Use `waitFor` and include
  diagnostics in failure messages (see `describePanes`).
- Scenarios run against the mock. The last ones are **optional live scenarios** against a real server,
  skipped (reported as `skip`) unless `E2E_LIVE_URL` is set:
  `E2E_LIVE_URL=https://ollama.ils.local E2E_LIVE_MODEL=qwen3_8_27b_128k:latest ./e2e/run.sh`
  (optional `E2E_LIVE_PROVIDER=openai`, `E2E_LIVE_API_KEY=…` for servers with a bearer key)
  (timeout then defaults to 600 s; answers land in `e2e/out/live-report.json`). Optional scenarios
  throw `SkipError` from `test/e2e/harness.ts` when a prerequisite is missing.
- In-house CAs: `e2e/certs/*.crt` (currently `ils-gum-ca.crt`, CN=ILS_GuM, signs `*.ils.local`) go into the
  image's system store and, via `certutil`, into the profile's NSS db — Zotero ignores the system store.
