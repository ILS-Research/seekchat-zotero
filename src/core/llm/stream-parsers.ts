/** Pure parsers for streaming chat responses (no I/O), unit-tested. */

export interface StreamEvent {
  delta?: string;
  done?: boolean;
  error?: string;
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
  return {
    delta: typeof delta === 'string' && delta ? delta : undefined,
    done: choice?.finish_reason ? true : undefined,
  };
}

/** One line of Ollama's NDJSON /api/chat stream. */
export function parseOllamaLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (json.error) return { error: String(json.error) };
  const delta = json.message?.content;
  return {
    delta: typeof delta === 'string' && delta ? delta : undefined,
    done: json.done === true ? true : undefined,
  };
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
