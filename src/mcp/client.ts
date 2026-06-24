// Minimal MCP (Model Context Protocol) stdio client. Speaks newline-delimited
// JSON-RPC 2.0 to a server subprocess: initialize → tools/list → tools/call.

import type { Subprocess } from 'bun'

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpToolSpec = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class McpClient {
  private proc: Subprocess<'pipe', 'pipe', 'inherit'> | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buffer = ''

  constructor(private readonly name: string, private readonly config: McpServerConfig) {}

  async start(): Promise<McpToolSpec[]> {
    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ...this.config.env },
    }) as Subprocess<'pipe', 'pipe', 'inherit'>

    void this.readLoop()

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vibe-code', version: '0.1' },
    })
    this.notify('notifications/initialized')

    const listed = (await this.request('tools/list', {})) as { tools?: McpToolSpec[] }
    return listed.tools ?? []
  }

  async callTool(toolName: string, args: unknown): Promise<string> {
    const result = (await this.request('tools/call', { name: toolName, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = (result.content ?? [])
      .map(part => (part.type === 'text' ? part.text ?? '' : `[${part.type}]`))
      .join('\n')
    return text || '(empty result)'
  }

  stop(): void {
    this.proc?.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    this.proc?.stdin.write(body)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP ${this.name}.${method} timed out`))
      }, 15_000)
    })
  }

  private notify(method: string): void {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n')
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) return
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      this.buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.handleMessage(line)
      }
    }
  }

  private handleMessage(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id !== 'number') return // notification from server — ignore
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'))
    else pending.resolve(message.result)
  }
}
