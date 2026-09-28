# Changelog

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
