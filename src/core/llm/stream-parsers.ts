/** Pure parsers for streaming chat responses (no I/O), unit-tested. */
import type { ChatMessage, ToolCall, ToolSpec } from './types';

export interface StreamEvent {
  delta?: string;
  done?: boolean;
  error?: string;
  /** Fragments of tool calls, joined by ToolCallAccumulator. */
  toolDeltas?: ToolCallDelta[];
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** Tool arguments as an object; a model that sent broken JSON gets `{ _raw }`, which the tool reports back. */
export function parseToolArguments(args: unknown): Record<string, any> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, any>;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _raw: args };
  } catch {
    return { _raw: args };
  }
}

/** Joins the streamed fragments of OpenAI tool calls (name and id once, arguments in pieces) per index. */
export class ToolCallAccumulator {
  private calls: { id: string; name: string; args: string }[] = [];

  push(deltas: ToolCallDelta[]): void {
    for (const d of deltas) {
      const c = (this.calls[d.index] ??= { id: '', name: '', args: '' });
      if (d.id) c.id = d.id;
      if (d.name) c.name += d.name;
      if (d.arguments) c.args += d.arguments;
    }
  }

  result(): ToolCall[] {
    return this.calls.filter((c) => c && c.name).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseToolArguments(c.args) }));
  }
}

/** Tools in the `{ type: 'function', function }` form both APIs accept. */
export function toolsPayload(tools: ToolSpec[] | undefined): object {
  return tools?.length ? { tools: tools.map((t) => ({ type: 'function', function: t })) } : {};
}

/** Messages for /chat/completions (tool calls with JSON string arguments, tool results with tool_call_id). */
export function openAiMessages(messages: ChatMessage[]): object[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId || '' };
    if (m.toolCalls?.length) {
      return {
        role: m.role,
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Splits a byte-stream-decoded text into complete lines, keeping the partial tail. */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** One line of an OpenAI-compatible Server-Sent-Events stream. */
export function parseSseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true };
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (json.error) return { error: typeof json.error === 'string' ? json.error : json.error.message || 'server error' };
  const choice = json.choices?.[0];
  const delta = choice?.delta?.content;
  const calls = choice?.delta?.tool_calls;
  const ev: StreamEvent = {
    delta: typeof delta === 'string' && delta ? delta : undefined,
    done: choice?.finish_reason ? true : undefined,
  };
  if (Array.isArray(calls) && calls.length) {
    ev.toolDeltas = calls.map((c: any, i: number) => ({
      index: typeof c.index === 'number' ? c.index : i,
      id: c.id || undefined,
      name: c.function?.name || undefined,
      arguments: typeof c.function?.arguments === 'string' ? c.function.arguments
        : c.function?.arguments ? JSON.stringify(c.function.arguments) : undefined,
    }));
  }
  return ev;
}

/**
 * Removes reasoning blocks (<think>...</think>) that some models (Qwen 3,
 * DeepSeek R1) emit inline. An unclosed block at the end - still streaming -
 * is hidden as well.
 */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = out.indexOf('<think>');
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, '');
}
