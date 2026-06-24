import { z } from 'zod'
import type { ToolDef } from './types.ts'

const REJECTED_PATTERNS = [
  /\brm\s+-[^&|;]*r/,
  /\bsudo\b/,
  /\bcurl\b/,
  /\bwget\b/,
  />\s*\/|\s\/dev\/(disk|rdisk)/,
]

export const bashTool = {
  name: 'Bash',
  description: 'Run a non-destructive shell command in the workspace.',
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  }),
  async execute(input, context) {
    const rejected = REJECTED_PATTERNS.find(pattern => pattern.test(input.command))
    if (rejected) {
      return { ok: false, content: `command rejected by workspace-safe policy: ${rejected}` }
    }

    const proc = Bun.spawn(['bash', '-lc', input.command], {
      cwd: context.workspaceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: context.signal,
    })
    const timeout = setTimeout(() => proc.kill(), input.timeoutMs ?? 30000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timeout))

    return {
      ok: exitCode === 0,
      content: [`exit ${exitCode}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
    }
  },
} satisfies ToolDef

