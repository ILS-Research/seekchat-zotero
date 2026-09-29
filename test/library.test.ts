import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSourceCitations } from '../src/core/citations';
import { buildSources, formatSources, sourceLabel, withoutKnownSentences, type Evidence } from '../src/core/library/sources';
import { buildMessages, describeContext, defaultLibraryPrompt } from '../src/core/prompt';
import type { ZotSeekPassage } from '../src/core/zotseek/client';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

const p = (itemKey: string, page: number | undefined, text: string | undefined, extra: Partial<ZotSeekPassage> = {}): ZotSeekPassage => ({
  itemKey, libraryKey: 'user', title: `Titel ${itemKey}`, authors: ['Muster, Erika'], year: 2021,
  score: 0.1, semanticScore: 0.7, keywordScore: null, text, page, ...extra,
});

test('source label: last names, "u. a." after three, year, title', () => {
  assert.equal(sourceLabel({ authors: ['Muster, Erika', 'Beispiel'], year: 2021, title: 'Hitze' }), 'Muster, Beispiel 2021 – Hitze');
  assert.equal(sourceLabel({ authors: ['A', 'B', 'C', 'D'], year: undefined, title: 'T' }), 'A, B, C u. a. – T');
  assert.equal(sourceLabel({ authors: [], title: '' }), 'Ohne Titel');
});

test('sources: grouped by item in rank order, duplicates and textless hits left out', () => {
  const set = buildSources([
    p('A', 5, 'Zweiter Abschnitt aus A'),
    p('B', 2, 'Abschnitt aus B'),
    p('A', 5, 'Zweiter  Abschnitt aus A'),
    p('C', undefined, undefined),
    p('A', 1, 'Erster Abschnitt aus A'),
    p('B', 3, 'Abschnitt aus B, länger und mit mehr Text'),
  ], 10_000);
  assert.deepEqual(set.sources.map((s) => [s.n, s.itemKey]), [[1, 'A'], [2, 'B']]);
  assert.deepEqual(set.sources[0].excerpts.map((e) => e.page), [1, 5], 'excerpts in page order');
  assert.equal(set.withoutText, 1);
  assert.equal(set.passagesUsed, 4);
  // B's first excerpt is contained in the longer one and was replaced.
  assert.deepEqual(set.sources[1].excerpts.map((e) => e.text), ['Abschnitt aus B, länger und mit mehr Text']);
});

test('sources: same item key in two libraries are two sources', () => {
  const set = buildSources([p('A', 1, 'x'), p('A', 1, 'y', { libraryKey: 'group:7' })], 10_000);
  assert.equal(set.sources.length, 2);
});

test('sources: budget is respected, later passages are counted as over budget', () => {
  const long = 'x'.repeat(400);
  const set = buildSources([p('A', 1, long), p('B', 1, long + 'b'), p('C', 1, 'kurz')], 500);
  assert.deepEqual(set.sources.map((s) => s.itemKey), ['A', 'C']);
  assert.equal(set.overBudget, 1);
  assert.ok(set.chars <= 500);
});

test('sources are formatted with number, label and page or note marker', () => {
  const set = buildSources([p('A', 12, 'Text A'), p('B', undefined, 'Notiztext', { textSource: 'note', noteKey: 'N1' })], 10_000);
  assert.equal(formatSources(set.sources),
    '[1] Muster 2021 – Titel A\n(S. 12)\nText A\n\n---\n\n[2] Muster 2021 – Titel B\n(note)\nNotiztext');
});

test('source citations: single, with page, ranges and lists; unknown numbers stay text', () => {
  const segs = splitSourceCitations('A [1, S. 12]. B [2]. C [1, S. 3–4; 2, S. 7]. Im Jahr [2021] und [3].', 2);
  const cites = segs.filter((s) => s.type === 'source') as any[];
  assert.deepEqual(cites.map((c) => [c.n, c.page]), [[1, 12], [2, undefined], [1, 3], [2, 7]]);
  assert.equal(segs.map((s) => s.text).join(''), 'A [1, S. 12]. B [2]. C [1, S. 3–4] [2, S. 7]. Im Jahr [2021] und [3].');
  assert.equal(splitSourceCitations('[S. 4]', 2).length, 1, 'PDF citations are not source citations');
});

test('library context: meta line and prompt name scope and sources', () => {
  const set = buildSources([p('A', 12, 'Text A')], 10_000);
  const ctx = {
    title: 'Bibliothek „Meine Bibliothek“', body: formatSources(set.sources), mode: 'excerpt' as const, includedPages: [], totalPages: 0,
    library: { sources: set.sources, scope: 'Bibliothek „Meine Bibliothek“', passagesUsed: 1, withoutText: 2, overBudget: 0 },
  };
  assert.equal(describeContext(ctx), 'Bibliothek „Meine Bibliothek“: 1 Quelle, 1 Abschnitt (ZotSeek); 2 Treffer ohne Textauszug nicht verwendet');
  const system = buildMessages({ context: ctx, history: [], question: 'q' })[0].content;
  assert.ok(system.startsWith(defaultLibraryPrompt()));
  assert.match(system, /<sources>\n\[1\] Muster 2021 – Titel A\n\(S\. 12\)\nText A\n<\/sources>/);
  assert.match(system, /format \[2, S\. 12\]/, 'German UI: model is asked for [n, S. x]');
});

test('book answers: the no-match marker is recognised with quotes or a period', async () => {
  const { isNoMatch } = await import('../src/core/prompt');
  for (const a of ['KEINE ANGABE', '„KEINE ANGABE“', 'Keine Angabe.', ' **KEINE ANGABE** ']) assert.ok(isNoMatch(a), a);
  assert.ok(!isNoMatch('Keine Angabe zu Hitze, aber zu Regen [S. 3].'));
});

test('overlapping excerpts of one source: known sentences cut, mostly known excerpts dropped', () => {
  const s1 = 'Create issues by clicking Create at the top of the screen.';
  const s2 = 'Fill in the fields using the data shown below in the dialog.';
  const s3 = 'Only the fields marked with an asterisk are mandatory ones.';
  const s4 = 'Ranking lets you order the backlog by dragging issues around, the most important ones go to the top.';
  const ev = (page: number, text: string): Evidence => ({ itemKey: 'B', libraryKey: 'user', label: 'Buch', origin: 'book', page, text });
  const set = buildSources([ev(6, `${s1} ${s2} ${s3}`), ev(8, `${s2} ${s3} ${s4}`), ev(9, `${s1} ${s2}`)], 100000);
  const ex = set.sources[0].excerpts;
  assert.equal(ex.length, 2, JSON.stringify(ex));
  assert.equal(ex[1].text, s4, 'only the new sentence of p. 8 is kept');
  assert.equal(withoutKnownSentences(`${s1} ${s4}`, new Set()), `${s1} ${s4}`);
});
