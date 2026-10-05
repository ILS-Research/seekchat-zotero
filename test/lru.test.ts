import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruMap } from '../src/util/lru';

test('LruMap drops the least recently used, keeps protected entries', () => {
  const m = new LruMap<string, { busy: boolean }>(2, (v) => v.busy);
  m.set('a', { busy: true });
  m.set('b', { busy: false });
  m.set('c', { busy: false });
  assert.deepEqual([...m.values()].length, 2);
  assert.ok(m.get('a'), 'busy entry kept');
  assert.equal(m.get('b'), undefined, 'oldest idle entry dropped');
  m.get('c');
  m.set('d', { busy: false });
  m.set('e', { busy: false });
  assert.equal(m.get('c'), undefined);
  assert.ok(m.get('e') && m.get('a'));
});

test('only the 75 most recent sessions keep their model requests; running ones keep theirs', async () => {
  const { dropOldRequests, KEEP_REQUESTS_SESSIONS } = await import('../src/core/session');
  const req = { purpose: 'Antwort', model: 'm', temperature: 0, maxTokens: 1, messages: [] };
  const sessions = Array.from({ length: 80 }, (_x, i) => ({
    busy: i === 1,
    turns: [{ role: 'user' as const, content: 'q' }, { role: 'assistant' as const, content: `a${i}`, requests: [req] }],
  }));
  dropOldRequests(sessions);
  assert.equal(KEEP_REQUESTS_SESSIONS, 75);
  const kept = sessions.map((s) => !!s.turns[1].requests);
  assert.deepEqual(kept.slice(0, 5), [false, true, false, false, false]);
  assert.ok(kept.slice(5).every(Boolean));
  assert.ok(sessions.every((s) => s.turns[1].content.startsWith('a')));
});
