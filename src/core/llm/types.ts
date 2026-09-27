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
  signal?: AbortSignal;
}

export interface LlmClient {
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Streams the answer; calls onDelta per text fragment and resolves with the full text. */
  streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<string>;
}

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  allowedRemoteHosts: string[];
}
