import { dumpContext } from '@/context/budget.ts'
import { AgentSession } from '@/loop/session.ts'
import type { EffortMode, SessionEvents } from '@/loop/types.ts'
import { loadMemories } from '@/memory/memdir.ts'
import { OllamaClient } from '@/provider/ollama.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'

export type ReplOptions = {
  workspaceRoot: string
  effort: EffortMode
}

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
    return new AgentSession({ client, workspaceRoot: options.workspaceRoot, effort, events })
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
        if (arg === 'normal' || arg === 'medium' || arg === 'high') {
          effort = arg
          session = newSession()
          console.log(`Effort set to ${effort} (conversation reset).`)
        } else {
          console.log(`Current effort: ${effort}. Use "/effort normal|medium|high".`)
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
      } else {
        console.log(`Unknown command: /${command}. Type /help.`)
      }
      process.stdout.write(PROMPT)
      continue
    }

    const start = performance.now()
    streamed = ''
    const result = await session.run(input)
    process.stdout.write('\n')
    // Print the final content only when it wasn't already streamed (e.g. a synthesized
    // "stopped" / error status, or a non-streaming two-phase turn).
    const finalText = stripThinkBlocks(result.finalContent).trim()
    if (finalText && !streamed.includes(finalText)) console.log(finalText)
    console.error(
      `[turns=${result.turns} tool_calls=${result.toolCalls} valid=${result.validToolCalls} repaired=${result.repairedToolCalls} compactions=${result.compactions} ${Math.round(performance.now() - start)}ms]`,
    )
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
  /effort <m>        Switch effort: normal | medium | high (resets conversation)
  /reset             Clear the conversation history
  /exit              Leave the REPL`)
}
