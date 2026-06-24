import { z } from 'zod'
import type { AnyTool } from '@/tools/types.ts'
import { McpClient, type McpServerConfig, type McpToolSpec } from './client.ts'

export type McpRuntime = {
  tools: AnyTool[]
  /** Shut down all spawned MCP servers. */
  close: () => void
}

/**
 * Start every configured MCP server, list its tools, and wrap them as Vibe tools
 * named `mcp__<server>__<tool>`. Returns the tools plus a close() to stop servers.
 */
export async function loadMcpTools(servers: Record<string, McpServerConfig> | undefined): Promise<McpRuntime> {
  const clients: McpClient[] = []
  const tools: AnyTool[] = []
  for (const [serverName, config] of Object.entries(servers ?? {})) {
    const client = new McpClient(serverName, config)
    try {
      const specs = await client.start()
      clients.push(client)
      for (const spec of specs) tools.push(wrapTool(serverName, spec, client))
    } catch (error) {
      // A broken server shouldn't crash the session; skip it.
      client.stop()
      console.error(`MCP server "${serverName}" failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { tools, close: () => clients.forEach(c => c.stop()) }
}

function wrapTool(serverName: string, spec: McpToolSpec, client: McpClient): AnyTool {
  return {
    name: `mcp__${serverName}__${spec.name}`,
    description: spec.description ?? `MCP tool ${spec.name} from ${serverName}`,
    // External side effects unknown → treat as mutating so it is permission-gated.
    readOnly: false,
    schema: jsonSchemaToZod(spec.inputSchema),
    async execute(input) {
      const content = await client.callTool(spec.name, input)
      return { ok: true, content }
    },
  }
}

/** Best-effort JSON-Schema → zod for top-level object properties (loose; passthrough). */
export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodType {
  if (!schema || schema.type !== 'object' || typeof schema.properties !== 'object') {
    return z.object({}).passthrough()
  }
  const properties = schema.properties as Record<string, { type?: string }>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(properties)) {
    const base = zodForType(prop?.type)
    shape[key] = required.has(key) ? base : base.optional()
  }
  return z.object(shape).passthrough()
}

function zodForType(type: string | undefined): z.ZodType {
  switch (type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(z.any())
    case 'object':
      return z.record(z.any())
    default:
      return z.any()
  }
}
