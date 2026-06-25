import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatUsage,
} from './types.ts'

export type OllamaClientOptions = {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
}

type OllamaChatResponse = {
  model?: string
  message?: {
    content?: string
  }
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  eval_count?: number
  done_reason?: string
  error?: string
}

export class OllamaClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const startedAt = performance.now()
    const response = await this.post(model, messages, options, false)

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`ollama chat failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as OllamaChatResponse
    if (json.error) {
      throw new Error(`ollama chat failed: ${json.error}`)
    }

    return {
      content: json.message?.content ?? '',
      model: json.model ?? model,
      usage: toUsage(json, startedAt),
    }
  }

  /**
   * Streaming variant: invokes `onToken` with each content delta as it arrives and
   * returns the full accumulated result. The agent loop still gets the complete
   * text (for tool-call parsing); streaming only affects display.
   */
  async chatStream(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    onToken: (delta: string) => void = () => {},
  ): Promise<ChatResult> {
    const startedAt = performance.now()
    const response = await this.post(model, messages, options, true)
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '')
      throw new Error(`ollama chat failed (${response.status}): ${body}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let last: OllamaChatResponse = {}

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const part = JSON.parse(line) as OllamaChatResponse
        if (part.error) throw new Error(`ollama chat failed: ${part.error}`)
        const delta = part.message?.content ?? ''
        if (delta) {
          content += delta
          onToken(delta)
        }
        last = part
      }
    }
    const tail = buffer.trim()
    if (tail) {
      const part = JSON.parse(tail) as OllamaChatResponse
      if (part.error) throw new Error(`ollama chat failed: ${part.error}`)
      const delta = part.message?.content ?? ''
      if (delta) {
        content += delta
        onToken(delta)
      }
      last = part
    }

    return { content, model: last.model ?? model, usage: toUsage(last, startedAt) }
  }

  private post(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
    stream: boolean,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream,
        messages: messages.map(toOllamaMessage),
        format: options.format,
        // Keep models resident between turns to avoid reload thrash when alternating models.
        keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '15m',
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
          num_ctx: options.numCtx,
          stop: options.stop,
        },
      }),
      signal: options.signal,
    })
  }
}

function toOllamaMessage(message: ChatMessage): OllamaMessage {
  return {
    role: message.role,
    content:
      message.role === 'tool' && message.toolName
        ? `[${message.toolName} result]\n${message.content}`
        : message.content,
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
  }
}

function toUsage(response: OllamaChatResponse, startedAt: number): ChatUsage {
  return {
    promptTokens: response.prompt_eval_count ?? 0,
    completionTokens: response.eval_count ?? 0,
    doneReason: response.done_reason,
    loadDurationMs:
      typeof response.load_duration === 'number'
        ? Math.round(response.load_duration / 1_000_000)
        : undefined,
    durationMs:
      typeof response.total_duration === 'number'
        ? Math.round(response.total_duration / 1_000_000)
        : Math.round(performance.now() - startedAt),
  }
}
