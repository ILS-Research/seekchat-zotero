/**
 * Resolver through Find Online References (zotero-reference) for references WITHOUT identifier: its parser
 * reads the reference text, its lookup finds the record by a plausibility-checked title search (Crossref,
 * OpenAlex …). References with a DOI, arXiv id, ISBN or PMID are left to Zotero's identifier lookup, which
 * asks every registration agency (Crossref, DataCite …). A DOI found by title gets its full metadata from
 * Zotero's lookup too; nothing found: the next resolver (Zotero's own) is asked.
 */
import { getFindRefsApi, type FindRefsFound, type FindRefsParsed } from '../../findrefs/client';
import { cleanDOI, cleanISBN, referenceToItemJSON, type ReferenceInput } from './reference';
import type { ReferenceResolver } from './resolvers';

/** zotero-reference's parse, filled up with what the model read (the model's fields win). */
export function mergeParsed(parsed: FindRefsParsed, ref: ReferenceInput): FindRefsParsed {
  const ids = { ...parsed.identifiers };
  const doi = cleanDOI(ref.DOI);
  if (doi) ids.DOI = doi;
  const isbn = cleanISBN(ref.ISBN);
  if (isbn && !ids.DOI) ids.ISBN = isbn;
  return {
    ...parsed,
    title: ref.title || parsed.title,
    authors: ref.authors?.length ? ref.authors : parsed.authors,
    year: String(ref.date || '').match(/\d{4}/)?.[0] || parsed.year,
    url: ref.url || parsed.url,
    identifiers: ids,
  };
}

/** A found record without DOI/arXiv as reference input for the item JSON. */
export function foundToReference(found: FindRefsFound, ref: ReferenceInput): ReferenceInput {
  return {
    ...ref,
    itemType: found.type || ref.itemType,
    title: found.title || ref.title,
    authors: found.authors?.length ? found.authors : ref.authors,
    date: found.year || ref.date,
    publicationTitle: found.venue || ref.publicationTitle,
    url: found.url || ref.url,
  };
}

export function findRefsResolver(identifier: ReferenceResolver): ReferenceResolver {
  return {
    id: 'zotero-reference',
    async resolve(ref, signal) {
      const api = getFindRefsApi();
      if (!api) throw new Error('Find Online References is not installed');
      const parsed = mergeParsed(api.parseReference(ref.text || ref.title || ''), ref);
      const ids = parsed.identifiers;
      if (ids.DOI || ids.arXiv || ids.ISBN || ids.PMID) return null;
      const found = await api.lookup(parsed);
      if (!found) return null;
      const source = `Find Online References${found.source ? ` (${found.source})` : ''}`;
      const { DOI, arXiv } = found.identifiers || {};
      if (DOI || arXiv) {
        const viaId = await identifier.resolve({ ...ref, DOI: DOI || undefined, text: arXiv && !DOI ? `arXiv:${arXiv}` : ref.text }, signal).catch(() => null);
        if (viaId) return { ...viaId, via: 'zotero-reference', detail: `${source}: ${viaId.detail}` };
      }
      return { item: referenceToItemJSON(foundToReference(found, ref)), via: 'zotero-reference', detail: source };
    },
  };
}
