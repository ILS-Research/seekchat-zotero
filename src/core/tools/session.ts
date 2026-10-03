/**
 * The tool chat: a general chat whose model may use Zotero tools (tools/index.ts). One session for the
 * Zotero session, in memory only. Questions run through the tool loop (loop.ts); a tool that asks for
 * confirmation waits here until the user answers in the window (or stops the chat).
 */
import { createClient } from '../llm';
import type { ChatMessage } from '../llm/types';
import { t } from '../../i18n';
import { UserFacingError } from '../errors';
import { resolveLimits } from '../limits';
import { historyPairs, type ToolRun, type Turn } from '../turn';
import { readPrefs } from '../../prefs';
import { newAbortController } from '../../util/env';
import { content, logError, logger } from '../../util/log';
import { runToolLoop } from './loop';
import { ToolRegistry } from './registry';
import { effectiveOptions, isToolEnabled } from './settings';
import type { ToolTarget } from './types';
import { defaultRegistry } from './index';

const L = logger('ToolChat');

export const TOOL_SYSTEM_PROMPT = [
  'You are SeekChat, an assistant inside the reference manager Zotero. You can act in Zotero through the tools you are given.',
  'Use a tool when the user asks for something it does; otherwise answer directly and briefly.',
  'To answer questions about the user\'s library ("do I have …", "what is in collection …"), search it with search_library '
  + 'and read items with get_item; for "these items", "this collection" or a marked passage use get_selection first.',
  'To put found items into a collection (also a new one), call save_to_collection with their keys; the user confirms it.',
  'Name only items a tool returned; refer to them by author, year and title (the user sees them linked in the tool results).',
  'When the user gives literature references to add (citations, a bibliography, DOIs, ISBNs, URLs), call import_references once with all of them.',
  'Never claim that something was done unless a tool result says so. After a tool result, tell the user in a few words what happened.',
  'Answer in the language of the user.',
].join('\n');

/** System prompt with today's date (for "this year", "added recently"). */
export function toolSystemPrompt(today = new Date()): string {
  return `${TOOL_SYSTEM_PROMPT}\nToday is ${today.toISOString().slice(0, 10)}.`;
}

export class ToolChatSession {
  turns: Turn[] = [];
  private abortCtrl: AbortController | null = null;
  private listeners = new Set<() => void>();
  /** Runs waiting for the user's confirmation and how to continue them. */
  private waiting = new Map<ToolRun, (ok: boolean) => void>();

  constructor(private tools: ToolRegistry = defaultRegistry()) {}

  get busy(): boolean {
    return this.abortCtrl !== null;
  }

  /** All tools, switched on or not (the window lists them). */
  get registry(): ToolRegistry {
    return this.tools;
  }

  /** The tools switched on, for one question. */
  enabledTools(): ToolRegistry {
    return new ToolRegistry(this.tools.all().filter((tool) => isToolEnabled(tool.spec.name)));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch (e) { logError(e); }
    }
  }

  stop(): void {
    this.abortCtrl?.abort();
    for (const resume of this.waiting.values()) resume(false);
    this.waiting.clear();
  }

  clear(): void {
    this.stop();
    this.turns = [];
    this.notify();
  }

  /** The user's answer to a run in state "confirm" (true: go on with the checked items). */
  confirm(run: ToolRun, ok: boolean): void {
    const resume = this.waiting.get(run);
    if (!resume) return;
    this.waiting.delete(run);
    resume(ok);
  }

  /** Checks or unchecks one item of a run waiting for confirmation. */
  toggleItem(run: ToolRun, index: number, checked: boolean): void {
    const item = run.items?.[index];
    if (!item?.selectable || run.state !== 'confirm') return;
    item.checked = checked;
    this.notify();
  }

  async ask(question: string, target: ToolTarget): Promise<void> {
    const q = question.trim();
    if (this.busy || !q) return;
    const prefs = readPrefs();
    const history = historyPairs(this.turns, prefs.historyTurns);
    const answer: Turn = { role: 'assistant', content: '', pending: true, toolRuns: [] };
    this.turns.push({ role: 'user', content: q }, answer);
    const ctrl = newAbortController();
    this.abortCtrl = ctrl;
    this.notify();
    L.info(`question (target ${target.label}): ${content(q)}`);
    try {
      if (!prefs.model) throw new UserFacingError(t('error.noModel'));
      const limits = await resolveLimits(prefs);
      const registry = this.enabledTools();
      const messages: ChatMessage[] = [{ role: 'system', content: toolSystemPrompt() }, ...history, { role: 'user', content: q }];
      L.info(`tools: ${registry.specs().map((x) => x.name).join(', ') || 'none'}`);
      await runToolLoop({
        client: createClient(prefs),
        request: {
          model: prefs.model,
          temperature: prefs.temperature,
          maxTokens: limits.maxTokens,
          think: prefs.thinking,
          signal: ctrl.signal,
        },
        messages,
        registry,
        answer,
        notify: () => this.notify(),
        context: (run) => ({
          target,
          options: effectiveOptions(registry.get(run.name)!),
          signal: ctrl.signal,
          run,
          update: () => this.notify(),
          confirm: () => new Promise<boolean>((resolve) => {
            if (ctrl.signal.aborted) return resolve(false);
            run.state = 'confirm';
            this.waiting.set(run, (ok) => {
              if (run.state === 'confirm') run.state = 'running';
              resolve(ok);
            });
            this.notify();
          }),
        }),
      });
      if (!answer.content.trim() && !answer.toolRuns?.length) answer.content = t('common.noAnswer');
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        answer.cancelled = true;
        answer.content = (answer.content ? answer.content + '\n' : '') + t('common.cancelled');
      } else {
        if (!(e instanceof UserFacingError)) logError(e);
        answer.error = true;
        answer.content = t('common.error', { message: toolErrorMessage(e) });
      }
    } finally {
      for (const run of answer.toolRuns || []) {
        if (run.state === 'running' || run.state === 'confirm') run.state = 'cancelled';
        for (const item of run.items || []) item.selectable = false;
      }
      answer.pending = false;
      this.waiting.clear();
      this.abortCtrl = null;
      this.notify();
    }
  }
}

/** Servers without function calling say so in different words; the user gets one hint. */
export function toolErrorMessage(e: any): string {
  const msg = String(e?.message || e);
  return /does not support tools|tool[s_ ]*(?:calling|use)?[^\n]*not supported|unsupported[^\n]*tool/i.test(msg) ? `${msg} – ${t('tools.unsupported')}` : msg;
}

let session: ToolChatSession | null = null;

export function getToolSession(): ToolChatSession {
  return (session ??= new ToolChatSession());
}

export function stopToolSession(): void {
  session?.stop();
  session = null;
}
