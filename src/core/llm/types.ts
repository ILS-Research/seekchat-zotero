export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  /** Context window in tokens; honored by providers that accept it (Ollama). */
  numCtx?: number;
  /**
   * Reasoning phase of thinking models (Qwen 3, gpt-oss …), Ollama only. Undefined = server default (for Qwen 3:
   * on, and the reasoning is hidden from us, so the answer starts late). SeekChat sends false for helper calls.
   */
  think?: boolean;
  signal?: AbortSignal;
}

/** What the server says about a model's limits (tokens); fields it does not report are missing. */
export interface ModelInfo {
  /** Context window the server is configured to use (Ollama: num_ctx in the Modelfile). */
  configuredContext?: number;
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
}

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  allowedRemoteHosts: string[];
}
