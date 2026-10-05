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
        { purpose: 'Suchbegriffe', model: 'm', temperature: 0.2, maxTokens: 512, messages: [{ role: 'system', content: 'Liste ```json``` Suchbegriffe' }] },
        { purpose: 'Antwort', model: 'm', temperature: 0.2, maxTokens: 2048, messages: [{ role: 'system', content: 'Doku' }, { role: 'user', content: 'Frage' }] },
      ],
    },
  ], { subject: 'PDF X', model: 'm', date });
  assert.ok(md.includes('<summary>Anfrage 1 an das Modell: Suchbegriffe (Modell m, Temperatur 0.2, max. 512 Tokens; 29 Zeichen)</summary>'));
  assert.ok(md.includes('**system:**\n\n````text\nListe ```json``` Suchbegriffe\n````'), 'fence longer than the backticks inside');
  assert.ok(md.includes('<summary>Anfrage 2 an das Modell: Antwort (Modell m, Temperatur 0.2, max. 2048 Tokens; 9 Zeichen)</summary>'));
  assert.ok(md.trimEnd().endsWith('</details>'));
});

test('export: the book list of a library answer is complete (state, language, search terms, pages sent)', async () => {
  const { chatToMarkdown } = await import('../src/core/export');
  const { setLocale } = await import('../src/i18n');
  setLocale('de');
  const md = chatToMarkdown([
    { role: 'user', content: 'Fehler melden?' },
    {
      role: 'assistant', content: 'Antwort [1, S. 304].', bookProgress: [
        { label: 'JIRA', attachmentID: 1, state: 'found', found: 3, language: 'Englisch', languageSource: 'model', keywords: ['bug report'], pages: [1, 2, 304], totalPages: 304 },
        { label: 'Anderes Buch', attachmentID: 2, state: 'nohits', language: 'Deutsch', languageSource: 'metadata', keywords: [] },
      ],
    },
  ], { subject: 'S', model: 'm', date: new Date(2026, 8, 28, 14, 5) });
  assert.match(md, /Bücher:\n\n- JIRA – 3 Abschnitte\n  - Dokumentsprache: Englisch \(vom Modell erkannt\)\n  - Suchbegriffe: bug report\n  - Gesendet 3 von 304 Seiten: S\. 1–2, 304\n- Anderes Buch – keine Stichworttreffer\n  - Dokumentsprache: Deutsch \(aus Metadaten\)\n  - Keine Suchbegriffe erhalten/);
  setLocale(null);
});

test('chat export: tool calls with result line and items before the answer', () => {
  setLocale('de');
  const md = chatToMarkdown([
    { role: 'user', content: 'Importiere das.' },
    {
      role: 'assistant', content: 'Erledigt.',
      toolRuns: [{
        id: '1', name: 'import_references', title: '2 Literaturangaben importieren', state: 'done', status: '1 gespeichert',
        items: [{ label: 'Muster 2021', badge: 'gespeichert', detail: 'Buch' }, { label: 'Web', url: 'https://x.org' }],
      }],
    },
  ], { subject: 'Werkzeug-Chat (Meine Bibliothek)', model: '', date });
  assert.equal(md, [
    '# SeekChat – Werkzeug-Chat (Meine Bibliothek)', '', 'Exportiert am 28.09.2026, 14:05',
    '', '## Frage 1', '', '> Importiere das.',
    '', '**Werkzeug: 2 Literaturangaben importieren** – 1 gespeichert', '',
    '- *gespeichert* Muster 2021 – Buch', '- [Web](https://x.org)',
    '', 'Erledigt.',
  ].join('\n') + '\n');
});
