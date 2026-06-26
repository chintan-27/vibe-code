import { readFile } from 'fs/promises'
import { z } from 'zod'
import { resolveWorkspacePath, toWorkspaceRelative } from './path.ts'
import type { ToolDef } from './types.ts'
import { walkFiles } from './walk.ts'

export const grepTool = {
  name: 'Grep',
  description: 'Search text files in the workspace for a regular expression.',
  readOnly: true,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async execute(input, context) {
    const base = resolveWorkspacePath(context.workspaceRoot, input.path ?? '.')
    const regex = new RegExp(input.pattern)
    const matches: string[] = []
    await walkFiles(base, async file => {
      const text = await readFile(file, 'utf8').catch(() => undefined)
      if (text === undefined) return matches.length < (input.limit ?? 100)
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line !== undefined && regex.test(line)) {
          matches.push(`${toWorkspaceRelative(context.workspaceRoot, file)}:${index + 1}:${line}`)
          if (matches.length >= (input.limit ?? 100)) return false
        }
      }
      return true
    })
    return { ok: true, content: matches.join('\n') || '[no matches]' }
  },
} satisfies ToolDef

