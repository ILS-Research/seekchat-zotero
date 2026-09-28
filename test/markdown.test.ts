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

test('coverage: standalone PDFs always, books only when ZotSeek excludes them', () => {
  const items = [
    { isPdfAttachment: true, isRegular: false, itemType: 'attachment' },
    { isPdfAttachment: false, isRegular: true, itemType: 'book' },
    { isPdfAttachment: false, isRegular: true, itemType: 'journalArticle' },
  ];
  const c = countCoverage(items, { excludeBooks: true, fullText: false });
  assert.deepEqual(c, { standalonePdfs: 1, excludedBooks: 1, fullText: false });
  assert.equal(describeCoverage(c), 'Nicht durchsuchbar: 1 PDF ohne übergeordneten Eintrag, 1 Buch (in ZotSeek „Bücher ausschließen“ an). ' +
    'ZotSeek indexiert nur Titel und Abstracts (Indexierungsmodus „abstract“), keine PDF-Inhalte.');
  assert.equal(describeCoverage(countCoverage(items.slice(1), { excludeBooks: false, fullText: true })), '');
});
