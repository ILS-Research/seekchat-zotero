# Changelog

## 0.19.0 – 2026-10-03

- **Tool chat can search and read the library** – five new read-only tools, each in the tool list (switchable):
  - **Search the library:** topic, title, author, year range, item type, tags, collection (with subcollections), "has
    PDF", added after a date, optionally Zotero's full-text search. Besides Zotero's own search it asks **ZotSeek**
    (meaning-based search in papers) and **SeekBook** (search in books) when installed – both are settings of the tool,
    on by default when the plugin is there, otherwise off. Hits are joined per item, filters apply to all sources,
    passage hits show a short excerpt (with chapter and page for books); SeekBook is not asked twice when ZotSeek
    already brings its passages. Found items are listed with links.
  - **Read items:** fields, creators, abstract and – on request – notes, attachments, tags, collections, related items.
  - **Current selection:** selected items, collection or library, and in the reader the open document and marked text.
  - **List collections** (as paths, with item counts) and **list tags** (with how many items carry them).
- The tool chat's system prompt names today's date; the library chosen at the top is now labelled "Library" (searched,
  and receiving imported items).
- Tool settings: a choice that is not available (plugin missing) falls back to the first available one.

## 0.18.0 – 2026-10-03

- **Chat with web pages, e-books and text files**, not only PDFs: HTML snapshots (e.g. the ones saved when importing
  references), EPUB and plain text files (.txt, .md, .csv …). The chat section shows up for them in the library and in
  the reader; an item without PDF uses its EPUB, then web page, then text file. "Chat with this file" works for them too.
- Their text comes from Zotero's full-text index (Zotero extracts HTML and EPUB itself) or the file, cut into sections
  of about a page; long documents get the same keyword selection as PDFs (semantic search stays PDF-only).
- **No location citations** for these documents – as a reference list cites a web page or e-book as a whole, answers
  refer to the document, not to pages or sections. The meta line says "Volltext (Webseite)" or
  "Auszüge (Textdatei): 3 von 26 Abschnitten …".

## 0.17.1 – 2026-10-03

- **Fix:** the check for SeekChat's item menu entries can no longer throw inside Zotero's menu building (an item whose
  attachments are not loaded yet); our entries then just stay hidden. E2E: the item context menu opens right after an
  import with PDF download.
- Tests: the full E2E suite passes on Zotero 7.0.32, 8.0.4, 9.0.4 and 10.0.3.

## 0.17.0 – 2026-10-03

- **SeekChat never sets the context window (`num_ctx`) any more:** Ollama reloaded the model whenever it differed
  from the loaded one. Now the server's own window is used, and the text budget follows it: for Ollama the window of
  the loaded model (`/api/ps`), else `num_ctx` from the Modelfile, else Ollama's default (4096) – no longer the model's
  maximum, which Ollama does not use unasked. The settings show where the value comes from. Manual mode: the context
  window is what the server is known to use (set it in the Modelfile or with `OLLAMA_CONTEXT_LENGTH`).
- **Import references:** references with a DOI, ISBN, PMID or arXiv id go straight to Zotero's identifier lookup
  (all registration agencies, e.g. DataCite); Find Online References is used for references without identifier,
  its strength (title search). Failed intermediate steps are shown only when nothing was found, no longer next to
  a successful lookup ("Suche fehlgeschlagen: … 404" for a DataCite DOI).

## 0.16.1 – 2026-10-03

- **Fix (tool chat):** ticking or unticking a reference in the import preview no longer jumps to the end of the chat.
  The window follows a running answer only while no tool waits for confirmation.

## 0.16.0 – 2026-10-03

- **Import references now fetches the PDF:** after saving, Zotero's "Find Full Text" runs for each new item (DOI
  landing page, the reference's link – also a direct PDF link –, open access via Unpaywall/PMC, custom resolvers set
  up in Zotero). Zotero forces links to https; a plain http link that is a PDF (content type checked) is downloaded
  directly, since many reports are served over http only. Each item shows "PDF attached" / "no freely available PDF
  found"; the model is told how many PDFs were attached.
