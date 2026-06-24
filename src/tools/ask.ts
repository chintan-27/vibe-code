import { z } from 'zod'
import type { ToolDef } from './types.ts'

export const askUserTool = {
  name: 'AskUser',
  // Asking a question changes nothing on disk, so it is never permission-gated.
  readOnly: true,
  description:
    'Ask the user a single clarifying question when the request is ambiguous. Provide options when the answer is a choice. Returns the user\'s answer.',
  schema: z.object({
    question: z.string().min(1),
    options: z.array(z.string()).optional(),
  }),
  async execute(input, context) {
    if (!context.askUser) {
      return { ok: false, content: 'No interactive user is available to answer; proceed with your best judgment.' }
    }
    const answer = await context.askUser(input.question, input.options)
    return { ok: true, content: answer || '(no answer)' }
  },
} satisfies ToolDef
