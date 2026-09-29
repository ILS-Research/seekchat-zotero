import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seekBookChoice } from '../src/core/library/source-rules';
import { parseStatus } from '../src/core/seekbook/client';
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
