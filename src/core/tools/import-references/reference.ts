/**
 * One reference as the model passes it to import_references, and the pure conversions: item type, creators,
 * identifiers, the item in Zotero's translator JSON (what Zotero.Translate.ItemSaver saves) and a short label.
 * No Zotero here (unit-tested); field validity per type is checked when saving (zotero-resolvers.ts).
 */

export interface ReferenceInput {
  /** The reference as the user wrote it (verbatim). */
  text?: string;
  itemType?: string;
  title?: string;
  /** "Last, First" or "First Last"; organisations as written. */
  authors?: string[];
  editors?: string[];
  date?: string;
  /** Journal, newspaper, website. */
  publicationTitle?: string;
  /** Book of a chapter, proceedings of a conference paper. */
  containerTitle?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  edition?: string;
  series?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  url?: string;
  accessDate?: string;
}

/** Item in translator JSON: itemType, fields, creators, tags, notes, attachments. */
export interface ItemJSON {
  itemType: string;
  title?: string;
  creators?: CreatorJSON[];
  tags?: unknown[];
  notes?: unknown[];
  attachments?: unknown[];
  [field: string]: any;
}

export interface CreatorJSON {
  creatorType: string;
  firstName?: string;
  lastName: string;
  /** 1: single field (organisation). */
  fieldMode?: number;
}

export type Identifier = { DOI: string } | { ISBN: string } | { PMID: string } | { arXiv: string };

const TYPE_ALIASES: Record<string, string> = {
  article: 'journalArticle',
  journal: 'journalArticle',
  journalarticle: 'journalArticle',
  paper: 'journalArticle',
  book: 'book',
  monograph: 'book',
  chapter: 'bookSection',
  booksection: 'bookSection',
  inbook: 'bookSection',
  incollection: 'bookSection',
  conference: 'conferencePaper',
  conferencepaper: 'conferencePaper',
  inproceedings: 'conferencePaper',
  proceedings: 'conferencePaper',
  report: 'report',
  techreport: 'report',
  thesis: 'thesis',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  webpage: 'webpage',
  website: 'webpage',
  web: 'webpage',
  online: 'webpage',
  newspaper: 'newspaperArticle',
  newspaperarticle: 'newspaperArticle',
  magazine: 'magazineArticle',
  magazinearticle: 'magazineArticle',
  preprint: 'preprint',
  dataset: 'dataset',
  software: 'computerProgram',
  computerprogram: 'computerProgram',
  law: 'statute',
  statute: 'statute',
  standard: 'standard',
  patent: 'patent',
  presentation: 'presentation',
  document: 'document',
};

/** Zotero item type from the model's type name, else from the fields it filled. */
export function itemTypeOf(ref: ReferenceInput): string {
  const key = String(ref.itemType || '').replace(/[^a-z]/gi, '').toLowerCase();
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  if (ref.containerTitle) return 'bookSection';
  if (ref.publicationTitle) return 'journalArticle';
  if (ref.ISBN || ref.publisher) return 'book';
  if (ref.url) return 'webpage';
  return 'document';
}

/** "Müller, Hans", "Hans Müller", "Müller, H." -> last/first; one word or several commas: one field (organisation). */
export function parseCreator(name: string, creatorType: string): CreatorJSON | null {
  const n = name.replace(/\s+/g, ' ').trim().replace(/[.;,]$/, (m) => (m === '.' ? m : ''));
  if (!n) return null;
  const parts = n.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) return { creatorType, lastName: parts[0], firstName: parts[1] };
  if (parts.length === 1) {
    const words = parts[0].split(' ');
    // A name with a lower-case particle keeps it with the last name ("Ludwig van Beethoven").
    if (words.length >= 2 && words.length <= 4 && /^\p{Lu}/u.test(words[0]) && !/(e\.\s*V|GmbH|Institut|Ministerium|Amt|Agency|Office|Association|University|Universität)/i.test(n)) {
      let i = words.length - 1;
      while (i > 1 && /^\p{Ll}/u.test(words[i - 1])) i--;
      return { creatorType, firstName: words.slice(0, i).join(' '), lastName: words.slice(i).join(' ') };
    }
  }
  return { creatorType, lastName: n, fieldMode: 1 };
}

/** DOI without resolver prefix and trailing punctuation, or undefined. */
export function cleanDOI(value: string | undefined): string | undefined {
  const m = String(value || '').match(/10\.\d{4,9}\/\S+/);
  return m ? m[0].replace(/[.,;:)\]]+$/, '') : undefined;
}

/** ISBN-10/13 digits (with X), only when the check digit is right. */
export function cleanISBN(value: string | undefined): string | undefined {
  for (const m of String(value || '').matchAll(/[0-9][0-9\- ]{8,16}[0-9Xx]/g)) {
    const isbn = m[0].replace(/[- ]/g, '').toUpperCase();
    if (isbn.length === 10 && /^\d{9}[\dX]$/.test(isbn)) {
      const sum = [...isbn].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
      if (sum % 11 === 0) return isbn;
    } else if (isbn.length === 13 && /^\d+$/.test(isbn)) {
      const sum = [...isbn].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
      if (sum % 10 === 0) return isbn;
    }
  }
  return undefined;
}

