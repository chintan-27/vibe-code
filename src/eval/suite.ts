import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatClient, EffortMode } from '@/loop/agentLoop.ts'
import { runAgentLoop } from '@/loop/agentLoop.ts'

export type EvalCase = {
  name: string
  prompt: string
  setup(workspace: string): Promise<void>
  verify(workspace: string): Promise<boolean>
}

export type EvalResult = {
  name: string
  passed: boolean
  toolCalls: number
  validToolCalls: number
  repairedToolCalls: number
  finalContent: string
}

export const evalCases: EvalCase[] = [
  {
    name: 'bugfix-text-replacement',
    prompt: 'In file.txt, replace hello world with hello agent, then stop.',
    async setup(workspace) {
      await writeFile(join(workspace, 'file.txt'), 'hello world\n', 'utf8')
    },
    async verify(workspace) {
      return (await readFile(join(workspace, 'file.txt'), 'utf8')) === 'hello agent\n'
    },
  },
  {
    name: 'add-function',
    prompt:
      'Create src/math.ts exporting a function add(a: number, b: number) that returns their sum, then stop.',
    async setup(workspace) {
      await mkdir(join(workspace, 'src'), { recursive: true })
    },
    async verify(workspace) {
      const content = await readFile(join(workspace, 'src', 'math.ts'), 'utf8').catch(() => '')
      return /export\s+function\s+add/.test(content) && /return\s+a\s*\+\s*b/.test(content)
    },
  },
  {
    name: 'multi-file-edit',
    prompt:
      'Update src/a.ts and src/b.ts so both exported label constants use the value "updated", then stop.',
    async setup(workspace) {
      await mkdir(join(workspace, 'src'), { recursive: true })
      await writeFile(join(workspace, 'src', 'a.ts'), 'export const label = "old"\n', 'utf8')
      await writeFile(join(workspace, 'src', 'b.ts'), 'export const label = "old"\n', 'utf8')
    },
    async verify(workspace) {
      const a = await readFile(join(workspace, 'src', 'a.ts'), 'utf8')
      const b = await readFile(join(workspace, 'src', 'b.ts'), 'utf8')
      return a.includes('"updated"') && b.includes('"updated"')
    },
  },
]

export async function runEvalSuite(
  client: ChatClient,
  effort: EffortMode = 'low',
): Promise<EvalResult[]> {
  const results: EvalResult[] = []

  const log = (line: string) => process.stderr.write(`${line}\n`)
  for (let i = 0; i < evalCases.length; i += 1) {
    const evalCase = evalCases[i]!
    log(`\n━━ [${i + 1}/${evalCases.length}] ${evalCase.name} ━━ (effort=${effort})`)
    log(`  prompt: ${evalCase.prompt.slice(0, 100)}${evalCase.prompt.length > 100 ? '…' : ''}`)
    const started = performance.now()
    const workspace = await mkdtemp(join(tmpdir(), `vibe-code-eval-${evalCase.name}-`))
    await evalCase.setup(workspace)

    // Verbose, live progress for each case — stream VibeThinker's reasoning as it thinks.
    let thinkChars = 0
    let thinkingHeaderShown = false
    const events = {
      onThink: (t: string) => {
        if (!thinkingHeaderShown) {
          process.stderr.write('\n  \x1b[2m┌ thinking ─────\x1b[0m\n  \x1b[2m')
          thinkingHeaderShown = true
        }
        thinkChars += t.length
        process.stderr.write(t.replace(/\n/g, '\n  ')) // indent reasoning under the header
      },
      onToken: () => {
        if (thinkingHeaderShown) {
          process.stderr.write('\x1b[0m\n  \x1b[2m└──────────────\x1b[0m\n')
          thinkingHeaderShown = false
        }
      },
      onTool: (name: string, input: unknown) => {
        if (thinkingHeaderShown) {
          process.stderr.write('\x1b[0m\n  \x1b[2m└──────────────\x1b[0m\n')
          thinkingHeaderShown = false
        }
        log(`  ⏺ ${name}(${argPreview(input)})`)
      },
      onToolResult: (name: string, ok: boolean, content: string) =>
        log(`  ⎿ ${ok ? 'ok' : 'error'}: ${content.split('\n')[0]?.slice(0, 80) ?? ''}`),
    }

    const loopResult = await runAgentLoop({
      client,
      workspaceRoot: workspace,
      prompt: evalCase.prompt,
      maxTurns: 8,
      effort,
      events,
    })
    const passed = await evalCase.verify(workspace)
    log(
      `  → ${passed ? 'PASS' : 'FAIL'} in ${Math.round((performance.now() - started) / 1000)}s · ${loopResult.turns} turns · ${loopResult.toolCalls} tool calls · ${thinkChars} think chars`,
    )
    if (!passed) log(`    final: ${loopResult.finalContent.slice(0, 160)}`)
    results.push({
      name: evalCase.name,
      passed,
      toolCalls: loopResult.toolCalls,
      validToolCalls: loopResult.validToolCalls,
      repairedToolCalls: loopResult.repairedToolCalls,
      finalContent: loopResult.finalContent,
    })
  }

  return results
}

function argPreview(input: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(input)
    } catch {
      return String(input)
    }
  })()
  return text.length > 70 ? `${text.slice(0, 69)}…` : text
}

export function summarizeEvalResults(results: EvalResult[]): string {
  const passed = results.filter(result => result.passed).length
  const toolCalls = results.reduce((sum, result) => sum + result.toolCalls, 0)
  const validToolCalls = results.reduce((sum, result) => sum + result.validToolCalls, 0)
  const repairedToolCalls = results.reduce((sum, result) => sum + result.repairedToolCalls, 0)
  const validity = toolCalls === 0 ? 0 : validToolCalls / toolCalls
  return [
    `task_success=${passed}/${results.length}`,
    `tool_call_validity=${validToolCalls}/${toolCalls} (${Math.round(validity * 100)}%)`,
    `repaired_tool_calls=${repairedToolCalls}`,
    '',
    ...results.map(
      result =>
        `${result.passed ? 'PASS' : 'FAIL'} ${result.name} tool_calls=${result.toolCalls} valid=${result.validToolCalls} repaired=${result.repairedToolCalls}${result.passed ? '' : ` final=${result.finalContent.slice(0, 300)}`}`,
    ),
  ].join('\n')
}
