import { z } from 'zod'
import { resolveWorkspacePath } from './path.ts'
import type { ToolDef } from './types.ts'

export const astEditTool = {
  name: 'AstEdit',
  description: 'Apply a syntax-aware ast-grep rewrite to one workspace file. Use dryRun first for risky structural edits.',
  schema: z.object({
    file_path: z.string().min(1),
    lang: z.string().min(1),
    pattern: z.string().min(1),
    rewrite: z.string().min(1),
    dryRun: z.boolean().optional(),
  }),
  async execute(input, context) {
    const filePath = resolveWorkspacePath(context.workspaceRoot, input.file_path)
    const args = [
      'run',
      '--pattern',
      input.pattern,
      '--rewrite',
      input.rewrite,
      '--lang',
      input.lang,
      input.dryRun ? '--dry-run' : '--update-all',
      filePath,
    ]
    const proc = Bun.spawn(['ast-grep', ...args], {
      cwd: context.workspaceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: context.signal,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {
      ok: exitCode === 0,
      content: [`exit ${exitCode}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
    }
  },
} satisfies ToolDef
