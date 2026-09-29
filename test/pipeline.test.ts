import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharedCalls } from '../src/util/abort';
import { carriedSources, knownSources } from '../src/core/library/pipeline';
import { setLocale } from '../src/i18n';

setLocale('de');

test('SharedCalls: one call per key; a waiter that gives up does not fail the others (skipped book)', async () => {
  const question = new AbortController();
  const shared = new SharedCalls<string[]>(question.signal);
  let starts = 0;
  let finish!: (v: string[]) => void;
  let callSignal: AbortSignal | null = null;
  const start = (signal: AbortSignal) => {
    starts++;
    callSignal = signal;
    return new Promise<string[]>((r) => { finish = r; });
  };
  const bookA = new AbortController();
  const bookB = new AbortController();
  const a = shared.get('de', start, bookA.signal);
  const b = shared.get('de', start, bookB.signal);
  assert.equal(starts, 1, 'second book reuses the call');
  assert.equal(callSignal, question.signal, 'the call runs on the question, not on the first book');
  bookA.abort();
  await assert.rejects(a, /aborted/);
  finish(['Sprint', 'Backlog']);
  assert.deepEqual(await b, ['Sprint', 'Backlog']);
  assert.equal(question.signal.aborted, false);
});

const src = (n: number, pages: number[]) => ({
  n, itemKey: `K${n}`, libraryKey: 'user', label: `Quelle ${n}`,
  excerpts: pages.map((p) => ({ text: `Text S. ${p}`, page: p })),
}) as any;

test('carried sources keep only the excerpts the answers cited', () => {
  const turns: any[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'A [1, S. 3] und [2].', sources: [src(1, [3, 4]), src(2, [7, 8, 9])] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'kaputt', error: true, sources: [src(3, [1])] },
  ];
  const carried = carriedSources(turns, 4);
  assert.deepEqual(carried.map((s) => [s.n, s.excerpts.map((e: any) => e.page)]), [[1, [3]], [2, [7, 8]]]);
  assert.deepEqual(knownSources(turns).map((s) => s.n), [1, 2], 'failed answers bring no sources');
  assert.deepEqual(carriedSources(turns, 0), []);
});
