export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant: the tools the model asked for in this message. */
  toolCalls?: ToolCall[];
  /** Tool: answer to this call (id and name of the call). */
  toolCallId?: string;
  toolName?: string;
}

/** A tool the model may call (function calling); `parameters` is a JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One call the model made; `arguments` already parsed (unparseable JSON: `{ _raw: text }`). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** Result of one model call: the text and the tool calls (empty without tools). */
export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /**
   * Reasoning phase of thinking models (Qwen 3, gpt-oss …), Ollama only. Undefined = server default (for Qwen 3:
   * on, and the reasoning is hidden from us, so the answer starts late). SeekChat sends false for helper calls.
   */
  think?: boolean;
  /** Tools offered to the model; it answers with text, tool calls or both. */
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

/** What the server says about a model's limits (tokens); fields it does not report are missing. */
export interface ModelInfo {
  /** Context window the server is configured to use (Ollama: num_ctx in the Modelfile). */
  configuredContext?: number;
  /** Ollama: context window of the model as loaded right now (/api/ps), i.e. what a request gets. */
  loadedContext?: number;
  /** Maximum context the model supports. */
  maxContext?: number;
  /** Configured answer length (Ollama: num_predict in the Modelfile). */
  numPredict?: number;
}

export interface LlmClient {
  listModels(signal?: AbortSignal): Promise<string[]>;
  modelInfo(model: string, signal?: AbortSignal): Promise<ModelInfo>;
  /** Streams the answer; calls onDelta per text fragment and resolves with the full text. */
  streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string>;
  /** Like streamChat, but also returns the tool calls of the answer (req.tools). */
  streamTurn(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult>;
}

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  allowedRemoteHosts: string[];
  /** Add a certificate exception for an https server whose certificate fails the check (see tls.ts). */
  allowInvalidCerts?: boolean;
}