/** Identifier from the fields the model filled (DOI before ISBN); identifiers only in the text are found by Zotero. */
export function fieldIdentifier(ref: ReferenceInput): Identifier | undefined {
  const doi = cleanDOI(ref.DOI) || cleanDOI(ref.url);
  if (doi) return { DOI: doi };
  const isbn = cleanISBN(ref.ISBN);
  if (isbn) return { ISBN: isbn };
  return undefined;
}

/**
 * Identifiers Zotero found in a reference text that can be trusted: Zotero takes any bare number for a PMID
 * (page "1" -> PubMed article 1), so a PMID counts only when the text labels it ("PMID: 123456").
 */
export function trustedTextIdentifiers(text: string, found: Identifier[]): Identifier[] {
  return found.filter((id) => !('PMID' in id) || new RegExp(`PMID:?\\s*${id.PMID}\\b`, 'i').test(text));
}

/** Field names per item type that differ from the generic ones. */
function containerField(itemType: string): string | undefined {
  switch (itemType) {
    case 'bookSection': return 'bookTitle';
    case 'conferencePaper': return 'proceedingsTitle';
    case 'webpage': return 'websiteTitle';
    case 'journalArticle': case 'magazineArticle': case 'newspaperArticle': case 'preprint': return 'publicationTitle';
    default: return undefined;
  }
}

function publisherField(itemType: string): string {
  switch (itemType) {
    case 'report': return 'institution';
    case 'thesis': return 'university';
    case 'webpage': return 'websiteTitle';
    case 'computerProgram': return 'company';
    default: return 'publisher';
  }
}

/** The reference as a new item in translator JSON (fields the type may not have are dropped when saving). */
export function referenceToItemJSON(ref: ReferenceInput): ItemJSON {
  const itemType = itemTypeOf(ref);
  const item: ItemJSON = { itemType, creators: [], tags: [], notes: [], attachments: [] };
  const set = (field: string | undefined, value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
    if (field && v && !item[field]) item[field] = v;
  };
  set('title', ref.title || ref.text);
  for (const a of ref.authors || []) {
    const c = parseCreator(a, itemType === 'computerProgram' ? 'programmer' : 'author');
    if (c) item.creators!.push(c);
  }
  for (const e of ref.editors || []) {
    const c = parseCreator(e, 'editor');
    if (c) item.creators!.push(c);
  }
  set('date', ref.date);
  const container = containerField(itemType);
  set(container, ref.containerTitle || ref.publicationTitle);
  if (!container && ref.publicationTitle) set('series', ref.publicationTitle);
  set(publisherField(itemType), ref.publisher);
  set('place', ref.place);
  set('volume', ref.volume);
  set('issue', ref.issue);
  set('pages', ref.pages);
  set('edition', ref.edition);
  set('series', ref.series);
  set('DOI', cleanDOI(ref.DOI));
  set('ISBN', cleanISBN(ref.ISBN) || ref.ISBN);
  set('ISSN', ref.ISSN);
  set('url', ref.url);
  set('accessDate', ref.accessDate);
  return item;
}

/** "Müller, Schmidt (2020): Title" for preview and result lists. */
export function itemLabel(item: ItemJSON): string {
  const names = (item.creators || []).filter((c) => c.creatorType !== 'editor').map((c) => c.lastName);
  const who = names.length > 2 ? `${names[0]} et al.` : names.join(', ');
  const year = String(item.date || '').match(/\d{4}/)?.[0];
  const title = String(item.title || '').trim() || '?';
  return `${who}${year ? ` (${year})` : ''}${who || year ? ': ' : ''}${title}`;
}

/** Words of a title for comparisons: no accents, lower case, at least 3 characters. */
export function titleWords(text: string): Set<string> {
  return new Set(String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
}

/** Two titles name the same work: at least 85 % shared words (of the longer one). */
export function sameTitle(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (!wa.size || !wb.size) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(wa.size, wb.size) >= 0.85;
}

/** References from the tool arguments: objects with at least a text, title or identifier; strings count as text. */
export function referencesFromArgs(args: Record<string, any>): ReferenceInput[] {
  const list = Array.isArray(args.references) ? args.references : [];
  return list
    .map((r: any) => (typeof r === 'string' ? { text: r } : r && typeof r === 'object' ? r : null))
    .filter((r: any): r is ReferenceInput => !!r && !!(r.text || r.title || r.DOI || r.ISBN || r.url))
    .map((r: any) => ({ ...r, authors: stringList(r.authors), editors: stringList(r.editors) }));
}

function stringList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim());
  if (typeof v === 'string' && v.trim()) return v.split(/\s*;\s*|\s+(?:and|und|&)\s+/).filter(Boolean);
  return undefined;
}
