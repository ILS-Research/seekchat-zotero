import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCitations } from '../src/core/citations';
import { buildMessages, compressRanges, DEFAULT_SYSTEM_PROMPT } from '../src/core/prompt';

test('page citations become cite segments', () => {
  const segs = splitCitations('A [S. 3], B [S. 4–5] und C [Seite 7] sowie [p. 9] und [pp. 2, 6].');
  assert.deepEqual(segs.filter((s) => s.type === 'cite').map((s: any) => s.page), [3, 4, 7, 9, 2]);
  assert.equal(segs.map((s) => s.text).join(''), 'A [S. 3], B [S. 4–5] und C [Seite 7] sowie [p. 9] und [pp. 2, 6].');
});

test('text without citations stays one segment', () => {
  assert.deepEqual(splitCitations('Nur Text [1] hier'), [{ type: 'text', text: 'Nur Text [1] hier' }]);
});

test('page ranges are compressed', () => {
  assert.equal(compressRanges([8, 1, 2, 3, 5, 7, 3]), '1–3, 5, 7–8');
});

test('messages: system with document, history, then question', () => {
  const msgs = buildMessages({
    context: { title: 'Müller 2021 – Test', body: '[Seite 1]\nInhalt', mode: 'full', includedPages: [1], totalPages: 1 },
    history: [{ role: 'user', content: 'Frage 1' }, { role: 'assistant', content: 'Antwort 1 [S. 1]' }],
    question: 'Frage 2',
  });
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.ok(msgs[0].content.startsWith(DEFAULT_SYSTEM_PROMPT));
  assert.ok(msgs[0].content.includes('Müller 2021 – Test'));
  assert.ok(msgs[0].content.includes('[Seite 1]\nInhalt'));
  assert.equal(msgs[3].content, 'Frage 2');
});
