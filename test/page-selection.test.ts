import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerms, searchKey, selectPages, selectPagesByTerms, tokenize } from '../src/core/context/page-selection';

const filler = (n: number) => 'lorem ipsum dolor sit amet '.repeat(n);
const pages = [
  { pageNumber: 1, text: 'Titel und Abstract ' + filler(20) },
  { pageNumber: 2, text: filler(40) },
  { pageNumber: 3, text: 'Hochwasser Starkregen Überflutung Starkregen ' + filler(35) },
  { pageNumber: 4, text: filler(40) },
  { pageNumber: 5, text: 'Methodik Regression ' + filler(38) },
];

test('small documents are sent in full, empty pages dropped', () => {
  const sel = selectPages([...pages, { pageNumber: 6, text: '  ' }], 'egal', 1_000_000);
  assert.equal(sel.mode, 'full');
  assert.deepEqual(sel.pages.map((p) => p.pageNumber), [1, 2, 3, 4, 5]);
});

test('long documents keep page 1 plus the best matching pages, in page order', () => {
  const budget = pages[0].text.length + pages[2].text.length + 10;
  const sel = selectPages(pages, 'Was sagt der Text zu Starkregen?', budget);
  assert.equal(sel.mode, 'excerpt');
  assert.deepEqual(sel.pages.map((p) => p.pageNumber), [1, 3]);
});

test('without usable terms, pages are spread over the document', () => {
  const budget = pages[0].text.length + pages[2].text.length + pages[4].text.length + 10;
  const sel = selectPages(pages, 'Fasse das zusammen', budget);
  assert.equal(sel.mode, 'excerpt');
  assert.equal(sel.pages[0].pageNumber, 1);
  assert.ok(sel.pages.length >= 2);
  const total = sel.pages.reduce((s, p) => s + p.text.length, 0);
  assert.ok(total <= budget + 10, 'stays within budget');
});

test('tokenize drops stopwords and short tokens, keeps umlauts', () => {
  assert.deepEqual(tokenize('Was ist die Überflutung im Jahr 2021?'), ['überflutung', 'jahr', '2021']);
});

test('search keys match umlaut spellings and plural endings', () => {
  assert.equal(searchKey('wärmeinsel'), searchKey('waermeinseln'));
  assert.equal(searchKey('überflutungen'), searchKey('ueberflutung'));
  assert.equal(searchKey('climates'), searchKey('climate'));
  assert.equal(searchKey('hitze'), 'hitz');
  assert.equal(searchKey('rot'), 'rot', 'short words keep their ending');
});

test('a model keyword in another spelling still finds its page', () => {
  const doc = [...pages, { pageNumber: 6, text: 'Waermeinseln in dicht bebauten Quartieren ' + filler(36) }];
  const budget = doc[0].text.length + doc[5].text.length + 10;
  const sel = selectPagesByTerms(doc, buildTerms('Was sagt der Text zum Stadtklima?', ['Wärmeinsel']), budget);
  assert.deepEqual(sel.pages.map((p) => p.pageNumber), [1, 6]);
});
