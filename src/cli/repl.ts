import { dumpContext } from '@/context/budget.ts'
import { buildGraphIndex, graphIndexStatus } from '@/context/graph/index.ts'
import { initializeProject } from '@/cli/init.ts'
import type { HooksConfig } from '@/hooks/hooks.ts'
import { AgentSession } from '@/loop/session.ts'
import type { EffortMode, SessionEvents } from '@/loop/types.ts'
import { loadMemories } from '@/memory/memdir.ts'
import { listCheckpoints, listSessionMetadata, readSessionState, restoreCheckpoint } from '@/loop/workflow.ts'
import type { PluginSettings } from '@/plugins/manager.ts'
import { extensionInfo, extensionSummary, installExtension, removeExtension, setExtensionEnabled, trustExtension } from '@/plugins/manager.ts'
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
  extensionSettings?: PluginSettings
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
    onNotice: notice => process.stdout.write(`\n[${notice.level}] ${notice.title}: ${notice.message}\n`),
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
      extensionSettings: options.extensionSettings,
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
        if (arg === 'index') {
          const index = await buildGraphIndex(options.workspaceRoot, {
            onProgress: progress => console.error(`[GraphRAG] ${progress.message}`),
          })
          console.log(`GraphRAG indexed ${index.stats.files} files, ${index.stats.symbols} symbols, ${index.stats.chunks} chunks, ${index.stats.edges} edges.`)
          index.close()
        } else if (arg === 'status') {
          console.log(await graphIndexStatus(options.workspaceRoot))
        } else {
          const dump = await dumpContext(options.workspaceRoot, arg || 'overview')
          console.log(dump.content)
          console.error(`\napprox_tokens=${dump.approxTokens} source=${dump.source}`)
        }
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
      } else if (command === 'init') {
        console.log('Analyzing repository and writing VIBE.md…')
        try {
          const result = await initializeProject(options.workspaceRoot, client, {
            onProgress: progress => console.error(`[init ${progress.pct}%] ${progress.label}: ${progress.message}`),
          })
          console.log(`Wrote ${result.path} and seeded a ${result.memoryName} memory.`)
        } catch (error) {
          console.log(`init failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else if (command === 'diff') {
        console.log(gitSummary(options.workspaceRoot))
      } else if (command === 'rewind') {
        const [sub, sessionId, turnText, confirm] = arg.split(/\s+/)
        if (sub === 'restore') {
          if (!sessionId || !turnText || confirm !== '--confirm') {
            console.log('usage: /rewind restore <sessionId> <turn> --confirm')
          } else {
            const meta = await restoreCheckpoint(options.workspaceRoot, sessionId, Number.parseInt(turnText, 10))
            console.log(`Restored checkpoint ${meta.sessionId}/${meta.turn}: ${meta.touchedFiles.join(', ')}`)
          }
        } else {
          const checkpoints = await listCheckpoints(options.workspaceRoot)
          console.log(
            checkpoints.length === 0
              ? 'No checkpoints yet.'
              : checkpoints
                  .slice(0, 10)
                  .map(cp => `${cp.timestamp}  ${cp.tool}  ${cp.touchedFiles.join(', ')}  (session ${cp.sessionId}, turn ${cp.turn})`)
                  .join('\n'),
          )
          console.log('Restore with /rewind restore <sessionId> <turn> --confirm')
        }
      } else if (command === 'resume') {
        if (arg) {
          try {
            const state = await readSessionState(options.workspaceRoot, arg)
            session.restore(state)
            console.log(`Resumed ${state.metadata.id} · ${state.metadata.title}`)
          } catch (error) {
            console.log(`resume failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        } else {
          const sessions = await listSessionMetadata(options.workspaceRoot)
          console.log(
            sessions.length === 0
              ? 'No saved sessions yet.'
              : sessions.map(s => `${s.id}  ${s.updatedAt}  ${s.title}`).join('\n'),
          )
        }
      } else if (command === 'plugins') {
        console.log(await runPluginCommand(options.workspaceRoot, arg, options.extensionSettings))
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
  /context [query]   Print curated context; use /context index or /context status for GraphRAG
  /memory            List stored project memories
  /init              Generate VIBE.md and seed project memory
  /diff              Show working-tree summary
  /rewind            List recent checkpoints
  /resume [id]       List saved sessions, or restore one by id
  /plugins <cmd>     Manage skills/plugins: list, add, info, enable, disable, trust, remove
  /effort <m>        Switch effort: low | medium | high | xhigh (resets conversation)
  /commit            Stage and commit current changes
  /review            Review the working-tree diff
  /reset             Clear the conversation history
  /exit              Leave the REPL`)
}

async function runPluginCommand(workspaceRoot: string, input: string, settings?: PluginSettings): Promise<string> {
  const [command = 'list', ...rest] = input.split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  try {
    if (command === 'list') return extensionSummary(workspaceRoot, settings)
    if (command === 'add') {
      if (!arg) return 'usage: /plugins add <path|git|registry-id>'
      const extension = await installExtension(workspaceRoot, arg, settings)
      return `Installed ${extension.id}.`
    }
    if (command === 'info') return arg ? extensionInfo(workspaceRoot, arg, settings) : 'usage: /plugins info <id>'
    if (command === 'enable' || command === 'disable') {
      if (!arg) return `usage: /plugins ${command} <id>`
      const extension = await setExtensionEnabled(workspaceRoot, arg, command === 'enable')
      return `${extension.id} ${extension.enabled ? 'enabled' : 'disabled'}.`
    }
    if (command === 'trust') {
      if (!arg) return 'usage: /plugins trust <id>'
      const extension = await trustExtension(workspaceRoot, arg)
      return `${extension.id} trusted.`
    }
    if (command === 'remove') {
      if (!arg) return 'usage: /plugins remove <id>'
      await removeExtension(workspaceRoot, arg)
      return `${arg} removed.`
    }
    return 'usage: /plugins list|add|info|enable|disable|trust|remove'
  } catch (error) {
    return `plugins ${command} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function gitSummary(cwd: string): string {
  const status = Bun.spawnSync(['git', 'status', '--short'], { cwd })
  const stat = Bun.spawnSync(['git', 'diff', '--stat'], { cwd })
  const statusText = status.stdout.toString().trim() || '[working tree clean]'
  const statText = stat.stdout.toString().trim()
  return [`# git status --short`, statusText, '', '# git diff --stat', statText || '[no unstaged diff]'].join('\n')
}
