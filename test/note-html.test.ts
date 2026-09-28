import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/ui/markdown';
import { chatToNoteHtml } from '../src/ui/note-html';
import { setLocale } from '../src/i18n';

// The expectations below are the German UI texts; English is covered in i18n.test.ts.
setLocale('de');

const plain = (text: string) => [{ type: 'text' as const, text }];

test('markdown to HTML: blocks, emphasis, escaping', () => {
  assert.equal(markdownToHtml('# Titel\n\nA **fett** <b>x</b> & `c`\n\n- eins\n- *zwei*', plain),
    '<h3>Titel</h3>\n<p>A <strong>fett</strong> &lt;b&gt;x&lt;/b&gt; &amp; <code>c</code></p>\n<ul><li>eins</li><li><em>zwei</em></li></ul>');
});

const date = new Date(2026, 8, 28, 14, 5);

test('note: PDF chat with page links, library chat with source links and list', () => {
  const pdf = chatToNoteHtml([
    { role: 'user', content: 'Frage <1>' },
    { role: 'assistant', content: 'Antwort [S. 2].', meta: 'm · vollständiger Text' },
  ], { subject: 'PDF X', model: 'm', date }, { page: (p) => `zotero://open-pdf/library/items/ATT?page=${p}` });
  assert.ok(pdf.startsWith('<div data-schema-version="9"><h1>SeekChat – PDF X</h1>'));
  assert.ok(pdf.includes('<blockquote><p>Frage &lt;1&gt;</p></blockquote>'));
  assert.ok(pdf.includes('<p>Antwort <a href="zotero://open-pdf/library/items/ATT?page=2">[S. 2]</a>.</p>'));

  const source = { n: 1, itemKey: 'K', libraryKey: 'user', label: 'Muster 2021 – T', excerpts: [{ page: 5, text: 'x' }] };
  const lib = chatToNoteHtml([
    { role: 'user', content: 'F' },
    { role: 'assistant', content: '**[1, S. 5]** sagt es.', sources: [source] },
  ], { subject: 'Bibliothek', model: 'm', date }, { source: (s, p) => (p ? `pdf:${s.itemKey}:${p}` : `sel:${s.itemKey}`) });
  assert.ok(lib.includes('<p><strong><a href="pdf:K:5">[1, S. 5]</a></strong> sagt es.</p>'));
  assert.ok(lib.includes('<ol><li value="1"><a href="sel:K">Muster 2021 – T</a> – S. <a href="pdf:K:5">5</a></li></ol>'));
});
