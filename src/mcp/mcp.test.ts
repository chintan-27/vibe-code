import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { McpClient } from './client.ts'
import { jsonSchemaToZod, loadMcpTools } from './tools.ts'

const mockServer = join(import.meta.dir, '_mockServer.ts')
const serverConfig = { command: 'bun', args: ['run', mockServer] }

describe('MCP client', () => {
  test('initializes, lists, and calls tools over stdio JSON-RPC', async () => {
    const client = new McpClient('mock', serverConfig)
    const tools = await client.start()
    expect(tools.map(t => t.name)).toContain('echo')
    const output = await client.callTool('echo', { text: 'hello mcp' })
    expect(output).toBe('hello mcp')
    client.stop()
  })

  test('loadMcpTools wraps servers as namespaced Vibe tools', async () => {
    const runtime = await loadMcpTools({ mock: serverConfig })
    const echo = runtime.tools.find(t => t.name === 'mcp__mock__echo')
    expect(echo).toBeDefined()
    expect(echo?.readOnly).toBe(false)
    const result = await echo!.execute({ text: 'wrapped' }, { workspaceRoot: '/' })
    expect(result.content).toBe('wrapped')
    runtime.close()
  })
})

describe('jsonSchemaToZod', () => {
  test('builds an object schema with required/optional fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    })
    expect(schema.safeParse({ a: 'x' }).success).toBe(true)
    expect(schema.safeParse({ b: 1 }).success).toBe(false) // missing required 'a'
  })
})
