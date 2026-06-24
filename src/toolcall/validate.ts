import type { AnyTool } from '@/tools/types.ts'
import { normalizeArgs } from './normalize.ts'
import type { ParsedToolCall } from './parse.ts'

export type ValidToolCall = {
  tool: AnyTool
  input: unknown
  raw: string
}

export type ToolCallValidationResult =
  | { ok: true; calls: ValidToolCall[] }
  | { ok: false; error: string }

export function validateToolCalls(
  calls: ParsedToolCall[],
  tools: Map<string, AnyTool>,
): ToolCallValidationResult {
  const valid: ValidToolCall[] = []

  for (const call of calls) {
    const tool = tools.get(call.name)
    if (!tool) {
      return {
        ok: false,
        error: `unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(', ')}`,
      }
    }

    const normalized = normalizeArgs(call.arguments, tool.schema)
    const parsed = tool.schema.safeParse(normalized)
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid input for ${call.name}: ${parsed.error.message}; received ${JSON.stringify(call.arguments)}`,
      }
    }

    valid.push({ tool, input: parsed.data, raw: call.raw })
  }

  return { ok: true, calls: valid }
}
