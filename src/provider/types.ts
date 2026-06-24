// Provider-level message and request types. Kept deliberately small and
// independent of any vendor SDK — the ollama client speaks these directly.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: Role
  content: string
  /** Present on tool-result messages so the model can correlate calls. */
  toolName?: string
  /** Base64-encoded images for multimodal (vision) models. */
  images?: string[]
}

/** A JSON-schema object passed to ollama's `format` field for constrained decoding. */
export type JsonSchema = Record<string, unknown>

export interface ChatOptions {
  /** Sampling temperature. Reasoning passes want ~0.6; extraction wants ~0. */
  temperature?: number
  /** Hard cap on generated tokens (ollama `num_predict`). */
  maxTokens?: number
  /** Context window to allocate (ollama `num_ctx`). */
  numCtx?: number
  /** Stop sequences. */
  stop?: string[]
  /**
   * Constrained decoding. `'json'` forces any valid JSON; a schema object forces
   * that exact shape. Omit to let the model generate freely (reasoning passes).
   */
  format?: 'json' | JsonSchema
  /** Abort the in-flight request. */
  signal?: AbortSignal
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  /** Total wall-clock for the request, ms. */
  durationMs: number
}

export interface ChatResult {
  content: string
  usage: ChatUsage
  model: string
}

/** One streamed chunk of assistant text. */
export interface ChatChunk {
  content: string
  done: boolean
}

/** Minimal chat surface shared by the agent loop, tools, and subagents. */
export type ChatClient = {
  chat(model: string, messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>
  /** Optional streaming variant; when present, callers may stream display output. */
  chatStream?(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
    onToken?: (delta: string) => void,
  ): Promise<ChatResult>
}
