import { dumpContext } from '@/context/budget.ts'
import type { HooksConfig } from '@/hooks/hooks.ts'
import { AgentSession } from '@/loop/session.ts'
import type { EffortMode, SessionEvents } from '@/loop/types.ts'
import { loadMemories } from '@/memory/memdir.ts'
import { OllamaClient } from '@/provider/ollama.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'
import { coreTools } from '@/tools/registry.ts'
import type { AnyTool } from '@/tools/types.ts'

export type ReplOptions = {
  workspaceRoot: string
  effort: EffortMode
  allow?: string[]
  hooks?: HooksConfig
  extraTools?: AnyTool[]
}

const COMMIT_PROMPT =
  'Commit the current changes. First run `git status` and `git diff --staged` (and `git add -A` if nothing is staged) using Bash, then write a clear commit message and run `git commit`. Show the message you used.'
const REVIEW_PROMPT =
  'Review the current working-tree changes. Run `git diff` (and `git status`) using Bash, then summarize the changes and flag any bugs or risks. Do not modify files.'

const PROMPT = '› '

export async function runRepl(options: ReplOptions): Promise<void> {
  const client = new OllamaClient()
  let effort = options.effort
  let streamed = ''
  const events: SessionEvents = {
    onToken: text => {
      streamed += text
      process.stdout.write(text)
    },
    onTool: (name, input) => process.stdout.write(`\n⏺ ${name}(${summarizeArgs(input)})\n`),
    onToolResult: (name, ok) => {
      if (!ok) process.stdout.write(`  ↳ ${name} reported an error\n`)
    },
  }
  let session = newSession()

  function newSession(): AgentSession {
    return new AgentSession({
      client,
      workspaceRoot: options.workspaceRoot,
      effort,
      // Plain REPL has no interactive approval UI, so it runs unattended.
      permissionMode: 'auto',
      tools: options.extraTools && options.extraTools.length > 0 ? [...coreTools, ...options.extraTools] : undefined,
      allow: options.allow,
      hooks: options.hooks,
      events,
    })
  }

  async function runTurn(text: string): Promise<void> {
    const start = performance.now()
    streamed = ''
    const result = await session.run(text)
    process.stdout.write('\n')
    const finalText = stripThinkBlocks(result.finalContent).trim()
    if (finalText && !streamed.includes(finalText)) console.log(finalText)
    console.error(
      `[turns=${result.turns} tool_calls=${result.toolCalls} valid=${result.validToolCalls} repaired=${result.repairedToolCalls} compactions=${result.compactions} ${Math.round(performance.now() - start)}ms]`,
    )
  }

  printBanner(options.workspaceRoot, effort)
  process.stdout.write(PROMPT)

  for await (const line of console) {
    const input = line.trim()
    if (!input) {
      process.stdout.write(PROMPT)
      continue
    }

    if (input.startsWith('/')) {
      const [command, ...rest] = input.slice(1).split(' ')
      const arg = rest.join(' ').trim()

      if (command === 'exit' || command === 'quit') break
      if (command === 'help') {
        printHelp()
      } else if (command === 'reset') {
        session = newSession()
        console.log('Conversation reset.')
      } else if (command === 'mode' || command === 'effort') {
        if (arg === 'low' || arg === 'medium' || arg === 'high' || arg === 'xhigh') {
          effort = arg
          session = newSession()
          console.log(`Effort set to ${effort} (conversation reset).`)
        } else {
          console.log(`Current effort: ${effort}. Use "/effort low|medium|high|xhigh".`)
        }
      } else if (command === 'context') {
        const dump = await dumpContext(options.workspaceRoot, arg || 'overview')
        console.log(dump.content)
        console.error(`\napprox_tokens=${dump.approxTokens}`)
      } else if (command === 'memory') {
        const memories = await loadMemories(options.workspaceRoot)
        console.log(
          memories.length === 0
            ? '[no memories]'
            : memories.map(memory => `- ${memory.name} [${memory.type}] — ${memory.description}`).join('\n'),
        )
      } else if (command === 'commit') {
        await runTurn(COMMIT_PROMPT)
      } else if (command === 'review') {
        await runTurn(REVIEW_PROMPT)
      } else {
        console.log(`Unknown command: /${command}. Type /help.`)
      }
      process.stdout.write(PROMPT)
      continue
    }

    await runTurn(input)
    process.stdout.write(PROMPT)
  }

  console.log('\nBye.')
}

function summarizeArgs(input: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(input)
    } catch {
      return String(input)
    }
  })()
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

function printBanner(workspaceRoot: string, effort: EffortMode): void {
  console.log(`Vibe Code REPL — workspace: ${workspaceRoot} — effort: ${effort}`)
  console.log('Type a request, or /help for commands.\n')
}

function printHelp(): void {
  console.log(`Commands:
  /help              Show this help
  /context [query]   Print the curated context for a query
  /memory            List stored project memories
  /effort <m>        Switch effort: low | medium | high | xhigh (resets conversation)
  /commit            Stage and commit current changes
  /review            Review the working-tree diff
  /reset             Clear the conversation history
  /exit              Leave the REPL`)
}
