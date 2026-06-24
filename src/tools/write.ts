import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { resolveWorkspacePath } from './path.ts'
import type { ToolDef } from './types.ts'

export const writeTool = {
  name: 'Write',
  description: 'Write a UTF-8 text file inside the workspace, creating parent directories.',
  schema: z.object({
    file_path: z.string().min(1),
    content: z.string(),
  }),
  async execute(input, context) {
    const filePath = resolveWorkspacePath(context.workspaceRoot, input.file_path)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, input.content, 'utf8')
    return { ok: true, content: `wrote ${input.file_path}` }
  },
} satisfies ToolDef

