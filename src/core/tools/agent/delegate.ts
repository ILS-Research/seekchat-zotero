/**
 * Tool delegate_task: a subagent. It works through a task on its own, with a fresh conversation and only the
 * read-only tools, and gives back just its result – everything it read stays out of the main chat's context.
 * For many items (a collection, a list of keys) it goes package by package (one subagent each, one after the
 * other: same model, the GPU serves one request at a time) and joins the results. The run has its own cancel
 * button: the main chat then goes on with the results so far. Changes are never made here; the subagent proposes
 * them and the main chat applies them with its own tools (and the user's confirmation).
 */
import { t } from '../../../i18n';
import type { ChatMessage } from '../../llm/types';
import type { ToolRun, Turn } from '../../turn';
import { logger } from '../../../util/log';
import { runToolLoop } from '../loop';
import { ToolRegistry } from '../registry';
import { effectiveOptions } from '../settings';
import type { Tool, ToolContext } from '../types';
import { collectionPaths, cut, findCollection, stringArg } from '../library/summary';
import { collectionNodes, itemByKey, summarize } from '../library/zotero-library';
import { chunk, joinResults, shortenOldToolResults, SUBAGENT_TOOLS, UNTRUSTED_RULE } from './plan';

const L = logger('Subagent');

/** Items per package, model rounds per package. */
export const PACKAGE_SIZE = 20;
/** Model rounds of a package: one per item (reading them one by one) plus some for searching and the answer. */
const subRounds = (items: number) => Math.max(10, items + 5);
const MAX_PACKAGES = 50;

const SUBAGENT_PROMPT = [
  'You are a subagent of SeekChat inside the reference manager Zotero. You work through one task on your own: nobody',
  'answers questions, so do not ask any. Use the read-only tools you have; read only what the task needs (use offset',
  'and limit, read a few pages, not whole documents). Never invent items, keys or facts.',
  UNTRUSTED_RULE,
  'Read several items in one round (several tool calls at once) and read each document only once.',
  'When you are done, answer with the result only, exactly in the requested format, without explanations around it.',
  'If you could not finish, say what is missing in one short line at the end.',
].join('\n');

/** Keys of the regular items in a collection (with subcollections), oldest first. */
function collectionKeys(libraryID: number, ref: string): { keys: string[]; path: string } {
  const found = findCollection(collectionPaths(collectionNodes(libraryID), 10000), ref);
  const root = Zotero.Collections.getByLibraryAndKey(libraryID, found.key);
  const all = [root, ...root.getDescendents(false, 'collection').map((d: any) => Zotero.Collections.get(d.id))];
  const ids = new Set<number>(all.flatMap((c: any) => c.getChildItems(true, false)));
  const items = Zotero.Items.get([...ids]).filter((i: any) => i?.isRegularItem?.() && !i.deleted);
  items.sort((a: any, b: any) => String(a.dateAdded).localeCompare(String(b.dateAdded)));
  return { keys: items.map((i: any) => i.key), path: found.path };
}

/** The read-only tools of the main chat that are switched on (never this tool itself, never changing tools). */
function subagentTools(ctx: ToolContext): ToolRegistry {
  return new ToolRegistry((ctx.tools?.all() || []).filter((tool) => !tool.writes && SUBAGENT_TOOLS.includes(tool.spec.name)));
}

