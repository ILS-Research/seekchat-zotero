import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSources, formatSources, interleave, type Evidence } from '../src/core/library/sources';
import { buildPlanMessages, parsePlan } from '../src/core/library/plan';
import { buildExcerptMessages, parseExcerpts } from '../src/core/library/book-excerpts';
import { citedSourceNumbers, splitSourceCitations } from '../src/core/citations';
import { buildMessages, describeContext } from '../src/core/prompt';
import { setLocale } from '../src/i18n';
import { bookDetails } from '../src/ui/turn-view';

setLocale('de');

const ev = (itemKey: string, page: number | undefined, text: string, origin: Evidence['origin'] = 'zotseek'): Evidence => ({
  itemKey, libraryKey: 'user', label: `Label ${itemKey}`, origin, text, page, ...(origin === 'book' ? { attachmentID: 99 } : {}),
});

test('interleave takes rank 1 of each list, then rank 2, …', () => {
  assert.deepEqual(interleave<number | string>([1, 2, 3], ['a'], [], ['x', 'y']), [1, 'a', 'x', 2, 'y', 3]);
});

test('merged sources: ZotSeek and book evidence in one numbered list, books marked', () => {
  const set = buildSources(interleave<Evidence>([ev('A', 3, 'Aus ZotSeek')], [ev('B', 12, 'Aus dem Buch', 'book')]), 10_000);
  assert.deepEqual(set.sources.map((s) => [s.n, s.itemKey, s.origin]), [[1, 'A', 'zotseek'], [2, 'B', 'book']]);
  assert.equal(set.sources[1].attachmentID, 99);
  assert.match(formatSources(set.sources), /\[2\] Label B \(book\)\n\(S\. 12\)\nAus dem Buch/);
});

test('follow-ups: numbers stay stable, cited sources are carried first', () => {
  const numbers = new Map<string, number>();
  const first = buildSources([ev('A', 1, 'Text A'), ev('B', 2, 'Text B')], 10_000, { numbers });
  assert.deepEqual(first.sources.map((s) => s.n), [1, 2]);
  // Second question: only B was cited; new evidence for C and A.
  const second = buildSources([ev('C', 5, 'Text C'), ev('A', 7, 'Mehr zu A')], 10_000, { numbers, carried: [first.sources[1]] });
  assert.deepEqual(second.sources.map((s) => [s.n, s.itemKey]), [[1, 'A'], [2, 'B'], [3, 'C']]);
  assert.equal(second.carried, 1);
  assert.deepEqual(second.sources[1].excerpts.map((e) => e.text), ['Text B']);
  // A keeps number 1 although it was not carried.
  assert.deepEqual(second.sources[0].excerpts.map((e) => e.page), [7]);
});

test('carried sources take at most half of the budget', () => {
  const numbers = new Map<string, number>();
  const long = 'x'.repeat(300);
  const first = buildSources([ev('A', 1, long), ev('A', 2, long + 'y')], 10_000, { numbers });
  const next = buildSources([ev('B', 1, 'neu')], 800, { numbers, carried: first.sources });
  assert.equal(next.sources[0].excerpts.length, 1, 'only one carried excerpt fits into half the budget');
  assert.ok(next.sources.some((s) => s.itemKey === 'B'));
});

test('citations with stable numbers: only numbers of the answer\'s sources count', () => {
  const known = new Set([2, 5]);
  const segs = splitSourceCitations('A [2, S. 3]. B [5]. C [1]. [3]', (n) => known.has(n));
  assert.deepEqual(segs.filter((s) => s.type === 'source').map((s: any) => s.n), [2, 5]);
  assert.deepEqual([...citedSourceNumbers('[5] und [5, S. 2]', (n) => known.has(n))], [5]);
});

