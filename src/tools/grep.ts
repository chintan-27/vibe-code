import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { resolveWorkspacePath, toWorkspaceRelative } from './path.ts'
import type { ToolDef } from './types.ts'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'claude-code'])

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
    await walk(base, async file => {
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

async function walk(dir: string, visit: (file: string) => Promise<boolean>): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!(await walk(fullPath, visit))) return false
    } else if (entry.isFile()) {
      if (!(await visit(fullPath))) return false
    }
  }
  return true
}

