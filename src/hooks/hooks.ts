// User-configured shell hooks (settings.json). A PreToolUse hook can block a tool
// by exiting non-zero; PostToolUse hooks observe results. The tool name + input are
// passed as JSON on the hook's stdin and in the VIBE_TOOL env var.

export type HookEvent = 'PreToolUse' | 'PostToolUse'

export type HookRule = {
  /** Regex matched against the tool name; omit to match all tools. */
  matcher?: string
  /** Shell command to run (via `bash -lc`). */
  command: string
}

export type HooksConfig = Partial<Record<HookEvent, HookRule[]>>

export type HookOutcome = { block: boolean; message?: string }

export async function runHooks(
  event: HookEvent,
  toolName: string,
  payload: unknown,
  hooks: HooksConfig | undefined,
  cwd: string,
): Promise<HookOutcome> {
  const rules = hooks?.[event] ?? []
  for (const rule of rules) {
    if (rule.matcher && !safeMatch(rule.matcher, toolName)) continue
    const proc = Bun.spawn(['bash', '-lc', rule.command], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VIBE_TOOL: toolName, VIBE_HOOK_EVENT: event },
    })
    proc.stdin.write(JSON.stringify({ tool: toolName, payload }))
    await proc.stdin.end()
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    // Only PreToolUse can block; a non-zero exit denies the tool.
    if (event === 'PreToolUse' && exitCode !== 0) {
      const message = (stderr.trim() || stdout.trim() || `blocked by hook (exit ${exitCode})`).slice(0, 500)
      return { block: true, message }
    }
  }
  return { block: false }
}

function safeMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return pattern === value
  }
}