- New setting of the tool (tool list): **PDF – find and attach / do not download**.

## 0.15.0 – 2026-10-03

- **Tool list in the tool chat:** a collapsible section at the top lists all tools; each can be switched off (the model
  then is not offered it) and has its settings there. Stored as prefs (`seekchat.tools.*`).
- **Import references: choice of lookup** – Zotero's own translators, or **Find Online References (zotero-reference)**
  first (its parser and plausibility-checked title search via Crossref, OpenAlex …), then Zotero. Used through the
  plugin's public API at runtime; offered only while the plugin (0.7.33+) is installed, otherwise Zotero's lookup is used.

## 0.14.0 – 2026-10-03

- **New: tool chat** – a third chat next to the PDF and library chat, in its own window (button in the items
  toolbar, works without ZotSeek). Its model can act in Zotero through tools (function calling, Ollama and
  OpenAI-compatible servers).
- **First tool: import references.** Paste references or a bibliography: the model splits them, Zotero looks up DOIs,
  ISBNs, labelled PMIDs, arXiv ids and web pages with its own translators, the rest is created from the text. A preview
  marks items already in the library (unchecked); only confirmed items are saved, into the selected collection or a
  library.
- Built to be extended: further tools register in `src/core/tools/`, further lookup sources (e.g. zotero-reference)
  as resolvers in front of Zotero's own.
- E2E image can run Zotero 7 again (`.tar.bz2` download).

## 0.13.3 – 2026-09-29

- Internal: `session.ts` split up (review, maintainability): the library chat's pipeline is its own module
  (`library/pipeline.ts`), turn types, helper model calls, notes context and abort helpers have their own files.
  The keyword call shared by books of one language is a small, tested `SharedCalls`. No change in behaviour.

## 0.13.2 – 2026-09-29

- **Memory bounded, generously** (review item 9): page texts of the 100 most recently used PDFs, page labels of 500,
  chats of the 500 most recently opened PDFs and scopes stay in memory; a running chat is never dropped.

## 0.13.1 – 2026-09-29

Fixes from the code review (`REVIEW_OPUS_5.5_NODOCS.md`, items 11 and 13):

- **No questions in the log by default:** questions, search plans, search terms and removed page lines are logged
  only as their length (debug output is often attached to bug reports). The hidden pref
  `extensions.zotero.seekchat.logContent` = true logs the text again.
- **Notes as context read all entities:** numeric (`&#8211;`, `&#x2014;`) and common named ones (`&ndash;`,
  `&auml;` …) are decoded.

## 0.13.0 – 2026-09-29

More fixes from the code review (`REVIEW_OPUS_5.5_NODOCS.md`, items 2, 3, 6, 12 and the small clean-ups):

- **API key only over https:** with an API key set, a server on another computer must be reached via `https://`
  (loopback stays allowed). New setting **"Accept invalid certificate"** (self-signed, expired, other name): adds a
  certificate exception for the chat server until Zotero restarts, as in SeekBook. A failing https connection
  points to the setting.
- **Follow-ups send only complete question/answer pairs:** a question whose answer failed or was cancelled is left
  out with it (no two questions in a row, which strict chat templates reject; no half answers). "Previous questions
  sent" now counts pairs.
- **Thinking is switched off for a model only on HTTP 400 "does not support thinking"**, not on any error that
  mentions "think".
- Clean-ups: dead "strategy not available" branch removed, imports tidied, error text in the settings translated.

## 0.12.1 – 2026-09-29

Fixes from the code review (`REVIEW_OPUS_5.5_NODOCS.md`, items 1, 4, 5, 7, 8):

- **Skipping a book no longer fails other books** of the same language: the shared search-term call belongs to the
  whole question, a skipped book only stops waiting for it.
- **Streams are closed** when the answer ends early (done event, error), so the model server stops sending.
- **Custom system prompt keeps clickable citations:** the page citation format is always added to it.
- **Only changed messages are redrawn** while an answer streams: text in earlier answers can be selected, and the book
  list keeps the state the user gave it.
- The ZotSeek "no JSON response" detail is translated.

## 0.12.0 – 2026-09-29

