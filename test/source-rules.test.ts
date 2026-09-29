import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekBookChoice } from '../src/core/library/source-rules';
import { parseBookSearch, parseStatus } from '../src/core/seekbook/client';
import { splitBooks } from '../src/core/library/books';
import { fromSeekBook, sourceId, withoutBooks, type Evidence } from '../src/core/library/sources';
import { setLocale } from '../src/i18n';

setLocale('de');
const ready = { available: true as const, indexedBooks: 42, queued: 0 };
const base = { seekbook: ready, useZotSeek: true, zotseekAvailable: true };

test('SeekBook switch: needs a ready SeekBook', () => {
  assert.deepEqual(seekBookChoice({ ...base, seekbook: null, zotseekBooks: 'excluded' }), { enabled: false, reason: 'seekbook' });
  const missing = { available: false as const, reason: 'not-installed' as const, message: 'x' };
  assert.equal(seekBookChoice({ ...base, seekbook: missing, zotseekBooks: 'excluded' }).enabled, false);
});

test('SeekBook switch: locked while ZotSeek already takes its books from SeekBook', () => {
  assert.deepEqual(seekBookChoice({ ...base, zotseekBooks: 'seekbook' }), { enabled: false, reason: 'viaZotSeek' });
  // ZotSeek unticked or unavailable: SeekBook can be asked directly.
  assert.deepEqual(seekBookChoice({ ...base, useZotSeek: false, zotseekBooks: 'seekbook' }), { enabled: true, reason: '' });
  assert.deepEqual(seekBookChoice({ ...base, zotseekAvailable: false, zotseekBooks: 'seekbook' }), { enabled: true, reason: '' });
});

test('SeekBook switch: allowed with native or excluded books in ZotSeek (native with a note)', () => {
  assert.deepEqual(seekBookChoice({ ...base, zotseekBooks: 'native' }), { enabled: true, reason: 'nativeToo' });
  assert.deepEqual(seekBookChoice({ ...base, zotseekBooks: 'excluded' }), { enabled: true, reason: '' });
});

test('SeekBook status from /seekbook/stats', () => {
  assert.deepEqual(parseStatus({ apiVersion: 1, indexedBooks: 3, queuedDocuments: 2 }), { available: true, indexedBooks: 3, queued: 2 });
  const empty = parseStatus({ apiVersion: 1, indexedBooks: 0 });
  assert.ok(!empty.available && empty.reason === 'no-index' && /keine Bücher/.test(empty.message));
  const other = parseStatus({ apiVersion: 2 });
  assert.ok(!other.available && other.reason === 'error');
});

test('SeekBook search result: ZotSeek shape plus chapter, printed page and PDF', () => {
  const [p] = parseBookSearch({ results: [{
    itemKey: 'B1', libraryKey: 'user', title: 'Stadtklima', authors: ['Muster, Anna'], year: 2020, score: 0.03,
    semanticScore: 0.8, keywordScore: null,
    matchedChunk: { snippet: '48 Messstationen', page: 10, pageEnd: 11, pageLabel: '8', chapter: 'Kapitel 2', attachmentKey: 'A1', attachmentTitle: 'Teil 1', textSource: 'book', chunkIndex: 4 },
  }] });
  assert.equal(p.text, '48 Messstationen');
  assert.deepEqual([p.page, p.pageEnd, p.pageLabel, p.chapter, p.attachmentKey, p.attachmentTitle, p.chunkIndex], [10, 11, '8', 'Kapitel 2', 'A1', 'Teil 1', 4]);
  const e = fromSeekBook(p, 77);
  assert.deepEqual([e.origin, e.attachmentID, e.pageLabel, e.chapter, e.label], ['book', 77, '8', 'Kapitel 2', 'Muster 2020 – Stadtklima']);
});

test('books split: indexed ones to SeekBook, the rest to the keyword reading', () => {
  const b = (k: string) => ({ attachment: { id: 1 }, label: k, itemKey: k });
  const books = [b('A'), b('B'), b('C')];
  const split = splitBooks(books, new Set(['B']));
  assert.deepEqual([split.indexed.map((x) => x.label), split.keyword.map((x) => x.label)], [['B'], ['A', 'C']]);
  assert.deepEqual(splitBooks(books, null).keyword.length, 3);
});

test('ZotSeek passages of books SeekBook covers are left out', () => {
  const ev = (itemKey: string): Evidence => ({ itemKey, libraryKey: 'user', label: itemKey, origin: 'zotseek', text: 'x' });
  const kept = withoutBooks([ev('A'), ev('B'), ev('A')], new Set([sourceId({ libraryKey: 'user', itemKey: 'A' })]));
  assert.deepEqual(kept.map((e) => e.itemKey), ['B']);
});
