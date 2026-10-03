/**
 * Tool import_references: the model splits the user's text into references and fills what it can read;
 * each is resolved (resolver chain), checked against the target library, shown as a preview and saved
 * only after the user confirmed. The result tells the model what happened to each one.
 */
import { t, tn } from '../../../i18n';
import { logger } from '../../../util/log';
import type { ToolRunItem } from '../../turn';
import type { Tool, ToolTarget } from '../types';
import { itemLabel, referencesFromArgs, type ReferenceInput } from './reference';
import { resolveWithChain, type ReferenceResolver, type ResolvedReference } from './resolvers';
import { findDuplicate, saveItem, zoteroResolvers } from './zotero-resolvers';

const L = logger('Import');
/** More references in one call are refused (the model is asked to split them). */
export const MAX_REFERENCES = 50;

const STRING = { type: 'string' };

export const IMPORT_REFERENCES_SPEC = {
  name: 'import_references',
  description:
    'Add one or more literature references to the user\'s Zotero library. Use it when the user gives references '
    + '(citations, bibliography entries, DOIs, ISBNs, URLs) to import. Split the text into single references and pass '
    + 'all of them in one call; copy each reference verbatim into "text" and fill only the fields you can read from it '
    + '(never invent data). Zotero looks up DOIs, ISBNs, PMIDs, arXiv ids and web pages itself; the user confirms a '
    + 'preview before anything is saved.',
  parameters: {
    type: 'object',
    properties: {
      references: {
        type: 'array',
        description: 'The references, one object each.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The reference exactly as written by the user.' },
            itemType: {
              type: 'string',
              description: 'journalArticle, book, bookSection, conferencePaper, report, thesis, webpage, newspaperArticle, preprint, dataset, document …',
            },
            title: STRING,
            authors: { type: 'array', items: STRING, description: 'Authors as "Last, First"; organisations as written.' },
            editors: { type: 'array', items: STRING, description: 'Editors as "Last, First".' },
            date: { type: 'string', description: 'Publication date or year as written.' },
            publicationTitle: { type: 'string', description: 'Journal, newspaper or website.' },
            containerTitle: { type: 'string', description: 'Book of a chapter, proceedings of a conference paper.' },
            publisher: STRING,
            place: STRING,
            volume: STRING,
            issue: STRING,
            pages: STRING,
            edition: STRING,
            series: STRING,
            DOI: STRING,
            ISBN: STRING,
            url: STRING,
            accessDate: STRING,
          },
          required: ['text'],
        },
      },
    },
    required: ['references'],
  },
};

interface Candidate {
  ref: ReferenceInput;
  resolved: ResolvedReference | null;
  failures: string[];
  duplicateID?: number;
}

function viaText(c: Candidate): string {
  if (!c.resolved) return t('import.via.none');
  const via = c.resolved.via;
  const base = via === 'identifier' ? t('import.via.identifier', { what: c.resolved.detail || '' })
    : via === 'url' ? t('import.via.url')
    : via === 'text' ? t('import.via.text')
    : t('import.via.other', { source: via });
  return c.failures.length ? `${base} · ${t('import.lookupFailed', { reasons: c.failures.join('; ') })}` : base;
}

/** What the tool needs from Zotero; tests and later sources pass their own. */
export interface ImportDeps {
  /** The resolver chain, asked in order (built per call, so a source switched on meanwhile counts). */
  resolvers(): ReferenceResolver[];
  findDuplicate(item: ResolvedReference['item'], libraryID: number): Promise<{ id: number } | null>;
  save(resolved: ResolvedReference, target: ToolTarget): Promise<{ id: number; getField(f: string): string }>;
}

export const ZOTERO_DEPS: ImportDeps = { resolvers: zoteroResolvers, findDuplicate, save: saveItem };

export function importReferencesTool(deps: ImportDeps = ZOTERO_DEPS): Tool {
  return {
    spec: IMPORT_REFERENCES_SPEC,
    title: (args) => tn('import.title', referencesFromArgs(args).length),
    async run(args, ctx) {
      const refs = referencesFromArgs(args);
      if (!refs.length) return 'Error: no references given. Pass {"references": [{"text": "...", ...}]}.';
      if (refs.length > MAX_REFERENCES) return `Error: at most ${MAX_REFERENCES} references per call; split them into several calls.`;
      const { run, target, signal } = ctx;
      const chain = deps.resolvers();
      const candidates: Candidate[] = [];
      run.items = refs.map((r) => ({ label: r.title || r.text || '?', badge: '…' }));
      for (const [i, ref] of refs.entries()) {
        run.status = t('import.resolving', { i: i + 1, n: refs.length });
        ctx.update();
        const { resolved, failures } = await resolveWithChain(ref, chain, signal);
        const c: Candidate = { ref, resolved, failures };
        if (resolved) {
          const dup = await deps.findDuplicate(resolved.item, target.libraryID).catch(() => null);
          if (dup) c.duplicateID = dup.id;
        }
        candidates.push(c);
        run.items[i] = previewItem(c);
        ctx.update();
      }
      L.info(`${refs.length} references: ${candidates.filter((c) => c.duplicateID).length} already in the library`);
      run.status = t('import.confirm', { target: target.label });
      if (!(await ctx.confirm())) {
        run.state = 'cancelled';
        run.status = t('import.cancelled');
        for (const item of run.items) item.selectable = false;
        return JSON.stringify({ status: 'cancelled by the user', saved: 0 });
      }
      const report: object[] = [];
      let saved = 0;
      run.state = 'running';
      for (const [i, c] of candidates.entries()) {
        const item = run.items[i];
        const chosen = item.checked;
        item.selectable = false;
        const label = item.label;
        if (!chosen || !c.resolved) {
          item.badge = c.duplicateID ? t('import.badge.exists') : t('import.badge.skipped');
          report.push({ reference: label, status: c.duplicateID ? 'already in library, not imported' : 'skipped by the user' });
          continue;
        }
        run.status = t('import.saving', { i: i + 1, n: candidates.length });
        ctx.update();
        try {
          const zItem = await deps.save(c.resolved, target);
          item.itemID = zItem.id;
          item.badge = t('import.badge.saved');
          saved++;
          report.push({ reference: label, status: 'imported', via: c.resolved.via, title: zItem.getField('title') });
        } catch (e: any) {
          item.badge = t('import.badge.failed');
          item.detail = String(e?.message || e);
          report.push({ reference: label, status: 'failed', error: item.detail });
        }
        ctx.update();
      }
      run.state = 'done';
      run.status = tn('import.done', saved, { target: target.label });
      return JSON.stringify({ target: target.label, saved, references: report });
    },
  };
}

function previewItem(c: Candidate): ToolRunItem {
  if (!c.resolved) {
    return { label: c.ref.title || c.ref.text || '?', detail: viaText(c), badge: t('import.badge.failed'), selectable: false, checked: false };
  }
  const dup = c.duplicateID !== undefined;
  return {
    label: itemLabel(c.resolved.item),
    detail: viaText(c),
    badge: dup ? t('import.badge.exists') : c.resolved.via === 'text' ? t('import.badge.text') : t('import.badge.found'),
    selectable: true,
    checked: !dup,
    itemID: c.duplicateID,
  };
}
