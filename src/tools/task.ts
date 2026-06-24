import { z } from 'zod'
import type { ToolDef } from './types.ts'

const MAX_SPAWN_DEPTH = 2

export const taskTool = {
  name: 'Task',
  description:
    'Delegate a focused, self-contained subtask to a fresh sub-agent (its own tool loop) and get back its final result. Use for independent multi-step work.',
  schema: z.object({
    description: z.string().min(1),
    prompt: z.string().min(1),
  }),
  async execute(input, context) {
    if (!context.client) {
      return { ok: false, content: 'no model client available for subagent' }
    }
    const depth = context.spawnDepth ?? 0
    if (depth >= MAX_SPAWN_DEPTH) {
      return { ok: false, content: `subagent depth limit (${MAX_SPAWN_DEPTH}) reached; do this work directly` }
    }

    // Dynamic import breaks the registry -> session -> registry import cycle.
    const { AgentSession } = await import('@/loop/session.ts')
    const session = new AgentSession({
      client: context.client,
      workspaceRoot: context.workspaceRoot,
      maxTurns: 8,
      spawnDepth: depth + 1,
      permissionMode: 'auto', // delegating the Task was already approved by the parent
    })
    const result = await session.run(input.prompt)
    return {
      ok: true,
      content: `[subagent: ${input.description}] (turns=${result.turns}, tool_calls=${result.toolCalls})\n${result.finalContent}`,
    }
  },
} satisfies ToolDef