- **The page open in the reader goes along:** when a long PDF is open in a reader tab, the current page and two on
  each side are always sent (besides the pages the strategy picks), and the model is told which page the user is
  looking at ("this page" / "here" works). The meta line names them.

## 0.11.0 – 2026-09-29

- **Running headers and footers removed** from PDF pages (title, chapter, page number, licence lines that recur on
  many pages; same rules as SeekBook). They no longer cost budget on every page or hide headings. JIRA documentation:
  the Creative Commons header on all 304 pages is gone.
- **Printed page numbers** in the PDF chat: pages go to the model as `[Page 27] (printed 25)`; citations stay the
  PDF page, the printed number is there when the user asks for it.
- **Notes as context** (PDF chat): a small "Notes as context" area lists the item's notes; ticked ones go along with
  every question (up to 30 % of the text budget), the meta line names them.
- **Single answers as notes**: every finished answer has a "📝 As note" button – PDF chat: child note of the item;
  library chat: placed like the chat note (collection / related items).

## 0.10.0 – 2026-09-29

- **PDF chat: the strategy "Semantic search" works** – without an index of SeekChat's own: a book PDF is searched in
  SeekBook (only this PDF), any other PDF in ZotSeek (filtered to the item). The hits pick the pages (plus page 1 and
  neighbours); no keyword call, citations stay `[S. N]`. Live (JIRA documentation, 304 pages): 29 matching pages,
  one model call.
- While the document is not in its index the strategy is greyed out with the reason and a button "Add the book to
  SeekBook" / "Add the item to ZotSeek" (ZotSeek: through its plugin object, a hint when that is not possible).
  Nothing found or index not reachable: keyword search, the meta line says so.

## 0.9.8 – 2026-09-29

- **Pages of indexed books come from SeekBook** ("What is on p. 27 of [2]?"): cleaned text without running headers,
  from the PDF the page belongs to; without SeekBook (or for books it does not know) the PDF is read as before.
- **Books missing from the SeekBook index are named** in the meta line when "Books (own index)" is used without the
  keyword reading, with the hint to tick "Books (keyword search)" or index them.
- **The keyword reading asks every PDF of a book** (chapter PDFs, appendices), not only the best one; exact copies
  (same file hash) are skipped, and the progress list names each PDF.

## 0.9.7 – 2026-09-29

- **Much faster on Ollama:** every call now uses the same `num_ctx` (helper calls used 4096/8192 before; each switch
  made Ollama reload the model, 5–6 s, twice per question), and helper calls send `think: false`. Answers no longer
  run a hidden reasoning phase either (Qwen 3 reasoned by default and the reasoning never reached SeekChat); new
  setting "Let the model think before answering" switches it back on. Live (JIRA documentation, qwen3 27B): first
  question 84 → 52 s, follow-up 81 → 39 s, first token of the follow-up 34 → 7 s.

- **Follow-ups on a new aspect only top up the result:** at most 8 hits per query and 35 % of the text budget
  (at least 12 000 characters) instead of a second full search. Before, "and what is a backlog?" sent a prompt as
  large as the first question (115 000 characters in the reported chat).
- **Overlapping excerpts of one source** are cut to their new sentences (marked "…") or dropped when almost nothing
  new is left; neighbouring book passages often share whole paragraphs without one containing the other.
- "Search in [n]" for a **book** goes to SeekBook (ZotSeek usually has no or only partial book text); the meta line
  names the index used.
- E2E: SeekBook can be sideloaded (`E2E_SEEKBOOK_XPI`); a live scenario indexes the JIRA documentation
  (`test/assets`, CC BY 2.5) with SeekBook and asks the two questions of the report.

## 0.9.6 – 2026-09-29

- **Follow-ups discuss the result instead of searching everything again.** The first question searches all sources;
  from the second on, the planner decides whether the question needs new material (`"search": true`, e.g. a new
  aspect or "search also for …"). Otherwise no ZotSeek/SeekBook search and no book reading: the answer uses the
  passages cited so far plus pages/documents asked for. The meta line says which way it went.
