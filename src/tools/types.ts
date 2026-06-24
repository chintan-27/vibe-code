import type { z } from 'zod'
import type { ChatClient } from '@/provider/types.ts'

export type ToolContext = {
  workspaceRoot: string
  signal?: AbortSignal
  /** Present when a tool may itself drive the model (e.g. Task subagents). */
  client?: ChatClient
  /** Subagent nesting depth, used to bound recursion. */
  spawnDepth?: number
  /** Ask the user a clarifying question (provided by interactive surfaces). */
  askUser?: (question: string, options?: string[]) => Promise<string>
}

export type ToolResult = {
  ok: boolean
  content: string
}

export type ToolDef<TSchema extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  schema: TSchema
  /**
   * True for tools that only observe (Read/Glob/Grep/WebFetch/…). Read-only tools
   * are never gated by permissions; mutating tools (Write/Edit/Bash) are.
   */
  readOnly?: boolean
  execute(input: z.infer<TSchema>, context: ToolContext): Promise<ToolResult>
}

export type AnyTool = ToolDef<z.ZodType>