test('meta line names the origins of the sources', () => {
  const set = buildSources([ev('A', 1, 'x'), ev('B', 2, 'y', 'book')], 10_000);
  const library = { sources: set.sources, scope: 'Bibliothek „X“', passagesUsed: 2, withoutText: 0, overBudget: 0, origins: { zotseek: 1, books: 1 }, carried: 0 };
  const ctx = { title: 'X', body: formatSources(set.sources), mode: 'excerpt' as const, includedPages: [], totalPages: 0, library };
  assert.equal(describeContext(ctx), 'Bibliothek „X“: 2 Quellen, 2 Abschnitte (ZotSeek 1, Bücher 1)');
  const system = buildMessages({ context: ctx, history: [], question: 'q' })[0].content;
  assert.match(system, /pre-read from books/);
  assert.equal(describeContext({ ...ctx, library: { ...library, origins: { zotseek: 0, books: 2 } } }), 'Bibliothek „X“: 2 Quellen, 2 Abschnitte (Bücher 2)');
});

test('plan: JSON is read, missing parts fall back to the question', () => {
  const reply = '<think>hm</think>```json\n{"question": "Was sagt Muster zu Hitze in Städten?", "queries": ["Hitze Stadt", "Hitze Stadt", "urban heat"]}\n```';
  const plan = parsePlan(reply, 'und zu Hitze?');
  assert.equal(plan.question, 'Was sagt Muster zu Hitze in Städten?');
  assert.deepEqual(plan.queries, ['Hitze Stadt', 'urban heat']);
  assert.ok(plan.fromModel);
  assert.deepEqual(parsePlan('{"question": ""}', 'q'), { question: 'q', queries: ['q'], fromModel: true });
  assert.deepEqual(parsePlan('keine Ahnung', 'q'), { question: 'q', queries: ['q'], fromModel: false });
});

test('plan prompt carries the conversation, answers shortened, no search terms for books', () => {
  const msgs = buildPlanMessages({ question: 'Und als Tabelle?', history: [{ role: 'user', content: 'Was zu Hitze?' }, { role: 'assistant', content: 'a'.repeat(1000) }], scope: 'S' });
  assert.match(msgs[1].content, /User: Was zu Hitze\?/);
  assert.match(msgs[1].content, /a{600} \[…\]/);
  assert.doesNotMatch(msgs[0].content, /keywords/);
});

test('book details: language with source, own search terms or a hint, all pages sent', () => {
  assert.deepEqual(bookDetails({ label: 'B', attachmentID: 1, state: 'found', language: 'Englisch', languageSource: 'metadata', keywords: ['bug report', 'issue'], pages: [1, 2, 3, 7, 304], totalPages: 304 }), [
    'Dokumentsprache: Englisch (aus Metadaten)',
    'Suchbegriffe: bug report, issue',
    'Gesendet 5 von 304 Seiten: S. 1–3, 7, 304',
  ]);
  assert.deepEqual(bookDetails({ label: 'B', attachmentID: 1, state: 'nohits', languageSource: 'model', keywords: [] }).slice(1), ['Keine Suchbegriffe erhalten, suche nur mit der Frage.']);
});

test('book excerpts: page markers split the reply, unknown pages dropped, no-match is empty', () => {
  const reply = 'Hier die Stellen:\n[Page 12] Starkregen führt in Städten zu Überflutungen und Schäden.\n' +
    '[Page 99] Diese Seite wurde nicht gesendet, der Text bleibt aber erhalten.\n[Page 13]\n„Ein weiterer relevanter Abschnitt über Hitze.“';
  const ex = parseExcerpts(reply, [12, 13]);
  assert.deepEqual(ex.map((e) => e.page), [12, undefined, 13]);
  assert.equal(ex[2].text, 'Ein weiterer relevanter Abschnitt über Hitze.');
  assert.deepEqual(parseExcerpts('NO RELEVANT CONTENT.', [1]), []);
  assert.deepEqual(parseExcerpts('Kein Marker, aber ein brauchbarer längerer Abschnitt.', [1]).map((e) => e.page), [undefined]);
  const msgs = buildExcerptMessages({ question: 'q', book: 'B', pages: [{ pageNumber: 12, text: 'T' }], totalPages: 40 });
  assert.match(msgs[0].content, /\[Page 12\]\nT/);
  assert.match(msgs[0].content, /NO RELEVANT CONTENT/);
});
