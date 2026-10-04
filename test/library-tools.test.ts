import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampLimit, collectionPaths, planCollectionPath, countTags, cut, findCollection, inYearRange, itemLabel, mergeHits, sourceStatusText, stringArg, yearOf,
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

test('saving into a collection path: existing part found, the rest to create', () => {
  const paths = [{ key: 'P1', path: 'Projekt A' }, { key: 'S1', path: 'Projekt A / Stadtklima' }, { key: 'X', path: 'Hitze' }];
  assert.deepEqual(planCollectionPath(paths, 'Projekt A / Stadtklima'), { existing: paths[1], create: [] });
  assert.deepEqual(planCollectionPath(paths, 'projekt a / Stadtklima / Neu / Tiefer'), { existing: paths[1], create: ['Neu', 'Tiefer'] });
  assert.deepEqual(planCollectionPath(paths, 'Stadtklima'), { existing: paths[1], create: [] }, 'unique name anywhere');
  assert.deepEqual(planCollectionPath(paths, 'Ganz neu'), { existing: undefined, create: ['Ganz neu'] });
  assert.deepEqual(planCollectionPath(paths, 'X'), { existing: paths[2], create: [] }, 'key');
  assert.throws(() => planCollectionPath(paths, ' / '), /no collection name/);
  assert.throws(() => planCollectionPath([...paths, { key: 'S2', path: 'B / Stadtklima' }], 'Stadtklima'), /several collections/);
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

test('reference links: DOI, arXiv, URL, ISBN, else a Scholar search by title', async () => {
  const { referenceLink, referenceForModel } = await import('../src/core/tools/library/document-references');
  assert.deepEqual(referenceLink({ identifiers: { DOI: '10.1000/a b' }, text: '' }), { url: 'https://doi.org/10.1000/a%20b', via: 'doi' });
  assert.equal(referenceLink({ identifiers: { arXiv: '1706.03762' }, text: '' }).url, 'https://arxiv.org/abs/1706.03762');
  assert.equal(referenceLink({ identifiers: {}, url: 'https://ils.de/x.pdf', text: '' }).via, 'url');
  assert.equal(referenceLink({ identifiers: { ISBN: '9783161484100' }, text: '' }).via, 'isbn');
  const s = referenceLink({ identifiers: {}, title: 'Hitze in der Stadt', text: 'Umweltbundesamt (2019): Hitze in der Stadt.' });
  assert.equal(s.url, 'https://scholar.google.com/scholar?q=Hitze%20in%20der%20Stadt');
  const m = referenceForModel({ number: 3, text: 'x'.repeat(400), authors: [], identifiers: { DOI: '10.1/x' }, url: 'https://doi.org/10.1/x', year: '2019' });
  assert.equal(m.n, 3);
  assert.ok(String(m.text).length < 270 && m.doi === '10.1/x' && !('url' in m));
});

test('item changes: arguments read into changes, bad ones refused with a reason the model can read', async () => {
  const { parseChanges, matchName, tagDelta, dash, MAX_UPDATE_ITEMS } = await import('../src/core/tools/library/edit-plan');
  const [c] = parseChanges({ changes: [{ key: 'AAAA', item_type: 'book', fields: { publisher: ' Springer ', volume: null, year: 5 }, add_tags: 'x, y' }] });
  assert.deepEqual(c, { key: 'AAAA', itemType: 'book', fields: { publisher: 'Springer', volume: '', year: '5' }, addTags: ['x', 'y'], removeTags: [] });
  assert.equal(parseChanges({ key: 'B', item_type: 'report' })[0].key, 'B');
  assert.throws(() => parseChanges({}), /no changes given/);
  assert.throws(() => parseChanges({ changes: [{ item_type: 'book' }] }), /no "key"/);
  assert.throws(() => parseChanges({ changes: [{ key: 'A' }] }), /changes nothing/);
  assert.throws(() => parseChanges({ changes: [{ key: 'A', item_type: 'book' }, { key: 'A', item_type: 'report' }] }), /twice/);
  assert.throws(() => parseChanges({ changes: Array.from({ length: MAX_UPDATE_ITEMS + 1 }, (_x, i) => ({ key: `K${i}`, item_type: 'book' })) }), /at most 50/);
  assert.equal(matchName('Journal Article', ['book', 'journalArticle']), 'journalArticle');
  assert.equal(matchName('book_section', ['bookSection']), 'bookSection');
  assert.equal(matchName('nope', ['book']), undefined);
  assert.deepEqual(tagDelta(['a', 'b'], ['b', 'c', 'c'], ['a', 'z']), { add: ['c'], remove: ['a'] });
  assert.equal(dash(' '), '–');
  const { fieldAlias } = await import('../src/core/tools/library/edit-plan');
  assert.equal(fieldAlias('Year'), 'date');
  assert.equal(fieldAlias('degree'), 'thesisType');
  assert.equal(fieldAlias('Journal'), 'publicationTitle');
  assert.equal(fieldAlias('publisher'), 'publisher');
});

test('read_document: the window of pages is cut by page count and characters, and says where to go on', async () => {
  const { pageWindow, READ_MAX_PAGES } = await import('../src/core/tools/library/read-document');
  const lens = Array.from({ length: 100 }, () => 1000);
  assert.deepEqual(pageWindow(100, undefined, undefined, lens), { from: 1, to: 3, next: 4 });
  assert.deepEqual(pageWindow(100, 10, 12, lens), { from: 10, to: 12, next: 13 });
  assert.equal(pageWindow(100, 1, 80, lens.map(() => 2000)).to, 6, 'cut by characters (12000)');
  assert.equal(pageWindow(100, 1, 80, lens.map(() => 100)).to, READ_MAX_PAGES, 'cut by page count');
  assert.deepEqual(pageWindow(5, 4, 99, lens), { from: 4, to: 5 });
  assert.deepEqual(pageWindow(5, 99, undefined, lens), { from: 5, to: 5 });
  assert.deepEqual(pageWindow(100, 1, 2, [20000, 20000]), { from: 1, to: 1, next: 2 }, 'a huge page is still read alone');
});

test('note text: Markdown to note HTML with an escaped title', async () => {
  const { noteHtml } = await import('../src/core/tools/library/create-note');
  assert.equal(noteHtml('A & B', '- eins\n- **zwei**'), '<h1>A &amp; B</h1>\n<ul><li>eins</li><li><strong>zwei</strong></li></ul>');
  assert.equal(noteHtml('', 'Text <b>'), '<p>Text &lt;b&gt;</p>');
});

test('subagent: packages, read-only tools, old tool results shortened to fit, package results joined', async () => {
  const { chunk, joinResults, shortenOldToolResults, SUBAGENT_TOOLS } = await import('../src/core/tools/agent/plan');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 20), []);
  for (const writer of ['update_item', 'create_note', 'save_to_collection', 'import_references', 'delegate_task', 'show_references']) {
    assert.ok(!SUBAGENT_TOOLS.includes(writer), `${writer} offered to the subagent`);
  }
  const big = 'x'.repeat(5000);
  const msgs: any[] = [
    { role: 'system', content: 'sys' }, { role: 'user', content: 'task' },
    { role: 'tool', content: big }, { role: 'tool', content: big }, { role: 'tool', content: big }, { role: 'tool', content: big },
  ];
  shortenOldToolResults(msgs, 12000);
  assert.ok(msgs[2].content.length < 500 && /shortened/.test(msgs[2].content), 'oldest result not shortened');
  assert.equal(msgs[5].content.length, 5000, 'last results kept');
  assert.equal(msgs[1].content, 'task');
  const small: any[] = [{ role: 'tool', content: big }];
  shortenOldToolResults(small, 100000);
  assert.equal(small[0].content.length, 5000, 'shortened although it fits');
  assert.deepEqual(joinResults([{ label: 'P1', text: '```json\n[{"key":"A"}]\n```' }, { label: 'P2', text: '[{"key":"B"}]' }]), [{ key: 'A' }, { key: 'B' }]);
  assert.deepEqual(joinResults([{ label: 'P1', text: '{"ok":true}' }]), { ok: true });
  assert.equal(joinResults([{ label: 'P1', text: 'eins' }, { label: 'P2', text: '[1]' }]), '## P1\neins\n\n## P2\n[1]');
  // Words around the JSON, as real models write it.
  assert.deepEqual(joinResults([
    { label: 'P1', text: 'Hier ist mein Ergebnis:\n\n```json\n[{"key":"A"}]\n```\n\nAlle geprüft.' },
    { label: 'P2', text: 'Ergebnis: [{"key":"B"}] – fertig.' },
  ]), [{ key: 'A' }, { key: 'B' }]);
  const { extractJson } = await import('../src/core/tools/agent/plan');
  assert.equal(extractJson('kein JSON hier'), undefined);
});
