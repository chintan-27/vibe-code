import { readFile, writeFile } from 'fs/promises'
import { z } from 'zod'
import { resolveWorkspacePath } from './path.ts'
import type { ToolDef } from './types.ts'

export const editTool = {
  name: 'Edit',
  description: 'Replace exactly one occurrence of old_string in a workspace file.',
  schema: z.object({
    file_path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
  }),
  async execute(input, context) {
    const filePath = resolveWorkspacePath(context.workspaceRoot, input.file_path)
    const text = await readFile(filePath, 'utf8')
    const first = text.indexOf(input.old_string)
    if (first === -1) {
      return { ok: false, content: 'old_string was not found' }
    }
    const second = text.indexOf(input.old_string, first + input.old_string.length)
    if (second !== -1) {
      return { ok: false, content: 'old_string appears more than once; provide a unique match' }
    }
    await writeFile(filePath, text.replace(input.old_string, input.new_string), 'utf8')
    return { ok: true, content: `edited ${input.file_path}` }
  },
} satisfies ToolDef

