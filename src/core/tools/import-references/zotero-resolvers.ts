/**
 * Resolvers and saving with Zotero's own means only: identifier lookup (Zotero.Translate.Search, as
 * "Add Item by Identifier"), web translators for URLs (Zotero.Translate.Web), and the model's fields as
 * last resort. Lookups run with `libraryID: false` (nothing is saved); the confirmed items are saved with
 * Zotero.Translate.ItemSaver, so lookup results and own items go the same way.
 */
import { logger } from '../../../util/log';
import { cleanDOI, cleanISBN, fieldIdentifier, referenceToItemJSON, sameTitle, trustedTextIdentifiers, type Identifier, type ItemJSON, type ReferenceInput } from './reference';
import type { ReferenceResolver, ResolvedReference } from './resolvers';
import type { ToolTarget } from '../types';

const L = logger('Import');
/** A lookup that takes longer is given up (the next resolver is asked). */
const LOOKUP_TIMEOUT_MS = 30000;
/** Finding and downloading a PDF (several sources, large files) may take longer. */
const PDF_TIMEOUT_MS = 90000;

function withTimeout<T>(p: Promise<T>, what: string, ms = LOOKUP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: timeout`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function describeIdentifier(id: Identifier): string {
  const [k, v] = Object.entries(id)[0];
  return `${k} ${v}`;
}

/** Identifier from the model's fields, else the first one Zotero finds in the reference text. */
export function identifierOf(ref: ReferenceInput): Identifier | undefined {
  const own = fieldIdentifier(ref);
  if (own) return own;
  const text = ref.text || '';
  return trustedTextIdentifiers(text, (Zotero.Utilities.extractIdentifiers?.(text) || []) as Identifier[])[0];
}

/** DOI, ISBN, PMID, arXiv: Zotero's search translators (Crossref, DataCite, library catalogues, PubMed, arXiv). */
export const identifierResolver: ReferenceResolver = {
  id: 'identifier',
  async resolve(ref) {
    const id = identifierOf(ref);
    if (!id) return null;
    const what = describeIdentifier(id);
    const translate = new Zotero.Translate.Search();
    translate.setIdentifier(id);
    const translators = await withTimeout<any[]>(translate.getTranslators(), what);
    if (!translators?.length) throw new Error(`${what}: no translator`);
    translate.setTranslator(translators);
    const items = await L.time(`lookup ${what}`, () => withTimeout<ItemJSON[]>(translate.translate({ libraryID: false, saveAttachments: false }), what));
    if (!items?.length) throw new Error(`${what}: not found`);
    return { item: items[0], via: 'identifier', detail: what };
  },
};

/** Web page: Zotero's web translator for the site (metadata like the browser connector). */
export const urlResolver: ReferenceResolver = {
  id: 'url',
  async resolve(ref) {
    const url = String(ref.url || '').trim();
    // A link straight to a PDF has no page to translate; the PDF itself is fetched after saving (attachPdf).
    if (!/^https?:\/\//i.test(url) || cleanDOI(url) || /\.pdf($|[?#])/i.test(url)) return null;
    let item: ItemJSON | null = null;
    await L.time(`web translator ${url}`, () => withTimeout(Zotero.HTTP.processDocuments([url], async (doc: any) => {
      const translate = new Zotero.Translate.Web();
      translate.setDocument(doc);
      const translators = await translate.getTranslators();
      if (!translators?.length) return;
      translate.setTranslator(translators[0]);
      const items: ItemJSON[] = await translate.translate({ libraryID: false, saveAttachments: false });
      item = items?.[0] || null;
    }), url));
    return item ? { item, via: 'url', detail: url } : null;
  },
};

/** The fields the model read from the reference; always gives an item. */
export const textResolver: ReferenceResolver = {
  id: 'text',
  async resolve(ref) {
    return { item: referenceToItemJSON(ref), via: 'text' };
  },
};

/** Zotero's own chain; other resolvers (zotero-reference, Crossref …) go in front. */
export function zoteroResolvers(): ReferenceResolver[] {
  return [identifierResolver, urlResolver, textResolver];
}

/** An item in the target library that already is this one: same DOI, same ISBN, or same title (and year). */
export async function findDuplicate(item: ItemJSON, libraryID: number): Promise<any | null> {
  const search = async (field: string, op: string, value: string): Promise<any[]> => {
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition('deleted', 'false');
    s.addCondition(field, op, value);
    const ids: number[] = await s.search();
    return (await Zotero.Items.getAsync(ids)).filter((i: any) => i.isRegularItem());
  };
  const doi = cleanDOI(item.DOI);
  if (doi) {
    const hits = await search('DOI', 'contains', doi);
    const hit = hits.find((i) => cleanDOI(i.getField('DOI'))?.toLowerCase() === doi.toLowerCase());
    if (hit) return hit;
  }
  const isbn = cleanISBN(item.ISBN);
  if (isbn) {
    const hits = await search('ISBN', 'contains', isbn.slice(-9, -1));
    const hit = hits.find((i) => String(i.getField('ISBN')).replace(/[- ]/g, '').toUpperCase().includes(isbn));
    if (hit) return hit;
  }
  const title = String(item.title || '').trim();
  if (title.length >= 10) {
    const words = title.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    const year = String(item.date || '').match(/\d{4}/)?.[0];
    for (const hit of await search('title', 'contains', words)) {
      const hitYear = String(hit.getField('date') || '').match(/\d{4}/)?.[0];
      if (sameTitle(hit.getField('title'), title) && (!year || !hitYear || year === hitYear)) return hit;
    }
  }
  return null;
}

/** Drops fields the item type does not have (from the model's guesses) and empty creators. */
export function validFields(item: ItemJSON): ItemJSON {
  const typeID = Zotero.ItemTypes.getID(item.itemType);
  const out: ItemJSON = { ...item, itemType: typeID ? item.itemType : 'document' };
  const outTypeID = Zotero.ItemTypes.getID(out.itemType);
  const skip = new Set(['itemType', 'creators', 'tags', 'notes', 'attachments', 'seeAlso', 'complete', 'itemID', 'id', 'key', 'version']);
  for (const field of Object.keys(out)) {
    if (skip.has(field)) continue;
    const fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, outTypeID)) {
      // Base fields have type-specific names (publisher -> institution …).
      const mapped = fieldID ? Zotero.ItemFields.getFieldIDFromTypeAndBase(outTypeID, fieldID) : null;
      if (mapped && !out[Zotero.ItemFields.getName(mapped)]) out[Zotero.ItemFields.getName(mapped)] = out[field];
      delete out[field];
    }
  }
  const creatorTypes = new Set((Zotero.CreatorTypes.getTypesForItemType(outTypeID) || []).map((c: any) => c.name));
  const primary = Zotero.CreatorTypes.getName(Zotero.CreatorTypes.getPrimaryIDForType(outTypeID));
  out.creators = (out.creators || [])
    .filter((c) => c && (c.lastName || (c as any).name))
    .map((c) => (creatorTypes.has(c.creatorType) ? c : { ...c, creatorType: primary }));
  return out;
}

/** Saves the item into the target (library, collection); attachments of lookups are not downloaded. */
export async function saveItem(resolved: ResolvedReference, target: ToolTarget): Promise<any> {
  const item = validFields({ ...resolved.item, attachments: [] });
  const saver = new Zotero.Translate.ItemSaver({
    libraryID: target.libraryID,
    collections: target.collectionID ? [target.collectionID] : false,
    attachmentMode: Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE,
  });
  const saved = await saver.saveItems([item]);
  if (!saved?.[0]) throw new Error('not saved');
  L.info(`saved item ${saved[0].id} (${resolved.via})`);
  return saved[0];
}

export type PdfResult = 'attached' | 'present' | 'none' | 'notPossible';

/**
 * Zotero's "Find Full Text" for a saved item: DOI landing page, the item's URL (also a direct PDF link), open
 * access (Unpaywall, PMC) and the custom resolvers set up in Zotero. 'present': it already has a PDF;
 * 'notPossible': no DOI, URL or PMCID to start from.
 */
export async function attachPdf(item: any): Promise<PdfResult> {
  const A = Zotero.Attachments;
  if (item.numFileAttachmentsWithContentType?.('application/pdf')) return 'present';
  if (!A.canFindFileForItem(item)) return 'notPossible';
  const att = await L.time(`find PDF for item ${item.id}`, () => withTimeout<any>(A.addAvailableFile(item), 'PDF', PDF_TIMEOUT_MS));
  if (att) return 'attached';
  return (await attachHttpPdf(item)) ? 'attached' : 'none';
}

/**
 * Zotero's search forces every link to https ("if a request fails because of that, too bad"); reports of
 * authorities and institutes are often served over http only. A plain http link that really is a PDF
 * (checked by its content type) is downloaded directly.
 */
async function attachHttpPdf(item: any): Promise<boolean> {
  const url = String(item.getField('url') || '');
  if (!/^http:\/\//i.test(url)) return false;
  const [mimeType] = await withTimeout<[string, boolean]>(Zotero.MIME.getMIMETypeFromURL(url), url);
  if (mimeType !== 'application/pdf') return false;
  const att = await L.time(`download http PDF for item ${item.id}`, () => withTimeout<any>(
    Zotero.Attachments.importFromURL({ url, parentItemID: item.id, contentType: mimeType }), url, PDF_TIMEOUT_MS));
  return !!att;
}
