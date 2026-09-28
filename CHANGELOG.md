# Changelog

## Unreleased

- ZotSeek client (groundwork for the library chat, no UI yet): status check (plugin, local HTTP server,
  "AI Agent Access", index) with German hints, passage search over `/zotseek/search`. Deliberately no
  fallback; SeekChat keeps working without ZotSeek (PDF chat only).

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
