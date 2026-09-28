import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatToMarkdown, exportFileName } from '../src/core/export';

const date = new Date(2026, 8, 28, 14, 5);

test('chat export: questions quoted, answers as Markdown, meta and sources', () => {
  const md = chatToMarkdown([
    { role: 'user', content: 'Was steht zu Hitze?\nUnd zu Regen?' },
    {
      role: 'assistant', content: 'Hitze **steigt** [1, S. 27].', meta: 'mock · Bibliothek\nSuchbegriffe: Hitze',
      sources: [{ n: 1, itemKey: 'A', libraryKey: 'user', label: 'Muster 2021 – Buch', excerpts: [{ page: 27, text: 'x' }, { page: 3, text: 'y' }] }],
    },
    { role: 'user', content: 'Noch was?' },
    { role: 'assistant', content: 'Fehler: kaputt', error: true },
    { role: 'assistant', content: '', pending: true },
  ], { subject: 'Bibliothek „Meine“', model: 'qwen3', date });
  assert.equal(md, [
    '# SeekChat – Bibliothek „Meine“', '', 'Exportiert am 28.09.2026, 14:05 · Modell: qwen3',
    '', '## Frage 1', '', '> Was steht zu Hitze?', '> Und zu Regen?',
    '', 'Hitze **steigt** [1, S. 27].', '', '*mock · Bibliothek*  ', '*Suchbegriffe: Hitze*  ',
    '', 'Quellen:', '', '1. Muster 2021 – Buch – S. 3, 27',
    '', '## Frage 2', '', '> Noch was?', '', '**Fehler: kaputt**',
  ].join('\n') + '\n');
});

test('export file name is safe for all systems', () => {
  assert.equal(exportFileName('PDF Muster 2021 – Titel: "A/B"?', date), 'SeekChat 2026-09-28 PDF Muster 2021 – Titel AB.md');
  assert.equal(exportFileName('Bibliothek „Meine Bibliothek“', date), 'SeekChat 2026-09-28 Bibliothek Meine Bibliothek.md');
});
