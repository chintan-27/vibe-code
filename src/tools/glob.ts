import { z } from 'zod'
import { resolveWorkspacePath, toWorkspaceRelative } from './path.ts'
import type { ToolDef } from './types.ts'
import { walkFiles } from './walk.ts'

export const globTool = {
  name: 'Glob',
  description: 'List workspace files matching a simple substring or * pattern.',
  readOnly: true,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async execute(input, context) {
    const base = resolveWorkspacePath(context.workspaceRoot, input.path ?? '.')
    const matcher = toMatcher(input.pattern)
    const matches: string[] = []
    await walkFiles(base, async file => {
      const rel = toWorkspaceRelative(context.workspaceRoot, file)
      if (matcher(rel)) matches.push(rel)
      return matches.length < (input.limit ?? 100)
    })
    return { ok: true, content: matches.join('\n') || '[no matches]' }
  },
} satisfies ToolDef

function toMatcher(pattern: string): (value: string) => boolean {
  if (!pattern.includes('*')) return value => value.includes(pattern)
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')
  const regex = new RegExp(`^${escaped}$`)
  return value => regex.test(value)
}

