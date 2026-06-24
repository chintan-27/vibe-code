#!/usr/bin/env bun

import { dumpContext } from '@/context/budget.ts'
import { runEvalSuite, summarizeEvalResults } from '@/eval/suite.ts'
import { applyAmbientSettings, loadSettings } from '@/config/settings.ts'
import { runAgentLoop } from '@/loop/agentLoop.ts'
import type { EffortMode, PermissionMode } from '@/loop/types.ts'
import { loadMcpTools } from '@/mcp/tools.ts'
import { coreTools } from '@/tools/registry.ts'
import { saveMemory } from '@/memory/memdir.ts'
import { getModelProfile, type ModelRole } from '@/provider/models.ts'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { OllamaClient } from '@/provider/ollama.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { runRepl } from '@/cli/repl.ts'
import { startTui } from '@/tui/app.tsx'
import { stripThinkBlocks } from '@/toolcall/parse.ts'

type Command = 'ping' | 'chat' | 'agent' | 'repl' | 'tui' | 'init' | 'dump-context' | 'eval' | 'help'

const args = process.argv.slice(2)
// Bare `vibe` launches the TUI; `vibe <unknown>` still shows help.
const command = args.length === 0 ? 'tui' : parseCommand(args[0])

if (command === 'help') {
  printHelp()
} else if (command === 'ping') {
  await runPing()
} else if (command === 'chat') {
  await runChat(args.slice(1))
} else if (command === 'agent') {
  await runAgent(args.slice(1))
} else if (command === 'repl') {
  await runReplCommand(args.slice(1))
} else if (command === 'tui') {
  await runTuiCommand(args.slice(1))
} else if (command === 'init') {
  await runInitCommand(args.slice(1))
} else if (command === 'dump-context') {
  await runDumpContext(args.slice(1))
} else if (command === 'eval') {
  await runEval(args.slice(1))
}

function parseCommand(value: string | undefined): Command {
  if (
    value === 'ping' ||
    value === 'chat' ||
    value === 'agent' ||
    value === 'repl' ||
    value === 'tui' ||
    value === 'init' ||
    value === 'dump-context' ||
    value === 'eval'
  ) {
    return value
  }
  return 'help'
}

async function runPing(): Promise<void> {
  const client = new OllamaClient()
  const prompt = 'Reply with one short sentence confirming you are available.'
  const roles: ModelRole[] = ['coder', 'reasoner']

  for (const role of roles) {
    const profile = getModelProfile(role)
    const result = await client.chat(
      profile.model,
      [{ role: 'user', content: prompt }],
      profile.defaults,
    )
    printResult(role, result.model, result.content, result.usage.durationMs)
  }
}

async function runChat(chatArgs: string[]): Promise<void> {
  const parsed = parseChatArgs(chatArgs)
  const role = parseRole(parsed.role ?? 'coder')
  const prompt = parsed.prompt
  if (!prompt) {
    throw new Error('chat requires a prompt, for example: bun run dev -- chat "hello"')
  }

  const profile = getModelProfile(role)
  const client = new OllamaClient()
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
  const result = await client.chat(profile.model, messages, profile.defaults)
  printResult(role, result.model, result.content, result.usage.durationMs)
}

async function runAgent(agentArgs: string[]): Promise<void> {
  const parsed = parsePromptArgs(agentArgs)
  if (!parsed.prompt) {
    throw new Error('agent requires a prompt, for example: bun run dev -- agent "read README"')
  }

  const root = parsed.workspace ?? process.cwd()
  const settings = await loadSettings(root)
  applyAmbientSettings(settings)
  const mcp = await loadMcpTools(settings.mcpServers)
  const client = new OllamaClient()
  const result = await runAgentLoop({
    client,
    workspaceRoot: root,
    prompt: parsed.prompt,
    maxTurns: parsed.maxTurns,
    effort: parsed.effort ?? 'normal',
    permissionMode: parsed.permissionMode ?? settings.permissionMode ?? 'auto',
    allow: settings.allow,
    hooks: settings.hooks,
    tools: mcp.tools.length > 0 ? [...coreTools, ...mcp.tools] : undefined,
  }).finally(() => mcp.close())

  console.log(stripThinkBlocks(result.finalContent))
  console.log(
    `\nturns=${result.turns} tool_calls=${result.toolCalls} valid=${result.validToolCalls} repaired=${result.repairedToolCalls} compactions=${result.compactions}`,
  )
}

async function runReplCommand(replArgs: string[]): Promise<void> {
  const parsed = parsePromptArgs(replArgs)
  await runRepl({
    workspaceRoot: parsed.workspace ?? process.cwd(),
    effort: parsed.effort ?? 'normal',
  })
}

async function runTuiCommand(tuiArgs: string[]): Promise<void> {
  const parsed = parsePromptArgs(tuiArgs)
  const root = parsed.workspace ?? process.cwd()
  const settings = await loadSettings(root)
  applyAmbientSettings(settings)
  const mcp = await loadMcpTools(settings.mcpServers)
  try {
    await startTui({
      workspaceRoot: root,
      effort: parsed.effort ?? 'normal',
      // Interactive: default to asking before mutating actions (like Claude Code).
      permissionMode: parsed.permissionMode ?? settings.permissionMode ?? 'default',
      allow: settings.allow,
      hooks: settings.hooks,
      extraTools: mcp.tools,
    })
  } finally {
    mcp.close()
  }
}

