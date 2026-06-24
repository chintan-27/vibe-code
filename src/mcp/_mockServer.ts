// A minimal MCP stdio server used only by mcp.test.ts. Speaks newline-delimited
// JSON-RPC 2.0 and exposes a single `echo` tool.

function reply(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

for await (const line of console) {
  const trimmed = line.trim()
  if (!trimmed) continue
  const message = JSON.parse(trimmed) as { id?: number; method?: string; params?: { arguments?: { text?: string } } }
  if (typeof message.id !== 'number') continue // notification

  if (message.method === 'initialize') {
    reply(message.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } })
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo the provided text',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ],
    })
  } else if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? '') }] })
  } else {
    reply(message.id, {})
  }
}
