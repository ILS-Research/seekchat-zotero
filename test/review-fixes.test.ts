import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, defaultSystemPrompt, pdfSystemPrompt } from '../src/core/prompt';
import { readLines } from '../src/core/llm/http';
import { untilAborted } from '../src/util/abort';
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

test('history: only complete exchanges, never two questions in a row or a cancelled answer', async () => {
  const { historyPairs } = await import('../src/core/turn');
  const turns: any[] = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'Fehler', error: true },
    { role: 'user', content: 'q3' }, { role: 'assistant', content: 'halb\nAbgebrochen', cancelled: true },
    { role: 'user', content: 'q4' }, { role: 'assistant', content: 'a4' },
    { role: 'user', content: 'q5' }, { role: 'assistant', content: '', pending: true },
  ];
  assert.deepEqual(historyPairs(turns, 4).map((h) => h.content), ['q1', 'a1', 'q4', 'a4']);
  assert.deepEqual(historyPairs(turns, 1).map((h) => h.content), ['q4', 'a4'], 'counted in pairs');
  assert.deepEqual(historyPairs(turns, 0), []);
});

test('API key: https required for remote hosts, loopback may stay http', async () => {
  const { assertSecureTransport } = await import('../src/core/host-guard');
  assert.throws(() => assertSecureTransport(new URL('http://ollama.ils.local'), 'k'), { code: 'HOST_REJECTED' });
  assert.doesNotThrow(() => assertSecureTransport(new URL('https://ollama.ils.local'), 'k'));
  assert.doesNotThrow(() => assertSecureTransport(new URL('http://127.0.0.1:11434'), 'k'));
  assert.doesNotThrow(() => assertSecureTransport(new URL('http://ollama.ils.local'), ''));
});

test('noteText decodes numeric and named entities once', async () => {
  const { noteText, decodeEntities } = await import('../src/core/context/notes');
  assert.equal(noteText('<p>A&#8211;B &#x2014; &ndash; &auml;&nbsp;x</p><p>&amp;lt; &#39;q&#39; &foo;</p>'), 'A–B — – ä x\n&lt; \'q\' &foo;');
  assert.equal(decodeEntities('&#xZZ; &#99999999;'), '&#xZZ; &#99999999;');
});

test('log content is redacted unless switched on', async () => {
  const { content } = await import('../src/util/log');
  assert.equal(content('geheime Frage'), '‹13 chars›');
  const z = (globalThis as any).Zotero;
  (globalThis as any).Zotero = { Prefs: { get: (k: string) => k === 'seekchat.logContent' } };
  try {
    assert.equal(content('geheime Frage'), 'geheime Frage');
    assert.equal(content('x'.repeat(10), 4), 'xxxx…');
  } finally {
    (globalThis as any).Zotero = z;
  }
});
