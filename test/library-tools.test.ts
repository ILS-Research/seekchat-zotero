import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLimit, collectionPaths, countTags, cut, findCollection, inYearRange, itemLabel, mergeHits, sourceStatusText, stringArg, yearOf,
} from '../src/core/tools/library/summary';
import { toolSystemPrompt } from '../src/core/tools/session';
import { effectiveOption } from '../src/core/tools/settings';
import type { Tool } from '../src/core/tools/types';

test('labels, years, limits and cuts', () => {
  assert.equal(itemLabel(['Kuttler'], '2011', 'Klimawandel'), 'Kuttler (2011): Klimawandel');
  assert.equal(itemLabel(['A', 'B', 'C'], undefined, 'T'), 'A et al.: T');
  assert.equal(itemLabel([], undefined, ''), '?');
  assert.equal(yearOf('März 2019'), '2019');
  assert.equal(yearOf('o. J.'), undefined);
  assert.equal(clampLimit(undefined), 15);
  assert.equal(clampLimit(500), 25);
  assert.equal(clampLimit('3'), 3);
  assert.equal(cut('eins zwei drei vier', 12), 'eins zwei …');
  assert.ok(inYearRange('2015', 2010, 2020) && !inYearRange('2009', 2010) && !inYearRange(undefined, 2010) && inYearRange(undefined));
  assert.deepEqual(stringArg('a, b;c'), ['a', 'b', 'c']);
});

test('hits of several sources: joined per item, items found by more sources first, Zotero-only last', () => {
  const merged = mergeHits([
    [{ key: 'Z1', source: 'zotero' }, { key: 'B', source: 'zotero' }],
    [{ key: 'A', source: 'zotseek', excerpt: 'Hitzeinseln …', where: 'S. 3' }, { key: 'B', source: 'zotseek', excerpt: 'x' }],
    [{ key: 'C', source: 'seekbook', excerpt: 'Buch', where: 'Kap. 2, S. 40' }],
  ]);
  assert.deepEqual(merged.map((m) => m.key), ['B', 'A', 'C', 'Z1']);
  assert.deepEqual(merged[0].sources, ['zotero', 'zotseek']);
  assert.deepEqual(merged[1].excerpts, [{ source: 'zotseek', text: 'Hitzeinseln …', where: 'S. 3' }]);
  assert.equal(sourceStatusText('missing'), 'not installed');
  assert.equal(sourceStatusText({ error: 'HTTP 500' }), 'failed: HTTP 500');
});

test('collections: paths, lookup by key, path or unique name; ambiguous names fail with their paths', () => {
  const paths = collectionPaths([
    { key: 'P1', name: 'Projekt A', items: 3 },
    { key: 'S1', name: 'Stadtklima', parentKey: 'P1', items: 5 },
    { key: 'P2', name: 'Projekt B', items: 0 },
    { key: 'S2', name: 'Stadtklima', parentKey: 'P2', items: 1 },
    { key: 'H', name: 'Hitze', parentKey: 'S1', items: 2 },
  ]);
  assert.deepEqual(paths.map((p) => p.path), ['Projekt A', 'Projekt A / Stadtklima', 'Projekt A / Stadtklima / Hitze', 'Projekt B', 'Projekt B / Stadtklima']);
  assert.equal(paths[1].subcollections, 1);
  assert.equal(findCollection(paths, 'S2').path, 'Projekt B / Stadtklima');
  assert.equal(findCollection(paths, 'projekt a/stadtklima').key, 'S1');
  assert.equal(findCollection(paths, 'hitze').key, 'H');
  assert.throws(() => findCollection(paths, 'Stadtklima'), /several collections.*Projekt A \/ Stadtklima.*Projekt B \/ Stadtklima/);
  assert.throws(() => findCollection(paths, 'Nichts'), /no collection "Nichts"/);
});

test('tags counted per item, most used first, filtered', () => {
  const tags = countTags([['Methode/Umfrage', 'Hitze'], ['Hitze', 'Hitze'], ['Stadtklima']]);
  assert.deepEqual(tags[0], { tag: 'Hitze', items: 2 });
  assert.deepEqual(countTags([['Methode/Umfrage'], ['Methode/Interview'], ['Hitze']], 'methode').map((t) => t.tag), ['Methode/Interview', 'Methode/Umfrage']);
});

test('tool chat prompt names today and the library tools', () => {
  const p = toolSystemPrompt(new Date('2026-10-03T12:00:00Z'));
  assert.match(p, /Today is 2026-10-03\./);
  assert.match(p, /search_library/);
  assert.match(p, /get_selection/);
});

test('option not available (plugin missing): the first available choice applies', () => {
  const prefs = new Map<string, any>();
  (globalThis as any).Zotero = { Prefs: { get: (k: string) => prefs.get(k), set: (k: string, v: any) => prefs.set(k, v) } };
  let installed = false;
  const option = { key: 'zotseek', label: 'ZotSeek', default: 'on', choices: [{ value: 'on', label: 'on', available: () => installed }, { value: 'off', label: 'off' }] };
  const tool = { spec: { name: 'search_library' }, options: [option] } as unknown as Tool;
  assert.equal(effectiveOption(tool, option), 'off');
  installed = true;
  assert.equal(effectiveOption(tool, option), 'on');
  prefs.set('seekchat.tools.search_library.zotseek', 'off');
  assert.equal(effectiveOption(tool, option), 'off');
  delete (globalThis as any).Zotero;
});