async function runInitCommand(initArgs: string[]): Promise<void> {
  const parsed = parsePromptArgs(initArgs)
  const root = parsed.workspace ?? process.cwd()
  const client = new OllamaClient()
  const profile = getModelProfile('coder')

  console.log('Analyzing repository and writing VIBE.md…')
  // Deterministic: curate context ourselves, ask once for the body, write it. No agentic loop.
  const context = await dumpContext(root, 'project overview architecture build test commands entry points', 4_000)
  const response = await client.chat(
    profile.model,
    [
      { role: 'system', content: 'You write concise, accurate VIBE.md files that orient an AI agent to a codebase.' },
      {
        role: 'user',
        content: `Using this repository context, write the COMPLETE contents of a VIBE.md (GitHub-flavored markdown). Cover: (1) what this project is, (2) how to build/run/test it, (3) the high-level architecture and key directories. Keep it under 60 lines. Output ONLY the markdown — no surrounding code fences, no preamble.\n\n${context.content}`,
      },
    ],
    profile.defaults,
  )

  const body = stripCodeFence(stripThinkBlocks(response.content)).trim()
  if (!body) {
    console.log('(!) The model produced no content — try again.')
    return
  }
  await writeFile(join(root, 'VIBE.md'), `${body}\n`, 'utf8')
  await saveMemory(root, {
    name: 'project-overview',
    description: 'Project overview generated by `vibe init`',
    type: 'project',
    body: body.slice(0, 1_200),
  })
  console.log(`\n✓ Wrote ${join(root, 'VIBE.md')} and seeded a project-overview memory.`)
}

/** Strip a single wrapping ```/```markdown fence if the model added one. */
function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)
  return match?.[1] ?? text
}

async function runDumpContext(contextArgs: string[]): Promise<void> {
  const parsed = parsePromptArgs(contextArgs)
  if (!parsed.prompt) {
    throw new Error('dump-context requires a query')
  }
  const result = await dumpContext(parsed.workspace ?? process.cwd(), parsed.prompt)
  console.log(result.content)
  console.error(`\napprox_tokens=${result.approxTokens}`)
}

async function runEval(evalArgs: string[]): Promise<void> {
  const client = new OllamaClient()
  const effort: EffortMode = evalArgs.includes('--high') ? 'high' : evalArgs.includes('--medium') ? 'medium' : 'normal'
  const results = await runEvalSuite(client, effort)
  console.log(`effort=${effort}`)
  console.log(summarizeEvalResults(results))
}

function parseChatArgs(values: string[]): { role?: string; prompt: string } {
  const promptParts: string[] = []
  let role: string | undefined

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--role') {
      role = values[index + 1]
      index += 1
    } else if (value) {
      promptParts.push(value)
    }
  }

  return { role, prompt: promptParts.join(' ').trim() }
}

function parsePromptArgs(values: string[]): {
  workspace?: string
  maxTurns?: number
  effort?: EffortMode
  permissionMode?: PermissionMode
  prompt: string
} {
  const promptParts: string[] = []
  let workspace: string | undefined
  let maxTurns: number | undefined
  let effort: EffortMode | undefined
  let permissionMode: PermissionMode | undefined

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--workspace') {
      workspace = values[index + 1]
      index += 1
    } else if (value === '--max-turns') {
      const raw = values[index + 1]
      maxTurns = raw ? Number.parseInt(raw, 10) : undefined
      index += 1
    } else if (value === '--normal') {
      effort = 'normal'
    } else if (value === '--medium') {
      effort = 'medium'
    } else if (value === '--high') {
      effort = 'high'
    } else if (value === '--plan') {
      permissionMode = 'plan'
    } else if (value === '--accept-edits') {
      permissionMode = 'acceptEdits'
    } else if (value === '--auto') {
      permissionMode = 'auto'
    } else if (value === '--ask') {
      permissionMode = 'default'
    } else if (value) {
      promptParts.push(value)
    }
  }

  return { workspace, maxTurns, effort, permissionMode, prompt: promptParts.join(' ').trim() }
}

function parseRole(value: string): ModelRole {
  if (value === 'coder' || value === 'reasoner' || value === 'extractor') {
    return value
  }
  throw new Error(`unknown role "${value}"; expected coder, reasoner, or extractor`)
}

function printResult(
  role: ModelRole,
  model: string,
  content: string,
  durationMs: number,
): void {
  console.log(`\n[${role}] ${model} (${durationMs}ms)`)
  console.log(stripThinkBlocks(content))
}

function printHelp(): void {
  console.log(`Vibe Code

Commands:
  ping                 Chat with the coder and reasoner models
  chat [--role role]   Send one prompt to coder, reasoner, or extractor
  agent                Run the tool-using agent loop (one-shot)
  repl                 Start an interactive multi-turn session (plain stdin)
  tui                  Start the full-screen Ink TUI (recommended)
  init                 Analyze the repo and generate VIBE.md + seed memory
  dump-context         Print repo map and retrieved snippets for a query
  eval [--high]        Run the local eval suite and print success metrics

Effort flags (agent/tui):     --normal  --medium  --high   (VibeThinker reasons; high adds reviewers)
Permission flags (agent/tui): --plan  --accept-edits  --auto  --ask

Examples:
  vibe                              Launch the TUI in the current directory
  vibe tui --workspace ~/proj      Launch the TUI for a specific project
  vibe ping                         Check both models respond
  vibe agent "read README.md"       One-shot agent task
  vibe dump-context "tool parser"   Inspect the curated context
  vibe eval --two-phase             Run the eval suite (VibeThinker A/B)
`)
}
