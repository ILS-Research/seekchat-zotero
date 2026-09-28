/**
 * A context provider turns a question into the document text the model sees.
 * Step 2 of the plan has one provider (a single PDF); library chat (ZotSeek
 * passages) and collections plug in here later.
 */
import type { FitInfo } from './fit';
import type { Outline } from './outline';
import type { LibrarySource } from '../library/sources';

export interface Page {
  /** 1-based physical page number (not the printed page label). */
  pageNumber: number;
  text: string;
}

export interface ContextBlock {
  /** Short description of the source, e.g. "Müller 2021 – Titel". */
  title: string;
  /** Full text handed to the model, sections marked with [Seite N]. */
  body: string;
  mode: 'full' | 'excerpt';
  includedPages: number[];
  totalPages: number;
  /** Excerpt mode: pages with a keyword hit, and whether nothing matched at all. */
  matchedPages?: number;
  noMatches?: boolean;
  /** Strategy "chapters": titles of the chosen chapters, and whether they were sent completely. */
  chapters?: { titles: string[]; complete: boolean };
  /** Library chat: numbered sources (body holds them formatted); citations are [n, S. x]. */
  library?: {
    sources: LibrarySource[];
    /** Search scope for meta line and prompt, e.g. "Collection „Stadtklima“". */
    scope: string;
    passagesUsed: number;
    withoutText: number;
    overBudget: number;
  };
}

export interface BuildOptions {
  /** Extra search terms from the model (long-document strategy "keywords"). */
  keywords?: string[];
  /** Strategy "chapters": search only these pages (1-based); titles are for prompt and UI. */
  chapters?: ChapterScope;
}

export interface ChapterScope {
  titles: string[];
  pages: number[];
}

/** How to deal with documents that do not fit into the context. */
export type LongDocStrategy = 'vector' | 'keywords' | 'chapters';

export interface ContextProvider {
  /** Stable key for sessions, e.g. "pdf:1234". */
  readonly key: string;
  /** Short description of the source for prompts and the UI. */
  describe(): string;
  analyze(budgetChars: number): Promise<FitInfo>;
  /** Raw value of the item's "Language" field ('' if empty). */
  metadataLanguage(): string;
  /** Beginning of the document (first pages, each shortened) for language detection. */
  sampleText(maxChars: number): Promise<string>;
  outline(): Promise<Outline>;
  build(query: string, budgetChars: number, opts?: BuildOptions): Promise<ContextBlock>;
}
