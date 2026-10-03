import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../src/i18n';
import { docKind, htmlToText, splitSections } from '../src/core/context/document';
import { buildMessages, describeContext, formatSections } from '../src/core/prompt';
import type { ContextBlock } from '../src/core/context/types';

setLocale('de');

test('sections: paragraphs packed up to the size, long paragraphs split at sentence ends', () => {
  const para = (n: number, len: number) => `Absatz ${n} ` + 'x'.repeat(len);
  const text = [para(1, 1000), para(2, 1000), para(3, 1500), para(4, 200)].join('\n\n');
  const s = splitSections(text, 3000);
  assert.deepEqual(s.map((x) => x.pageNumber), [1, 2]);
  assert.ok(s[0].text.startsWith('Absatz 1') && s[0].text.includes('Absatz 2') && !s[0].text.includes('Absatz 3'));
  const long = Array.from({ length: 40 }, (_, i) => `Satz ${i} mit etwas Inhalt zur Laenge.`).join(' ');
  const parts = splitSections(long, 300);
  assert.ok(parts.length > 3 && parts.every((p) => p.text.length <= 300 && /\.$/.test(p.text)), JSON.stringify(parts.map((p) => p.text.length)));
  assert.equal(parts.map((p) => p.text).join(' '), long);
  assert.deepEqual(splitSections('  \n\n '), []);
  // Lines without blank lines between them (text files) count as paragraphs.
  assert.equal(splitSections('a\nb\nc', 3).length, 3);
});

test('HTML to text: no scripts or styles, block ends become paragraph breaks, entities decoded', () => {
  const html = '<html><head><title>T</title><style>p{}</style></head><body><script>var x=1</script>'
    + '<h1>Hitze&nbsp;in St&auml;dten</h1><p>Erster &amp; <b>wichtiger</b> Absatz.</p><p>Zweiter&#8211;Absatz</p></body></html>';
  const sections = splitSections(htmlToText(html));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].text, 'Hitze in Städten\n\nErster & wichtiger Absatz.\n\nZweiter–Absatz');
});

test('document kind from the attachment', () => {
  (globalThis as any).Zotero = { Attachments: { LINK_MODE_LINKED_URL: 3 } };
  const att = (o: any) => ({ isAttachment: () => true, isPDFAttachment: () => false, attachmentLinkMode: 1, ...o });
  assert.equal(docKind(att({ isPDFAttachment: () => true })), 'pdf');
  assert.equal(docKind(att({ attachmentContentType: 'application/epub+zip' })), 'epub');
  assert.equal(docKind(att({ attachmentContentType: 'text/html' })), 'html');
  assert.equal(docKind(att({ attachmentContentType: 'text/plain' })), 'text');
  assert.equal(docKind(att({ attachmentContentType: 'text/markdown' })), 'text');
  assert.equal(docKind(att({ attachmentContentType: 'image/png' })), null);
  assert.equal(docKind(att({ attachmentContentType: 'text/html', attachmentLinkMode: 3 })), null, 'web link without file');
  assert.equal(docKind({ isAttachment: () => false }), null);
  delete (globalThis as any).Zotero;
});

const block = (o: Partial<ContextBlock>): ContextBlock => ({
  title: 'UBA 2019 – Hitze in der Stadt', body: 'Text', mode: 'full', includedPages: [1, 2], totalPages: 2, docKind: 'html', ...o,
});

test('prompt for a web page: no page citations, gaps marked, notes kept', () => {
  assert.equal(formatSections([{ pageNumber: 1, text: 'A' }, { pageNumber: 2, text: 'B' }, { pageNumber: 5, text: 'E' }]), 'A\n\nB\n\n[…]\n\nE');
  const [system] = buildMessages({ context: block({ notes: [{ title: 'Notiz', text: 'eigene Gedanken' }] }), history: [], question: 'Was steht drin?' });
  assert.match(system.content, /saved web page without page numbers: do not cite pages/);
  assert.doesNotMatch(system.content, /\[S\. 12\]|\[Page/);
  assert.match(system.content, /The full text of the document follows/);
  assert.match(system.content, /<notes>[\s\S]*eigene Gedanken/);
  const [excerpt] = buildMessages({ context: block({ mode: 'excerpt', includedPages: [1, 4], totalPages: 9, docKind: 'epub' }), history: [], question: 'q', systemPrompt: 'Eigener Prompt.' });
  assert.match(excerpt.content, /^Eigener Prompt\.\n\nThe document is an e-book \(EPUB\)/);
  assert.match(excerpt.content, /2 of 9 sections, gaps marked/);
});

test('meta line for documents', () => {
  assert.equal(describeContext(block({})), 'Volltext (Webseite)');
  assert.equal(describeContext(block({ mode: 'excerpt', includedPages: [1, 3], totalPages: 7, matchedPages: 1, docKind: 'text' })), 'Auszüge (Textdatei): 2 von 7 Abschnitten, 1 Abschnitt mit Treffern');
});
