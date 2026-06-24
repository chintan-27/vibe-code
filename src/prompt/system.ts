import { z } from 'zod'
import type { AnyTool } from '@/tools/types.ts'

export function buildSystemPrompt(tools: AnyTool[]): string {
  return `You are Vibe Code, a local coding agent. Work only inside the current workspace.

To act, emit ONE tool call as a single JSON object on its own, in exactly this shape:
{"name":"ToolName","arguments":{ ... }}

Rules:
- Use the exact argument names shown for each tool below.
- All file paths must be workspace-relative (e.g. "src/app.ts"), never absolute or "/path/to/...".
- Use Write to create or overwrite a file. Use Edit only to replace an exact, unique string in an existing file — Read the file first if unsure of the exact text.
- Emit one tool call per turn. After you see its result, decide the next step.
- When the task is done and no tool is needed, reply in plain prose with no JSON.

Tools:
${tools.map(describeTool).join('\n')}

Example:
{"name":"Read","arguments":{"file_path":"src/app.ts"}}`
}

function describeTool(tool: AnyTool): string {
  const params = describeParams(tool.schema)
  return `- ${tool.name}(${params}) — ${tool.description}`
}

function describeParams(schema: z.ZodType): string {
  if (!(schema instanceof z.ZodObject)) return ''
  const shape = schema.shape as Record<string, z.ZodType>
  return Object.entries(shape)
    .map(([key, field]) => `${key}${isOptional(field) ? '?' : ''}: ${describeType(field)}`)
    .join(', ')
}

function isOptional(schema: z.ZodType): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
}

function describeType(schema: z.ZodType): string {
  let inner: z.ZodType = schema
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
    inner = inner._def.innerType as z.ZodType
  }
  if (inner instanceof z.ZodString) return 'string'
  if (inner instanceof z.ZodNumber) return 'number'
  if (inner instanceof z.ZodBoolean) return 'boolean'
  if (inner instanceof z.ZodEnum) {
    return (inner._def.values as string[]).map(value => `"${value}"`).join('|')
  }
  if (inner instanceof z.ZodArray) return `${describeType(inner._def.type as z.ZodType)}[]`
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>
    return `{${Object.keys(shape).join(', ')}}`
  }
  return 'value'
}
