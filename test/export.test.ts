import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatToMarkdown, exportFileName } from '../src/core/export';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

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
  assert.equal(exportFileName('PDF Muster 2021 – Titel: "A/B"?', date), 'SeekChat 2026-09-28 14-05 PDF Muster 2021 – Titel AB.md');
  assert.equal(exportFileName('Bibliothek „Meine Bibliothek“', date), 'SeekChat 2026-09-28 14-05 Bibliothek Meine Bibliothek.md');
});

test('model requests are exported verbatim in collapsible blocks', () => {
  const md = chatToMarkdown([
    { role: 'user', content: 'Frage' },
    {
      role: 'assistant', content: 'Antwort', requests: [
        { purpose: 'Suchbegriffe', model: 'm', temperature: 0.2, maxTokens: 512, numCtx: 4096, messages: [{ role: 'system', content: 'Liste ```json``` Suchbegriffe' }] },
        { purpose: 'Antwort', model: 'm', temperature: 0.2, maxTokens: 2048, messages: [{ role: 'system', content: 'Doku' }, { role: 'user', content: 'Frage' }] },
      ],
    },
  ], { subject: 'PDF X', model: 'm', date });
  assert.ok(md.includes('<summary>Anfrage 1 an das Modell: Suchbegriffe (Modell m, Temperatur 0.2, max. 512 Tokens, num_ctx 4096; 29 Zeichen)</summary>'));
  assert.ok(md.includes('**system:**\n\n````text\nListe ```json``` Suchbegriffe\n````'), 'fence longer than the backticks inside');
  assert.ok(md.includes('<summary>Anfrage 2 an das Modell: Antwort (Modell m, Temperatur 0.2, max. 2048 Tokens; 9 Zeichen)</summary>'));
  assert.ok(md.trimEnd().endsWith('</details>'));
});
