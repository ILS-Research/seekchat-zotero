/**
 * The tool loop of one answer: ask the model with the tools, run the calls it makes, give it the results,
 * ask again – until it answers without calls or the rounds are used up (then once more without tools,
 * so there is always a text answer). Pure: model client, tools and UI hooks come in, no Zotero.
 */
import { stripThinking } from '../llm/stream-parsers';
import type { ChatMessage, ChatRequest, LlmClient, ToolCall } from '../llm/types';
import type { ToolRun, Turn } from '../turn';
import { logger, logError } from '../../util/log';
import type { ToolRegistry } from './registry';
import type { ToolContext } from './types';

const L = logger('Tools');

/** Model rounds with tools per answer; a model that keeps calling tools gets a last round without them. */
export const MAX_TOOL_ROUNDS = 5;

export interface ToolLoopOptions {
  client: LlmClient;
  /** Model settings of every round (messages and tools are set by the loop). */
  request: Omit<ChatRequest, 'messages' | 'tools'>;
  /** System prompt, history and the question; the loop appends tool calls and results. */
  messages: ChatMessage[];
  registry: ToolRegistry;
  answer: Turn;
  notify(): void;
  /** Context for one tool call (target, confirmation) bound to its run. */
  context(run: ToolRun): ToolContext;
  maxRounds?: number;
  /** Called before every model round; may shorten old messages so the conversation fits the context. */
  compact?(messages: ChatMessage[]): void;
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<void> {
  const { client, registry, answer } = opts;
  const messages = [...opts.messages];
  const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
  // Text of earlier rounds stays on screen; each round streams after it.
  let shown = '';
  for (let round = 0; ; round++) {
    opts.compact?.(messages);
    const withTools = round < maxRounds && registry.size > 0;
    let raw = '';
    const result = await client.streamTurn(
      { ...opts.request, messages, ...(withTools ? { tools: registry.specs() } : {}) },
      (delta) => {
        raw += delta;
        answer.content = join(shown, stripThinking(raw));
        opts.notify();
      },
    );
    const text = stripThinking(result.text);
    shown = join(shown, text);
    answer.content = shown;
    opts.notify();
    if (!withTools || !result.toolCalls.length) return;
    messages.push({ role: 'assistant', content: text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      opts.request.signal?.throwIfAborted?.();
      messages.push({ role: 'tool', content: await runCall(call, opts), toolCallId: call.id, toolName: call.name });
    }
  }
}

function join(a: string, b: string): string {
  return a && b ? `${a}\n\n${b}` : a || b;
}

/** Runs one call into a new ToolRun of the answer; errors become the result text (the model can react to them). */
async function runCall(call: ToolCall, opts: ToolLoopOptions): Promise<string> {
  const tool = opts.registry.get(call.name);
  const run: ToolRun = { id: call.id, name: call.name, title: call.name, state: 'running' };
  (opts.answer.toolRuns ??= []).push(run);
  if (!tool) {
    run.state = 'error';
    run.status = `unknown tool ${call.name}`;
    opts.notify();
    return `Error: there is no tool named "${call.name}". Available: ${opts.registry.specs().map((s) => s.name).join(', ')}.`;
  }
  if ('_raw' in call.arguments) {
    run.state = 'error';
    run.status = 'invalid arguments';
    opts.notify();
    return 'Error: the arguments were not valid JSON. Call the tool again with a JSON object matching its schema.';
  }
  try {
    run.title = tool.title(call.arguments);
  } catch {
    // title is cosmetic
  }
  opts.notify();
  L.info(`tool ${call.name} started`);
  try {
    const out = await tool.run(call.arguments, opts.context(run));
    if (run.state === 'running' || run.state === 'confirm') run.state = 'done';
    L.info(`tool ${call.name}: ${run.state}`);
    return out;
  } catch (e: any) {
    if (opts.request.signal?.aborted) {
      run.state = 'cancelled';
      throw e;
    }
    logError(e);
    run.state = 'error';
    run.status = String(e?.message || e);
    return `Error: ${run.status}`;
  } finally {
    opts.notify();
  }
}
