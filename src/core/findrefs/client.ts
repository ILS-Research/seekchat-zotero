/**
 * The plugin "Find Online References" (ILS fork of zotero-reference, AGPL) through its public API
 * `Zotero.FindOnlineReferences.api` – called at runtime only, no code of it in SeekChat (MIT).
 * Nothing outside src/core/findrefs/ and its resolver may assume the plugin is installed.
 */

export interface FindRefsParsed {
  text: string;
  title?: string;
  authors: string[];
  year?: string;
  publicationVenue?: string;
  identifiers: { DOI?: string; arXiv?: string; ISBN?: string; PMID?: string };
  url?: string;
  type?: string;
}

export interface FindRefsFound {
  title?: string;
  authors: string[];
  year?: string;
  identifiers: { DOI?: string; arXiv?: string; ISBN?: string; PMID?: string };
  url?: string;
  type?: string;
  venue?: string;
  abstract?: string;
  source?: string;
}

export interface FindRefsDocumentReference extends FindRefsParsed {
  number: number;
}

export interface FindRefsDocumentReferences {
  attachmentKey: string;
  itemKey: string;
  source: 'cache' | 'pdf';
  references: FindRefsDocumentReference[];
}

export interface FindRefsApi {
  version: number;
  parseReference(text: string): FindRefsParsed;
  lookup(reference: string | FindRefsParsed): Promise<FindRefsFound | undefined>;
  /** Since 0.7.36: reference list of a document (regular item or PDF), parsed from the PDF. */
  getReferences?(item: any, opts?: { refresh?: boolean }): Promise<FindRefsDocumentReferences | undefined>;
  findInLibrary?(reference: Partial<FindRefsParsed>): Promise<any | undefined>;
}

/** The API with getReferences (Find Online References 0.7.36+), or null. */
export function getFindRefsListApi(): (FindRefsApi & Required<Pick<FindRefsApi, 'getReferences'>>) | null {
  const api = getFindRefsApi();
  return api && typeof api.getReferences === 'function' ? (api as any) : null;
}

/** The API, if the plugin is installed, enabled and new enough (v1). */
export function getFindRefsApi(): FindRefsApi | null {
  const api = (typeof Zotero !== 'undefined' ? Zotero : undefined)?.FindOnlineReferences?.api;
  return api && Number(api.version) >= 1 && typeof api.parseReference === 'function' ? api : null;
}
