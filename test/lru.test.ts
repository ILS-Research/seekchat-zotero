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
