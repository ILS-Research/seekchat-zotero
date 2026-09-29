/** The user's notes as context for the PDF chat: plain text within a share of the budget. */
import { t } from '../../i18n';
import type { NoteContext } from './types';

/** Share of the text budget notes may take; longer notes are cut. */
const NOTES_SHARE = 0.3;

/** Plain text of the chosen notes (deleted ones skipped), cut to their share of the budget. */
export function contextNotesText(noteIDs: number[], budgetChars: number): NoteContext[] {
  const out: NoteContext[] = [];
  let left = Math.floor(budgetChars * NOTES_SHARE);
  for (const note of Zotero.Items.get(noteIDs)) {
    if (!note || note.deleted || !note.isNote?.() || left <= 200) continue;
    const text = noteText(note.getNote());
    if (!text) continue;
    const cut = text.length > left ? text.slice(0, left) + ' […]' : text;
    left -= cut.length;
    out.push({ title: note.getNoteTitle() || t('pdf.untitledNote'), text: cut });
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', bull: '•', middot: '·',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', euro: '€',
  copy: '©', reg: '®', deg: '°', sect: '§', para: '¶', times: '×', minus: '−',
};

/** Decodes numeric (&#8211; &#x2013;) and the common named entities in one pass; unknown ones stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,15});/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (code === 160) return ' ';
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

/** Note HTML to plain text (paragraphs and list items on their own lines). */
export function noteText(html: string): string {
  const withBreaks = String(html || '')
    .replace(/<\/(p|div|h\d|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  const plain = decodeEntities(withBreaks.replace(/<[^>]+>/g, ''));
  return plain.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Chats of the 500 most recently opened PDFs and scopes; a running chat is never dropped. */
