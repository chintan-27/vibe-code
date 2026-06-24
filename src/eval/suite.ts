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
  effort: EffortMode = 'normal',
): Promise<EvalResult[]> {
  const results: EvalResult[] = []

  for (const evalCase of evalCases) {
    const workspace = await mkdtemp(join(tmpdir(), `vibe-code-eval-${evalCase.name}-`))
    await evalCase.setup(workspace)
    const loopResult = await runAgentLoop({
      client,
      workspaceRoot: workspace,
      prompt: evalCase.prompt,
      maxTurns: 8,
      effort,
    })
    results.push({
      name: evalCase.name,
      passed: await evalCase.verify(workspace),
      toolCalls: loopResult.toolCalls,
      validToolCalls: loopResult.validToolCalls,
      repairedToolCalls: loopResult.repairedToolCalls,
      finalContent: loopResult.finalContent,
    })
  }

  return results
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