- Carried sources keep **only the cited excerpts** (pages named in `[n, S. x]`; two excerpts for a source cited
  without page) instead of all excerpts of a cited source. Live (qwen3 27B): first question 74 s, follow-up 24 s.
- The hint after the first answer and the input placeholder explain this workflow.
- Fix: log lines did not reach the Browser Console (the sandbox's console does not); they now go to the console
  service. E2E checks it.

## 0.9.5 – 2026-09-29

- Fix: "Books (own index)" no longer shows as allowed right after opening the window; it stays locked until
  ZotSeek's status and coverage are known.
- Books that ZotSeek already brings through SeekBook are no longer read by keywords as well (that took one model
  call per book and repeated the same passages); the book list only shows the books actually read.
- **Logging** like ZotSeek: `[SeekChat:<module>] [INFO] …` in the Browser Console and Zotero's debug output – each
  pipeline step with its time, each model call (prompt size, time to first token, total), REST calls to ZotSeek and
  SeekBook, each book's progress.
- README rewritten for users (technical details at the end).

## 0.9.4 – 2026-09-29

- **"Books (own index)" answers now** (SeekBook, M4): the library chat searches SeekBook with the planned queries
  (library, collection or selection; a collection or selection sends only its books). Passages keep their PDF,
  chapter and printed page number; the prompt shows them ("chapter: …", "printed 25").
- Books SeekBook has indexed (new `/seekbook/books`, SeekBook 0.3.0) are no longer read by keywords when both book
  sources are ticked; only the others are.
- With ZotSeek indexing books itself, its passages from books SeekBook covers are left out (meta line says how many).
- SeekBook client: `searchBooks`, `searchableBooks`, `loadBookPages`.

## 0.9.3 – 2026-09-29

- Coverage line: the total is split when books are among the searched items ("ZotSeek durchsucht hier 3 Einträge
  (1 Buch, 2 andere Einträge)."), and the book sentence only says where books come from ("Bücher kommen über SeekBook,
  das ZotSeek einbindet.") instead of "Das Buch …".

## 0.9.2 – 2026-09-29

- Library window, source "ZotSeek": a live line says what ZotSeek searches in the scope and where its books come from
  (its own index, SeekBook through ZotSeek, or excluded), plus what it cannot see. Updated on scope change, when
  ZotSeek is ticked, when ZotSeek's prefs change (pref observers) and when the window gets the focus.
- Source "Books (own index)" (SeekBook) is now a real switch with rules (`source-rules.ts`): it needs SeekBook installed,
  enabled, reachable and with indexed books; it is locked while ZotSeek is chosen and already includes SeekBook, and
  allowed when ZotSeek indexes books itself (note: books may be found twice), excludes them, or is not chosen. A
  locked switch loses its tick. **Answers do not use SeekBook yet** (preview note); the chat part follows (M4).
- `src/core/seekbook/client.ts`: SeekBook status over `/seekbook/stats` (no search yet).
- Fix: the keyword book search found no books in the whole-library scope (`Zotero.Items.getAll` was not awaited).

## 0.9.1 – 2026-09-29

- Library sources keep the PDF **per excerpt** (`SourceExcerpt.attachmentID`, `attachmentTitle`, optional
  `pageLabel` and `chapter`) instead of one PDF per source: a book can have several PDFs (whole book, chapter PDFs),
  and page numbers only hold within one of them. Groundwork for SeekBook (M4) and useful for the keyword book mode.
- Citations `[n, S. x]` open the PDF of the excerpt on that page; the source list, the Markdown export and the note
  group pages per PDF ("Teil 1: S. 12, 15 · Teil 3: S. 204"), and each page link opens its own PDF.
- The prompt names the PDF of each excerpt only when a source has excerpts from several PDFs (unchanged otherwise),
  plus chapter and printed page where known.
- Chats saved by 0.9 and older still open their PDF (the old per-source `attachmentID` is the fallback).

## 0.7.0 – 2026-09-28

- English is the plugin's language; German is a translation (`src/i18n.ts`, keys shared, a unit test checks
  that every key and placeholder exists in both). The UI follows Zotero's language; the pref
  `extensions.zotero.seekchat.locale` ("en"/"de") forces one. Settings pane texts come from the same table.
- Prompts to the model are English (answers stay in the language of the question). The citation marker
  follows the UI: `[p. 12]` in English, `[S. 12]` in German; both are recognised. Document pages are marked
  `[Page N]`, library sources are wrapped in `<sources>`, the book no-match marker is "NO RELEVANT CONTENT".
- Numbers and dates are formatted per UI language.

## 0.6.1 – 2026-09-28

- E2E live tests: optional `E2E_LIVE_API_KEY` (bearer key for servers that need one); the live report only
  says whether a key was set. New live scenario for the books source. The long-PDF live scenario pins small
  manual limits, since with automatic limits the 40-page test book fits whole and skips the keyword search.

## 0.6.0 – 2026-09-28

- Library chat window: new source "Bücher (Stichwortsuche, ohne Index)". Every book with a PDF in the
  scope is asked separately, like in the PDF chat (size check, language, model keywords, page selection,
  answer with [S. x]). All books appear at once as a queue ("Buch 2 von 5 · noch 3 ausstehend"), "Stopp"
  cancels the rest; books without relevant passages are shown dimmed ("KEINE ANGABE" from the model).
  Works without ZotSeek; ZotSeek and books can be combined (ZotSeek answer first).
- Export and note list book answers under "Buch: …" with page links into that book.

## 0.5.5 – 2026-09-28

- Automatic answer length: cap raised from 4096 to 12288 tokens (still a tenth of the context and at most
  80 % of Ollama's num_predict). Thinking models (Qwen 3) count their `<think>` part against it.

## 0.5.4 – 2026-09-28

- "Verlauf als Notiz speichern" in both chats. PDF chat: child note of the PDF's item; library chat:
  standalone note, in the collection for a collection scope, related to the items for a selection scope.
  Citations become zotero:// links (PDF page or item); model requests are left out.
- Item context menu: "Mit dieser Datei chatten" (one item with a PDF: opens it in the reader with the
  chat section in view) and "Mit dieser Auswahl chatten" (several items: library chat window; disabled
  without ZotSeek). Zotero 8+ via Zotero.MenuManager, Zotero 7 via the DOM.
- The Markdown export's file name includes the time (`SeekChat 2026-09-28 14-05 ….md`).

## 0.5.3 – 2026-09-28

- Token limits (context window, document text per question, answer length) default to a best guess from
  the server: Ollama's num_ctx from the Modelfile, else the model's maximum context (vLLM: max_model_len),
  minus 20 %; the answer gets a tenth (max. 4096), the rest minus room for prompt and history goes to the
  text. Settings have two tabs, "Automatisch aus dem Modell" (shows the derived values, "Neu ermitteln")
  and "Manuell" (the three fields as before). If the server reports nothing, the manual values apply.

## 0.5.2 – 2026-09-28

- Markdown export includes every request sent to the model per answer (language detection, search terms,
  answer) as collapsible blocks: purpose, model, temperature, max. tokens, num_ctx, size, and all messages
  verbatim (system prompt with the document text or sources, history, question).

## 0.5.1 – 2026-09-28

- Both chats can save the whole history as Markdown: small button "⤓ Chat als .md speichern" at the
  bottom of the PDF section, "⤓ Chat als .md" in the library window's footer. Questions are quoted,
  answers kept as Markdown, with meta lines and (library chat) the numbered sources.

## 0.5.0 – 2026-09-28

Library chat complete (stage 1).

- Source list under each library answer: numbered sources with their pages, cited ones highlighted
  ("Quellen (2 von 3 zitiert)"); the title selects the item, a page opens the PDF there.
- Scope picker in the window: current selection, selected collection, every library.
- Hint per scope on what ZotSeek cannot see: PDFs without parent item, books while ZotSeek excludes them,
  abstract-only indexing mode.
- Answers (PDF and library chat) are rendered as a small, safe Markdown subset: paragraphs, headings,
  lists, bold, italic, code; citations stay clickable, also inside bold text.
- Settings: new group "Chat über die Bibliothek" with the number of ZotSeek passages per question.

## 0.4.4 – 2026-09-28

- Library chat window: ZotSeek's limits for books are shown as a short note under the source checkboxes
  (tooltips do not appear in this window).

## 0.4.3 – 2026-09-28

- Library chat window: row "Quellen" with the checkboxes "ZotSeek" (on; tooltip lists ZotSeek's limits for
  books and long documents) and "Bücher (eigener Index)" (greyed out, planned own index for whole books).
  Without a source the window takes no questions.

## 0.4.2 – 2026-09-28

- `update_url` points to the in-house portal `https://zotero.ils.local/downloads/seekchat/updates.json`.

- Library chat window, laid out like ZotSeek's search window, opened from a speech-bubble button right
  next to ZotSeek's toolbar button (shown only while ZotSeek's button exists). Scope follows the Zotero
  selection (several items, else collection, else library); source citations open the PDF page or item.
  Without a usable ZotSeek the window says why and takes no questions.

## 0.4.1 – 2026-09-28

Groundwork for the library chat; no visible change yet (the UI follows in 0.5.0).

- ZotSeek client (groundwork for the library chat, no UI yet): status check (plugin, local HTTP server,
  "AI Agent Access", index) with German hints, passage search over `/zotseek/search`. Deliberately no
  fallback; SeekChat keeps working without ZotSeek (PDF chat only).
- Library chat core (no UI yet): ZotSeek passages become numbered sources grouped by item, citations
  `[n, S. x]` with parser and link target (PDF page or item), `LibraryContextProvider` for library,
  collection (with subcollections) or selected items. Hits without text never reach the prompt; without
  usable results the user gets a hint and the model is not called. New pref `libraryTopK` (30).

## 0.4.0 – 2026-09-28

- Long documents: strategy "Nur in ausgewählten Kapiteln suchen" works. Chapters are ticked in the
  table of contents (PDF bookmarks, else headings or page blocks); if they fit into the budget they
  are sent whole without the keyword call, otherwise the keyword search runs inside them only. The
  meta line and the prompt name the chapters. The selection is kept per document for the session.
- Page search for long documents matches umlaut spellings and common endings
  (model keyword "Wärmeinsel" finds "Waermeinseln"); found by the first live E2E run.
- E2E: optional live scenarios against a real model server (`E2E_LIVE_URL`, `E2E_LIVE_MODEL`,
  `E2E_LIVE_PROVIDER`), skipped otherwise; report in `e2e/out/live-report.json`.
- E2E image trusts the in-house CAs from `e2e/certs/` (system store and Zotero's NSS profile),
  so `https://ollama.ils.local` works.

## 0.3.3 – 2026-09-27

- Updates from the ILS portal: `update_url` now points to
  `<portal>/downloads/seekchat/updates.json`. This is the first version that updates itself;
  0.3.2 and older must be replaced by hand once.
- `scripts/publish.py` copies the built xpi to the portal's downloads directory and regenerates
  `updates.json` from all published versions.

## 0.3.2 – 2026-09-27

- Strategies that are not implemented yet ("Semantische Suche", "Nur in ausgewählten Kapiteln")
  are greyed out and cannot be picked.
- Space before the "noch ohne Funktion" badge; keyword strategy description mentions the
  document language.

## 0.3.1 – 2026-09-27

- Chapter tree reads the outline (bookmarks) straight from the PDF with Zotero's bundled pdf.js,
  also without an open reader. A single root entry is unwrapped to its chapters.
- Keyword expansion only in the document language: Zotero's "Language" field, else detected by
  the model from the first pages, else a local guess.
- Heading detection also handles headings in running text.

## 0.3.0 – not released

Built for internal testing only, never committed. Its changes (outline from the PDF file) are
part of 0.3.1.

## 0.2.0 – 2026-09-27

First version: chat with a PDF in the library and the reader, streaming answers with clickable
page citations, Ollama and OpenAI-compatible servers with host allow-list, size check with the
keyword strategy for long documents, settings pane, Docker build, unit and E2E tests.
