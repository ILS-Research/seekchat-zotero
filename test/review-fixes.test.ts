import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, defaultSystemPrompt, pdfSystemPrompt } from '../src/core/prompt';
import { readLines } from '../src/core/llm/http';
import { untilAborted } from '../src/core/session';
import { setLocale } from '../src/i18n';

setLocale('de');

test('custom system prompt keeps the page citation rule', () => {
  assert.equal(pdfSystemPrompt(''), defaultSystemPrompt());
  const p = pdfSystemPrompt('  Antworte wie ein Pirat.  ');
  assert.ok(p.startsWith('Antworte wie ein Pirat.'));
  assert.match(p, /format \[S\. 12\]/);
  const msgs = buildMessages({
    systemPrompt: 'Kurz.', history: [], question: 'q',
    context: { title: 'D', body: '[Page 1]\nx', mode: 'full', includedPages: [1], totalPages: 1 } as any,
  });
  assert.match(msgs[0].content, /^Kurz\.\n\n.*\[S\. 12\]/);
});

test('untilAborted: resolves with the promise, rejects when the signal aborts first', async () => {
  assert.equal(await untilAborted(Promise.resolve(3), new AbortController().signal), 3);
  const ctrl = new AbortController();
  let settle!: (v: number) => void;
  const shared = new Promise<number>((r) => { settle = r; });
  const waiting = untilAborted(shared, ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, /aborted/);
  // The shared promise itself is untouched: another waiter still gets the value.
  settle(7);
  assert.equal(await untilAborted(shared, new AbortController().signal), 7);
});

test('readLines cancels the body when the reader stops early', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('a\nb\nc\n')); },
    cancel() { cancelled = true; },
  });
  const seen: string[] = [];
  await readLines({ body } as unknown as Response, (l) => { seen.push(l); if (l === 'b') return false; });
  assert.deepEqual(seen, ['a', 'b']);
  assert.ok(cancelled, 'body cancelled');
});
