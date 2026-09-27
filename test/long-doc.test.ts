import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFit, formatCount } from '../src/core/context/fit';
import { buildKeywordMessages, parseKeywords } from '../src/core/context/keywords';
import { buildOutline, detectHeading, outlineFromBlocks, outlineFromHeadings, outlineFromReader } from '../src/core/context/outline';
import { buildTerms, selectPagesByTerms } from '../src/core/context/page-selection';

const filler = (n: number) => 'lorem ipsum dolor sit amet '.repeat(n);
const book = Array.from({ length: 40 }, (_, i) => ({ pageNumber: i + 1, text: filler(40) }));

test('fit: tokens estimated, fits flag against budget', () => {
  const fit = analyzeFit(book, 10_000);
  assert.equal(fit.fits, false);
  assert.equal(fit.pageCount, 40);
  assert.equal(fit.totalTokens, Math.ceil(fit.totalChars / 3.5));
  assert.equal(analyzeFit(book.slice(0, 1), 10_000).fits, true);
  assert.equal(formatCount(1234567), '1.234.567');
});

test('keywords: JSON array, thinking and junk are handled', () => {
  assert.deepEqual(parseKeywords('<think>hmm</think>["Starkregen", "heavy rainfall", "starkregen", "Überflutung"]'),
    ['Starkregen', 'heavy rainfall', 'Überflutung']);
  assert.deepEqual(parseKeywords('- Hitze\n- urban heat island\n2. Versiegelung'), ['Hitze', 'urban heat island', 'Versiegelung']);
  assert.deepEqual(parseKeywords(''), []);
  assert.ok(parseKeywords(JSON.stringify(Array.from({ length: 40 }, (_, i) => `begriff${i}`))).length <= 20);
});

test('keywords: prompt carries question, title and previous question', () => {
  const msgs = buildKeywordMessages({ question: 'Was hilft gegen Hitze?', previousQuestion: 'Kapitel 3?', docTitle: 'Muster 2021 – Stadtklima' });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes('Was hilft gegen Hitze?'));
  assert.ok(msgs[1].content.includes('Kapitel 3?'));
  assert.ok(msgs[1].content.includes('Muster 2021'));
});

test('terms: model keywords widen the search and find synonym pages', () => {
  const pages = book.map((p) => ({ ...p }));
  pages[20].text = 'Hitzeinseln und urbane Waermeinseln ' + filler(35);
  const budget = pages[0].text.length * 4;
  const plain = selectPagesByTerms(pages, buildTerms('Was sagt das Buch zum Stadtklima?'), budget);
  assert.ok(plain.noMatches, 'question alone matches nothing');
  const expanded = selectPagesByTerms(pages, buildTerms('Was sagt das Buch zum Stadtklima?', ['Hitzeinseln', 'Waermeinseln']), budget);
  assert.equal(expanded.noMatches, false);
  assert.ok(expanded.pages.some((p) => p.pageNumber === 21), 'synonym page included');
});

test('selection: only relevant pages and their neighbours, no unrelated filler', () => {
  const pages = book.map((p) => ({ ...p }));
  pages[10].text = 'Starkregen Starkregen ' + filler(38);
  const sel = selectPagesByTerms(pages, buildTerms('Starkregen'), pages[0].text.length * 20);
  assert.deepEqual(sel.pages.map((p) => p.pageNumber), [1, 10, 11, 12]);
  assert.equal(sel.matchedPages, 1);
});

test('outline: reader bookmarks become a tree with page ranges and tokens', () => {
  const items = [
    { title: 'Einleitung', location: { position: { pageIndex: 0 } } },
    { title: 'Methoden', location: { position: { pageIndex: 9 } }, items: [
      { title: 'Daten', location: { position: { pageIndex: 9 } } },
      { title: 'Modell', location: { position: { pageIndex: 14 } } },
    ] },
    { title: 'Ergebnisse', location: { position: { pageIndex: 24 } } },
  ];
  const o = outlineFromReader(items, book)!;
  assert.equal(o.source, 'pdf');
  assert.deepEqual(o.nodes.map((n) => [n.title, n.pageStart, n.pageEnd]), [['Einleitung', 1, 9], ['Methoden', 10, 24], ['Ergebnisse', 25, 40]]);
  assert.deepEqual(o.nodes[1].children.map((c) => [c.pageStart, c.pageEnd]), [[10, 14], [15, 24]]);
  assert.equal(o.nodes[1].tokens, o.nodes[1].children.reduce((s, c) => s + c.tokens, 0));
});

test('outline: headings in the text, else page blocks', () => {
  const pages = book.map((p) => ({ ...p }));
  pages[4].text = 'Kapitel 1 Grundlagen\n' + filler(30);
  pages[19].text = 'Kapitel 2 Ergebnisse\n' + filler(30);
  pages[24].text = '2.1 Hitze in Städten\n' + filler(30);
  const o = outlineFromHeadings(pages)!;
  assert.equal(o.source, 'headings');
  assert.deepEqual(o.nodes.map((n) => n.title), ['Anfang', 'Kapitel 1 Grundlagen', 'Kapitel 2 Ergebnisse']);
  assert.equal(o.nodes[2].children[0].title, '2.1 Hitze in Städten');
  assert.equal(buildOutline(book).source, 'blocks');
  assert.deepEqual(outlineFromBlocks(book).nodes.map((n) => n.title), ['Seiten 1–20', 'Seiten 21–40']);
});

test('headings: own line, or start of running text (as Zotero extracts it)', () => {
  assert.equal(detectHeading('Kapitel 3 Methoden\nText'), 'Kapitel 3 Methoden');
  assert.equal(detectHeading('Kapitel 1 Grundlagen Die Untersuchung betrachtet Verwaltung'), 'Kapitel 1 Grundlagen');
  assert.equal(detectHeading('Chapter 2: Urban Heat In this chapter we'), 'Chapter 2: Urban Heat');
  assert.equal(detectHeading('3 Methoden Die Daten stammen aus'), '3 Methoden');
  assert.equal(detectHeading('Die Untersuchung betrachtet Verwaltung'), null);
});
