import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, diagnose, parseSearchResponse, parseStats } from '../src/core/zotseek/client';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

const env = { pluginLoaded: true, serverPort: 23119, searchEndpointRegistered: true };

test('diagnose: missing plugin, server or endpoint are reported in that order', () => {
  assert.equal(diagnose({ ...env, pluginLoaded: false, serverPort: 0 }), 'not-installed');
  assert.equal(diagnose({ ...env, serverPort: 0, searchEndpointRegistered: false }), 'server-off');
  assert.equal(diagnose({ ...env, searchEndpointRegistered: false }), 'endpoint-off');
  assert.equal(diagnose(env), null);
});

test('search URL asks for passages on the local server', () => {
  const url = new URL(buildSearchUrl(23119, 'Hitze & Stadt', { topK: 20, libraryKey: 'group:7', mode: 'hybrid', minSimilarity: 0.25 }));
  assert.equal(url.origin + url.pathname, 'http://127.0.0.1:23119/zotseek/search');
  assert.equal(url.searchParams.get('q'), 'Hitze & Stadt');
  assert.equal(url.searchParams.get('granularity'), 'passages');
  assert.equal(url.searchParams.get('topK'), '20');
  assert.equal(url.searchParams.get('libraryKey'), 'group:7');
  assert.equal(url.searchParams.get('minSimilarity'), '0.25');
  assert.equal(new URL(buildSearchUrl(1, 'x')).searchParams.has('libraryKey'), false);
});

test('search response: passages flattened, text only when present, bad entries dropped', () => {
  const passages = parseSearchResponse({
    results: [
      {
        itemKey: 'ABCD1234', libraryKey: 'user', title: 'Hitze', authors: ['Muster', 'Beispiel'], year: 2021,
        score: 0.031, semanticScore: 0.8, keywordScore: null, source: 'both',
        matchedChunk: { snippet: 'Waermeinseln …', page: 27, textSource: 'pdf' },
      },
      { itemKey: 'EFGH5678', libraryKey: null, title: 'Nur Stichwort', authors: 'Muster, E.', score: 0.01, matchedChunk: null },
      { itemKey: 'NOTE0001', libraryKey: 'group:3', title: 'Notiz', matchedChunk: { snippet: 'Text', textSource: 'note', noteKey: 'N1' } },
      { title: 'ohne Key' },
    ],
  });
  assert.equal(passages.length, 3);
  assert.deepEqual(passages[0], {
    itemKey: 'ABCD1234', libraryKey: 'user', title: 'Hitze', authors: ['Muster', 'Beispiel'], year: 2021,
    score: 0.031, semanticScore: 0.8, keywordScore: null, text: 'Waermeinseln …', page: 27, textSource: 'pdf', noteKey: undefined,
  });
  assert.equal(passages[1].text, undefined);
  assert.deepEqual(passages[1].authors, ['Muster, E.']);
  assert.equal(passages[1].libraryKey, null);
  assert.equal(passages[2].page, undefined);
  assert.equal(passages[2].noteKey, 'N1');
  assert.throws(() => parseSearchResponse({ error: 'x' }), /no "results"/);
});

test('stats: ready only when ZotSeek says so', () => {
  assert.deepEqual(parseStats({ ready: true, indexedPapers: 12, totalChunks: 340 }), { ready: true, indexedPapers: 12, totalChunks: 340 });
  assert.equal(parseStats({ indexedPapers: 0 }).ready, false);
  assert.equal(parseStats(null).ready, false);
});
