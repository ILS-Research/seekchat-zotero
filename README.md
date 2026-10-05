# SeekChat – talk to your papers and books in Zotero

Ask a question about the PDF you are reading, or about a whole collection, and get an answer that cites its
sources: every **[S. 12]** or **[2, S. 45]** in the answer is a link that opens the PDF on exactly that page.

SeekChat uses a language model **you** run (Ollama or any OpenAI-compatible server, e.g. on your institute's server).
Your documents are never sent to a cloud service unless you explicitly allow that server.

Works with Zotero 7, 8, 9 and 10 (recommended: 10).

---

## What you can do

### Chat with a PDF
Select an item with a PDF, or open it in the reader: the side pane shows **“Chat mit PDF”**.

- Ask anything – summaries, definitions, “what does chapter 3 say about …?”.
- Follow-up questions work like in a conversation (“and in chapter 4?”).
- Long books are no problem: SeekChat picks the pages that matter for your question and tells you which ones it read.
- Answers cite pages; one click opens the PDF there. Printed page numbers are known too; running headers and footers
  are removed before anything is sent.
- **"This page" works:** with the PDF open in the reader, the current page and its neighbours always go along.
- **Your notes as context:** tick notes of the item and they go along with every question.
- **Save what matters:** every answer has a "📝 As note" button; the whole chat goes to Markdown or a note.
- **Long books:** keyword search, chapter selection, or semantic search through SeekBook (books) / ZotSeek (papers) –
  a button hands a document not yet indexed to the right index.

### Web pages, e-books, text files
The same chat works for **HTML snapshots** (saved web pages), **EPUB** e-books and **text files** (.txt, .md, .csv).
They have no page numbers, so answers refer to the document as a whole (as a reference list would) instead of citing
pages. Long ones are cut into sections and searched by keywords like long PDFs.

### Chat with your library
The speech-bubble button next to ZotSeek’s toolbar button opens a chat over **the current selection, a collection
or a whole library**. You choose where the answers come from:

| Source | What it does | Needs |
|---|---|---|
| **ZotSeek** | finds the best-matching passages in your papers | [ZotSeek](https://github.com/introfini/ZotSeek) with “AI Agent Access” |
| **Books (keyword search)** | reads the books in the scope like the PDF chat does – no index needed | nothing |
| **Books (own index)** | searches whole books with chapter and printed page numbers | [SeekBook](https://github.com/ILS-Research/seekbook-zotero) |

- One answer from all sources, with numbered sources and a source list with page links.
- Books with several PDFs (one per chapter) open at the right PDF.
- A line tells you what is covered – and what is not (e.g. PDFs without a parent item).
- **First question = search, then discussion:** the first question searches all chosen sources. Follow-ups work on
  that result – they see the passages cited so far and are much faster. Ask for more when you need it:
  *“What exactly is on page 45 of [2]?”*, *“search also for …”*; for a new topic start a new chat.
- Save a chat as Markdown or as a Zotero note.

### Tool chat: let SeekChat act in Zotero
The speech bubble with a plus in the items toolbar (no ZotSeek needed) opens a **general chat whose model can use
Zotero tools**: you ask in plain language, the model decides which tools to call, one after the other.

> **Model requirement:** the tool chat needs a **strong open-weights model with good native tool calling**
> (function calling through the OpenAI-compatible API, not tool calls written as text). Small models call tools
> unreliably, invent arguments or stop half way. We use **`qwen3.8:27b`**, which needs **about 40 GB of RAM/VRAM**
> on the model server. The PDF and library chats work with smaller models.

What it can do:

- **Import references:** paste one reference or a whole bibliography ("Importiere diese Quellen …"). Zotero looks up
  DOIs, ISBNs, PMIDs, arXiv ids and web pages itself (like *Add Item by Identifier*); the rest is created from the
  reference text. **PDFs come along** where freely available (like *Find Full Text*).
- **Ask about your library:** "Which papers on heat islands do I have since 2020?", "Which tags do I use for
  methods?" – it searches with Zotero's search and, if installed, ZotSeek and SeekBook, reads items, collections,
  tags and your current selection, and links what it finds. It can page through a whole collection.
- **Read documents:** the text of chosen pages of a PDF (or sections of a web page, e-book, text file), e.g. the
  title page to see what a document really is.
- **Correct items:** change item type, fields and tags – "check whether the item types in this collection are right".
  Fields that the new type does not have are listed before anything changes.
- **Write notes:** a note from the model's text, on an item, in a collection or in the library.
- **Collect what you found:** "Put these papers into a new collection Projekt A / Hitze".
- **Related sources from a reference list:** with Find Online References installed, it reads a document's bibliography,
  picks the fitting entries and links them (DOI, arXiv, web page or Google Scholar).
- **Subagent for long tasks:** reading-heavy tasks (e.g. every item of a large collection) go to a subagent that
  works through them in packages of 20 with the read-only tools and returns only its result, so the chat's context
  stays small. **Stop subagent** stops it alone; the chat goes on with the results so far.

How it behaves:

- **Nothing changes without you:** every tool that changes something (import, item changes, notes, collections) shows
  a **preview with checkboxes** first and waits for your confirmation. The subagent only reads.
- **Tool calls stay out of the way:** all calls of an answer sit in one closed block with a single status line; it opens
  by itself only while the chat waits for your confirmation, and you can open it any time.
- New items and notes go to the target chosen at the top: the collection selected in Zotero or a library.
- The **Tools** section at the top lists all tools (scrollable): switch single ones off, and choose the lookup for
  imports – Zotero's own, or [Find Online References](../zotero-reference_src) first (better title search for
  references without DOI). Tools that need a missing plugin are greyed out.

---

## Install

1. Download the latest `seekchat-<version>.xpi` (ILS: from the internal download portal).
2. Zotero → **Tools → Plugins** → gear icon → **Install Plugin From File…**
3. Updates come automatically afterwards.

## Set up

**Settings → SeekChat**

1. Enter the server address – the root of an Ollama server (e.g. `https://ollama.example.local`, SeekChat adds `/v1`)
   or the full `/v1` base of any OpenAI-compatible server (vLLM, llama.cpp, LM Studio …) – and click
   **Verbindung testen** (test connection).
2. Pick a chat model from the list.
3. A server that is not on your own computer must be added under **Erlaubte entfernte Hosts** (allowed remote hosts)
   – it then receives the PDF text and your questions.

For the library chat also switch on Zotero’s local HTTP server (Settings → Advanced) and, in ZotSeek,
“AI Agent Access”.

## When something goes wrong

- **The answer takes long:** the status line under the question shows what SeekChat is doing (planning the search,
  reading book 2 of 5, answering). Reading many books by keywords costs one model call per book – use
  “Books (own index)” for large book collections.
- **Look at the log:** Zotero → **Tools → Developer → Browser Console** (or Help → Debug Output Logging), filter
  by `[SeekChat`. Every step is logged with its duration: searches, each model call (size, time to first token,
  total time), which books were read and why.

## Issues and ideas

Please report bugs and wishes as **work items on gitlab.com**:
https://gitlab.com/ils-research/zotero-plugins/seekchat-zotero/-/work_items. Issues are switched off on the GitHub
mirror; releases are published on both.

---

## For developers

<details>
<summary>How it works</summary>

- PDF text comes from Zotero’s PDF worker, split into pages, cached per attachment.
- If the whole PDF fits into the budget (“PDF-Text pro Frage”) it is sent in full; otherwise page 1 plus the pages
  that best match the question (BM25; evenly spread pages for questions without terms).
- `[S. N]` is the physical page number, not the printed label.
- The model server is used only through its OpenAI-compatible interface (`/v1/models`, `/v1/chat/completions`), so
  Ollama, vLLM and other servers work alike. SeekChat never sends a context size; the text budget follows the window
  the server reports (vLLM: `max_model_len` in `/v1/models`). Ollama does not report it there, so SeekChat asks its
  native API read-only (`/api/ps`, `/api/show`) – the only Ollama-specific call.
- Library chat: a planning call writes search queries (and page/document requests for follow-ups); ZotSeek
  (`/zotseek/search`) and SeekBook (`/seekbook/search`) are searched with them; books SeekBook has indexed are not
  read by keywords again; ZotSeek book passages that SeekBook covers are dropped. Everything is merged into
  numbered sources within the text budget; one streamed answer cites them.
- No fallback: without the ZotSeek/SeekBook endpoints those sources are simply unavailable.

</details>

<details>
<summary>Layout</summary>

| Path | Purpose |
|---|---|
| `src/core/llm/` | OpenAI-compatible client, read-only Ollama window probe, stream parsers, HTTP with host check, call logging |
| `src/core/host-guard.ts` | Loopback + explicit allow-list, same rules as the ILS ZotSeek fork |
| `src/core/context/` | `ContextProvider` interface; `pdf-context.ts` (PDF pages), `page-selection.ts` |
| `src/core/prompt.ts`, `citations.ts` | Prompt building, citation parsing |
| `src/core/session.ts` | Chat state, library pipeline, streaming, abort |
| `src/core/zotseek/client.ts` | ZotSeek REST client |
| `src/core/seekbook/client.ts` | SeekBook REST client (status, search, books, pages) |
| `src/core/library/` | Sources, scopes, coverage, source rules, keyword book reading |
| `src/ui/` | Item pane section, library window, toolbar button, settings |
| `src/util/log.ts` | Logger (`[SeekChat:<module>] [LEVEL] …`) |

</details>

<details>
<summary>Build, tests, release</summary>

Everything runs in Docker; the host needs only Docker.

```
./build.sh          # npm install, tests, typecheck, build, dist/seekchat-<version>.xpi
./build.sh test     # unit tests only
./e2e/run.sh        # real Zotero under Xvfb with mock LLM, ZotSeek and SeekBook stand-ins
```

Live scenarios: `E2E_LIVE_URL=https://ollama.ils.local E2E_LIVE_MODEL=<model> ./e2e/run.sh`.
Version only in `package.json`. Release: `scripts/publish.py ../zotero_selfhost_src/data/downloads`.
Logs: `logs/build.log`, `logs/e2e.log`, `e2e/out/`. Details: `CLAUDE.md`, `CHANGELOG.md`.

</details>
