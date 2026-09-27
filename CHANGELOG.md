# Changelog

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
