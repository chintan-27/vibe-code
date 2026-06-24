import { z } from 'zod'
import type { ToolDef } from './types.ts'

const todoWriteSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'completed']),
    }),
  ),
})

type TodoWriteInput = z.infer<typeof todoWriteSchema>

export const todoWriteTool = {
  name: 'TodoWrite',
  description: 'Record the current task checklist for the session.',
  readOnly: true,
  schema: todoWriteSchema,
  async execute(input: TodoWriteInput) {
    return {
      ok: true,
      content: input.todos.map(todo => `- [${todo.status}] ${todo.content}`).join('\n'),
    }
  },
} satisfies ToolDef
