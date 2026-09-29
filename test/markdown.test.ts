import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, tokenizeInline } from '../src/ui/markdown';
import { citedSources } from '../src/ui/turn-view';
import { countCoverage, describeCoverage } from '../src/core/library/coverage';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

test('markdown blocks: paragraphs, headings, bullet and numbered lists', () => {
  const blocks = parseBlocks('# Titel\n\nErster Absatz\nzweite Zeile\n\n- a\n- b\n  weiter\n1. eins\n2) zwei\n\nEnde');
  assert.deepEqual(blocks, [
    { type: 'h', level: 1, text: 'Titel' },
    { type: 'p', text: 'Erster Absatz\nzweite Zeile' },
    { type: 'ul', items: ['a', 'b\nweiter'] },
    { type: 'ol', items: ['eins', 'zwei'] },
    { type: 'p', text: 'Ende' },
  ]);
});

const t = (text: string) => ({ type: 'text' as const, text });

test('inline: bold around a citation, italic, code; unbalanced markers stay text', () => {
  const toks = tokenizeInline([t('A **'), { type: 'cite', node: {} as any }, t('** und *kursiv* mit `a*b`')]);
  assert.deepEqual(toks.map((k) => k.type === 'cite' ? `cite:${k.bold}` : `${k.text}|${k.bold ? 'b' : ''}${k.italic ? 'i' : ''}${k.code ? 'c' : ''}`),
    ['A |', 'cite:true', ' und |', 'kursiv|i', ' mit |', 'a*b|c']);
  assert.deepEqual(tokenizeInline([t('3 * 4 und ein ** allein')]).map((k: any) => k.text), ['3 * 4 und ein ** allein']);
  assert.deepEqual(tokenizeInline([t('snake_case_name bleibt')]).map((k: any) => k.text), ['snake_case_name bleibt']);
});

test('cited sources are collected from the answer', () => {
  assert.deepEqual([...citedSources('A [2, S. 3]; B [1] und [2]. [7]', 3)].sort(), [1, 2]);
});

test('coverage: what ZotSeek searches, where its books come from, what it cannot see', () => {
  const items = [
    { isPdfAttachment: true, isRegular: false, itemType: 'attachment' },
    { isPdfAttachment: false, isRegular: true, itemType: 'book' },
    { isPdfAttachment: false, isRegular: true, itemType: 'journalArticle' },
  ];
  const c = countCoverage(items, { excludeBooks: true, fullText: false });
  assert.deepEqual(c, { standalonePdfs: 1, papers: 1, books: 1, excludedBooks: 1, fullText: false, bookMode: 'excluded' });
  assert.equal(describeCoverage(c), 'ZotSeek durchsucht hier 1 Eintrag. ' +
    'Nicht durchsuchbar: 1 PDF ohne übergeordneten Eintrag, 1 Buch (in ZotSeek „Bücher ausschließen“ an). ' +
    'ZotSeek indexiert nur Titel und Abstracts (Indexierungsmodus „abstract“), keine PDF-Inhalte.');
  assert.equal(describeCoverage(countCoverage(items.slice(1), { excludeBooks: false, fullText: true })),
    'ZotSeek durchsucht hier 2 Einträge. Das Buch ist in ZotSeeks eigenem Index (dort ist „Bücher ausschließen“ aus).');
  // Bound to SeekBook: only while SeekBook is ready; then it wins over ZotSeek's own books.
  const bound = { excludeBooks: true, fullText: true, includeSeekBook: true };
  assert.equal(countCoverage(items.slice(1), bound, true).bookMode, 'seekbook');
  assert.equal(countCoverage(items.slice(1), bound, false).bookMode, 'excluded');
  assert.equal(countCoverage(items.slice(1), { ...bound, excludeBooks: false }, true).bookMode, 'seekbook');
  assert.equal(describeCoverage(countCoverage(items.slice(1), bound, true)),
    'ZotSeek durchsucht hier 2 Einträge. Das Buch kommt über SeekBook, das ZotSeek einbindet.');
});
