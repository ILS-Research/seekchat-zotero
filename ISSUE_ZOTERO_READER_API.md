# Public API for open readers and the current page of a reader

## Summary

Plugins that work with the PDF the user is reading need two things that are only reachable through private members
today:

1. finding the open reader(s) of an attachment, and
2. the page the user is looking at right now.

We ask for a small public API for both.

## Use case

SeekChat (a plugin that lets users chat with a PDF through a self-hosted LLM) always sends the page that is open in
the reader, plus its neighbours, as context. This lets users ask "what does this page say about X?". To do that, the
plugin has to know whether an attachment is open in a reader, and which page is visible.

## What we use today (private)

```js
// all reader instances, to find the one showing a given attachment
Zotero.Reader._readers
// live page index of that reader
reader._internalReader._state.primaryViewStats.pageIndex
```

The only public fallback is `item.getAttachmentLastPageIndex()`. It is written with a delay (on scroll or when the
tab closes), so it often lags behind the page the user actually sees. `Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)`
covers only the selected tab.

## Why this matters

- The private paths change with reader refactors (the view state has moved before), and plugins break without
  warning.
- Every plugin wraps these paths in try/catch and silently falls back to stale data.
- A small public surface would let the reader internals change freely.

## Possible API

Each of these would be enough on its own:

1. **List readers.** `Zotero.Reader.getReaders()`, which returns the open `ReaderInstance`s. Alternatively
   `Zotero.Reader.getByItemID(itemID)`, which returns the instances showing that attachment.
2. **Current page.** A read-only getter on `ReaderInstance`, for example:
   ```js
   reader.getCurrentPageIndex()   // 0-based, null if not known yet
   ```
   It could return the value the reader already keeps in `primaryViewStats.pageIndex` (PDF). EPUB and snapshot
   readers could return `null`, or a location object, until a page concept exists.
3. **Optional: change notification.** An event when the visible page changes, so plugins do not have to poll, for
   example `Zotero.Reader.registerEventListener('pageChange', …)` next to the existing reader event listeners.

## Implementation hints

- `ReaderInstance` already receives view state changes from the internal reader; those updates are the source for
  `lastPageIndex`. The getter can return the last value received, without calling into the internal reader.
- `getReaders()` / `getByItemID()` would be thin wrappers around `_readers`, returning a copy.
- None of this changes behaviour for existing code. It only exposes values Zotero already tracks.

We are happy to test a draft or provide a PR if the maintainers agree on the shape.
