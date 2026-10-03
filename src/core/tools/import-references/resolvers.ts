/**
 * How a reference becomes an item: a chain of resolvers, asked in order; the first that knows the
 * reference wins. Zotero's own (zotero-resolvers.ts): identifier lookup, web translators, the model's
 * fields. Further sources (zotero-reference, Crossref …) are new resolvers put in front of the chain.
 */
import type { ItemJSON, ReferenceInput } from './reference';

/** How the item was found, shown in the preview. */
export type ResolvedVia = 'identifier' | 'url' | 'text' | (string & {});

export interface ResolvedReference {
  item: ItemJSON;
  via: ResolvedVia;
  /** What was looked up ("DOI 10.1000/x"), for the preview. */
  detail?: string;
}

export interface ReferenceResolver {
  readonly id: string;
  /** The item for this reference, or null when this resolver cannot tell (the next one is asked). */
  resolve(ref: ReferenceInput, signal: AbortSignal): Promise<ResolvedReference | null>;
}

export interface ChainResult {
  resolved: ResolvedReference | null;
  /** Resolvers that failed on the way ("identifier: HTTP 404"); a later one may still have succeeded. */
  failures: string[];
}

/** Asks the resolvers in order; errors are collected and the next is asked (aborting stops the chain). */
export async function resolveWithChain(ref: ReferenceInput, resolvers: ReferenceResolver[], signal: AbortSignal): Promise<ChainResult> {
  const failures: string[] = [];
  for (const r of resolvers) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    try {
      const resolved = await r.resolve(ref, signal);
      if (resolved) return { resolved, failures };
    } catch (e: any) {
      if (signal.aborted) throw e;
      failures.push(`${r.id}: ${String(e?.message || e)}`);
    }
  }
  return { resolved: null, failures };
}