export const delegateTaskTool = (): Tool => ({
  spec: {
    name: 'delegate_task',
    description:
      'Hand a long task to a subagent that works on its own with the read-only tools (search, read items, read documents, '
      + 'reference lists) and returns only its result – use it when the task needs to read a lot, e.g. checking every item '
      + 'of a collection. With "collection" or "keys" the items are split into packages of '
      + `${PACKAGE_SIZE}, one subagent each, and the results are joined. Ask for a compact "result_format" (e.g. a JSON list `
      + 'of proposed changes {key, item_type, fields, reason}); the subagent cannot change anything – apply its proposals '
      + 'yourself with the tools that change items (the user confirms them).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, complete and self-contained (the subagent sees nothing of this chat).' },
        result_format: { type: 'string', description: 'What the result must look like (prefer a JSON list).' },
        collection: { type: 'string', description: 'Collection (name, path or key) whose items to work through, package by package.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Item keys to work through, package by package.' },
      },
      required: ['task'],
    },
  },
  label: () => t('agent.label'),
  description: () => t('agent.description'),
  available: () => true,
  title: (args) => t('agent.title', { task: cut(String(args.task || ''), 60) }),
  async run(args, ctx) {
    const { run } = ctx;
    if (!ctx.llm || !ctx.tools) throw new Error('subagent needs the model of the chat');
    const task = String(args.task || '').trim();
    if (!task) return 'Error: no task given.';
    const format = String(args.result_format || '').trim();
    const libraryID = ctx.target.libraryID;

    let keys: string[] = [];
    let scope = '';
    try {
      if (args.collection) {
        const c = collectionKeys(libraryID, String(args.collection));
        keys = c.keys;
        scope = t('agent.scopeCollection', { path: c.path });
      } else {
        keys = [...new Set(stringArg(args.keys))];
        if (keys.length) scope = t('agent.scopeKeys', { n: keys.length });
      }
    } catch (e: any) {
      run.state = 'error';
      run.status = String(e?.message || e);
      return `Error: ${run.status}`;
    }
    if ((args.collection || args.keys) && !keys.length) {
      run.state = 'done';
      run.status = t('agent.noItems');
      return JSON.stringify({ status: 'no items to work through' });
    }
    const packages = keys.length ? chunk(keys, PACKAGE_SIZE).slice(0, MAX_PACKAGES) : [[]];
    const skippedKeys = keys.slice(MAX_PACKAGES * PACKAGE_SIZE);

    const own = ctx.cancellable?.() ?? ctx.signal;
    const tools = subagentTools(ctx);
    const results: { label: string; text: string }[] = [];
    let calls = 0;
    let cancelled = false;
    run.items = packages.map((p, i) => ({
      label: p.length ? t('agent.package', { i: i + 1, n: p.length }) : t('agent.single'),
      badge: t('agent.badge.waiting'),
    }));
    for (let i = 0; i < packages.length; i++) {
      if (own.aborted) {
        cancelled = !ctx.signal.aborted;
        break;
      }
      const pkg = packages[i];
      const row = run.items[i];
      row.badge = t('agent.badge.running');
      const scratch: Turn = { role: 'assistant', content: '', toolRuns: [] };
      const status = () => {
        const lastRun: ToolRun | undefined = scratch.toolRuns![scratch.toolRuns!.length - 1];
        run.status = [
          packages.length > 1 ? t('agent.progressPackage', { i: i + 1, n: packages.length }) : '',
          t('agent.progressCalls', { n: calls + scratch.toolRuns!.length }),
          lastRun ? t('agent.progressLast', { title: lastRun.title }) : '',
        ].filter(Boolean).join(' · ');
        ctx.update();
      };
      const list = pkg.map((key) => {
        const item = itemByKey(libraryID, key);
        return item?.isRegularItem?.() ? `- ${key}: ${summarize(item).type} – ${summarize(item).label}` : `- ${key}: (not found)`;
      });
      const user = [
        `Task: ${task}`,
        format ? `Result format: ${format}` : '',
        pkg.length ? `Work through exactly these ${pkg.length} items (package ${i + 1} of ${packages.length}${scope ? `, ${scope}` : ''}):\n${list.join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const messages: ChatMessage[] = [{ role: 'system', content: SUBAGENT_PROMPT }, { role: 'user', content: user }];
      status();
      try {
        await runToolLoop({
          client: ctx.llm.client,
          request: { ...ctx.llm.request, signal: own },
          messages,
          registry: tools,
          answer: scratch,
          maxRounds: subRounds(pkg.length),
          finalPrompt: 'You cannot call tools any more. Give your result now, exactly in the requested format, from what you have read; mark items you could not check.',
          notify: status,
          compact: (m) => shortenOldToolResults(m, ctx.llm!.contextChars),
          context: (subRun) => {
            const tool = tools.get(subRun.name);
            return {
              target: ctx.target,
              options: tool ? effectiveOptions(tool) : {},
              signal: own,
              run: subRun,
              update: status,
              confirm: async () => false,
            };
          },
        });
        results.push({ label: row.label, text: scratch.content.trim() });
        row.badge = t('agent.badge.done');
        row.detail = cut(scratch.content, 300);
      } catch (e: any) {
        if (ctx.signal.aborted) throw e;
        if (own.aborted) {
          cancelled = true;
          row.badge = t('agent.badge.cancelled');
          if (scratch.content.trim()) results.push({ label: `${row.label} (${t('agent.partial')})`, text: scratch.content.trim() });
          break;
        }
        L.error(`package ${i + 1}: ${e?.message || e}`);
        row.badge = t('agent.badge.failed');
        row.detail = String(e?.message || e);
        results.push({ label: row.label, text: `Error: ${String(e?.message || e)}` });
      } finally {
        calls += scratch.toolRuns!.length;
      }
    }
    for (const row of run.items) if (row.badge === t('agent.badge.waiting')) row.badge = t('agent.badge.notRun');
    const done = results.filter((r) => !r.text.startsWith('Error:')).length;
    const openKeys = packages.slice(results.length).flat().concat(skippedKeys);
    run.state = cancelled ? 'cancelled' : done ? 'done' : 'error';
    run.status = cancelled
      ? t('agent.cancelledStatus', { done: results.length, n: packages.length })
      : t('agent.doneStatus', { n: packages.length, calls });
    L.info(`${packages.length} packages, ${results.length} results, ${calls} tool calls${cancelled ? ', cancelled by the user' : ''}`);
    return JSON.stringify({
      ...(cancelled ? { status: 'cancelled by the user; results so far' } : {}),
      packages: packages.length,
      finished: results.length,
      ...(openKeys.length ? { notWorkedThrough: openKeys } : {}),
      result: joinResults(results),
    });
  },
});
