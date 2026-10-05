import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineBuffer, parseSseLine, stripThinking } from '../src/core/llm/stream-parsers';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

test('LineBuffer keeps partial lines across chunks', () => {
  const b = new LineBuffer();
  assert.deepEqual(b.push('data: {"a"'), []);
  assert.deepEqual(b.push(':1}\r\ndata: x\npart'), ['data: {"a":1}', 'data: x']);
  assert.deepEqual(b.flush(), ['part']);
  assert.deepEqual(b.flush(), []);
});

test('SSE lines yield deltas, done and errors', () => {
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{"content":"Hi"}}]}'), { delta: 'Hi', done: undefined });
  assert.deepEqual(parseSseLine('data: [DONE]'), { done: true });
  assert.equal(parseSseLine(': keep-alive'), null);
  assert.equal(parseSseLine('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}')?.done, true);
  assert.equal(parseSseLine('data: {"error":{"message":"boom"}}')?.error, 'boom');
});

test('thinking blocks are hidden, also while still open', () => {
  assert.equal(stripThinking('<think>hmm</think>\n\nAntwort'), 'Antwort');
  assert.equal(stripThinking('<think>noch am Denken'), '');
  assert.equal(stripThinking('Antwort ohne Denken'), 'Antwort ohne Denken');
});
