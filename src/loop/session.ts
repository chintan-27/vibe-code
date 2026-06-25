import { access } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { compactMessages, estimateTokens } from '@/compact/compact.ts'
import { DEFAULT_CONTEXT_TOKEN_BUDGET, dumpContext } from '@/context/budget.ts'
import { loadMemories, renderMemoryPrompt, selectRelevantMemories } from '@/memory/memdir.ts'
import { loadProjectInstructions } from '@/prompt/instructions.ts'
import { buildSystemPrompt } from '@/prompt/system.ts'
import { renderExtensionInstructions } from '@/plugins/manager.ts'
import type { PluginSettings } from '@/plugins/manager.ts'
import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { describeImage } from '@/vision/describe.ts'
import { parseToolCalls, stripThinkBlocks } from '@/toolcall/parse.ts'
import { validateToolCalls, type ValidToolCall } from '@/toolcall/validate.ts'
import { coreTools, toolMap } from '@/tools/registry.ts'
import type { AnyTool, ToolContext } from '@/tools/types.ts'
import { type HooksConfig, runHooks } from '@/hooks/hooks.ts'
import { runTwoPhaseStep } from './twoPhase.ts'
import { createSessionId, createToolCheckpoint, writeSessionMetadata, type SessionMetadata } from './workflow.ts'
import type {
  AgentLoopResult,
  ChatClient,
  EffortMode,
  PermissionMode,
  PlannedAction,
  SessionEvents,
} from './types.ts'

export type AgentSessionOptions = {
  client: ChatClient
  workspaceRoot: string
  tools?: AnyTool[]
  effort?: EffortMode
  maxTurns?: number
  contextTokenBudget?: number
  spawnDepth?: number
  events?: SessionEvents
  /** Permission posture. Defaults to `auto` (unattended) to preserve headless behavior. */
  permissionMode?: PermissionMode
  /** Tools to always allow without prompting (from settings.json). */
  allow?: string[]
  /** Shell hooks run around tool execution (from settings.json). */
  hooks?: HooksConfig
  extensionSettings?: PluginSettings
}

/**
 * A persistent agent conversation. One `run()` handles a single user request
 * (model → tool calls → results → … → final answer) while carrying the message
 * history forward, so a REPL can keep context across turns. `runAgentLoop` is just
 * a one-shot wrapper around a single `run()`.
 */
export class AgentSession {
  private readonly client: ChatClient
  private readonly workspaceRoot: string
  private readonly tools: AnyTool[]
  private readonly toolsByName: Map<string, AnyTool>
  private readonly effort: EffortMode
  private readonly maxTurns: number
  private readonly contextTokenBudget: number
  private readonly spawnDepth: number
  private readonly events?: SessionEvents
  private readonly permissionMode: PermissionMode
  private readonly hooks?: HooksConfig
  private readonly extensionSettings?: PluginSettings
  private readonly sessionId = createSessionId()
  private readonly startedAt = new Date().toISOString()
  /** Tools the user approved "always" for this session ("don't ask again"). */
  private readonly allowRules = new Set<string>()
  private messages: ChatMessage[] = []

  constructor(options: AgentSessionOptions) {
    this.client = options.client
    this.workspaceRoot = options.workspaceRoot
    this.tools = options.tools ?? coreTools
    this.toolsByName = toolMap(this.tools)
    this.effort = options.effort ?? 'low'
    this.maxTurns = options.maxTurns ?? 12
    this.contextTokenBudget = options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET
    this.spawnDepth = options.spawnDepth ?? 0
    this.events = options.events
    this.permissionMode = options.permissionMode ?? 'auto'
    this.hooks = options.hooks
    this.extensionSettings = options.extensionSettings
    for (const tool of options.allow ?? []) this.allowRules.add(tool)
  }

  /** Drop all conversation history (keeps configuration). */
  reset(): void {
    this.messages = []
  }

  async run(userInput: string, signal?: AbortSignal): Promise<AgentLoopResult> {
    await this.writeMetadata(userInput, 'turn started')
    await this.refreshSystemMessage(userInput)
    const withImages = await this.attachImages(userInput)
    this.messages.push({ role: 'user', content: withImages })

    const profile = getModelProfile('coder')
    const context: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      client: this.client,
      spawnDepth: this.spawnDepth,
      askUser: this.events?.onAskUser,
      signal,
    }
    let toolCalls = 0
    let validToolCalls = 0
    let repairedToolCalls = 0
    let compactions = 0
    let finalContent = ''
    let lastCallSignature = ''
    const planned: PlannedAction[] = []

    const done = (finalContent: string, turn: number): AgentLoopResult => {
      if (this.permissionMode === 'plan' && planned.length > 0) this.events?.onPlan?.(planned)
      return { finalContent, turns: turn, toolCalls, validToolCalls, repairedToolCalls, compactions }
    }

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      const systemTokens = estimateTokens(this.messages[0]?.content ?? '')
      const tokenThreshold = Math.max(1_500, profile.defaults.numCtx - systemTokens - profile.defaults.maxTokens - 512)
      const compaction = await compactMessages(this.client, this.messages, { tokenThreshold, keepRecent: 6 })
      if (compaction.compacted) {
        this.messages = compaction.messages
        compactions += 1
      }

      const content = await this.generate(signal)

      const step = await this.resolveStep(stripThinkBlocks(content))
      this.messages.push({ role: 'assistant', content: step.assistant })
      finalContent = step.assistant
      if (step.repaired) repairedToolCalls += 1

      if (step.error) return done(step.error, turn)
      if (step.calls.length === 0) return done(finalContent, turn)

      const signature = step.calls.map(call => `${call.tool.name}:${JSON.stringify(call.input)}`).join('|')
      if (signature === lastCallSignature) {
        return done('Stopped: model repeated the same tool call without progress.', turn)
      }
      lastCallSignature = signature

      toolCalls += step.calls.length
      validToolCalls += step.calls.length
      for (const call of step.calls) {
        const gate = await this.gate(call.tool, call.input, planned)
        if (gate !== 'run') {
          if (gate.startsWith('User denied') || gate.startsWith('Not executed')) {
            this.events?.onNotice?.({
              level: gate.startsWith('User denied') ? 'warn' : 'info',
              title: gate.startsWith('User denied') ? 'Permission denied' : 'Action skipped',
              message: gate,
            })
          }
          this.messages.push({ role: 'tool', toolName: call.tool.name, content: gate })
          continue
        }
        // PreToolUse hooks may block execution (non-zero exit).
        const pre = await runHooks('PreToolUse', call.tool.name, call.input, this.hooks, this.workspaceRoot)
        if (pre.block) {
          this.messages.push({ role: 'tool', toolName: call.tool.name, content: `Blocked by PreToolUse hook: ${pre.message}` })
          continue
        }
        const checkpoint = await createToolCheckpoint(this.workspaceRoot, this.sessionId, turn, call.tool.name, call.input).catch(() => undefined)
        if (checkpoint) {
          this.events?.onNotice?.({
            level: 'info',
            title: 'Checkpoint saved',
            message: `${checkpoint.tool} can be rewound for ${checkpoint.touchedFiles.join(', ')}`,
          })
        }
        this.events?.onTool?.(call.tool.name, call.input)
        const result = await executeToolSafely(call.tool, call.input, context)
        await runHooks('PostToolUse', call.tool.name, { input: call.input, result }, this.hooks, this.workspaceRoot)
        this.events?.onToolResult?.(call.tool.name, result.ok, result.content)
        this.messages.push({
          role: 'tool',
          toolName: call.tool.name,
          content: `${result.ok ? 'ok' : 'error'}\n${result.content}`,
        })
      }
      await this.writeMetadata(userInput, stripThinkBlocks(finalContent).slice(0, 500))
    }

    return done('Stopped after reaching max turns.', this.maxTurns)
  }

  /**
   * Permission gate for a single tool call. Returns `'run'` to execute, or a
   * tool-result string to feed back to the model when the call is skipped
   * (recorded in plan mode, or denied by the user).
   */
  private async gate(tool: AnyTool, input: unknown, planned: PlannedAction[]): Promise<'run' | string> {
    if (tool.readOnly || this.permissionMode === 'auto' || this.allowRules.has(tool.name)) {
      return 'run'
    }
    if (this.permissionMode === 'plan') {
      planned.push({ tool: tool.name, input, preview: previewChange(tool.name, input) })
      return 'Not executed — plan mode. Recorded for the user to approve.'
    }
    if (this.permissionMode === 'acceptEdits' && (tool.name === 'Write' || tool.name === 'Edit')) {
      return 'run'
    }
    const handler = this.events?.onPermissionRequest
    if (!handler) return 'Not executed — no interactive approval available for this action.'
    const decision = await handler({ tool: tool.name, input, preview: previewChange(tool.name, input) })
    if (decision === 'allow-always') {
      this.allowRules.add(tool.name)
      return 'run'
    }
    if (decision === 'allow') return 'run'
    return 'User denied permission to run this tool. Do not retry it; choose another approach or ask the user.'
  }

  /**
   * Produce the next assistant turn. VibeThinker always reasons and decides;
   * qwen extracts the structured action (see runTwoPhaseStep). Effort controls
   * how much VibeThinker reasons and whether reviewers run.
   */
  private async generate(signal?: AbortSignal): Promise<string> {
    return runTwoPhaseStep(this.client, this.messages, {
      effort: this.effort,
      onThink: this.events?.onThink,
      onToken: this.events?.onToken,
      onUsage: this.events?.onUsage,
      onNotice: this.events?.onNotice,
      signal,
    })
  }

  /**
   * If the user's message references image paths, describe them up front via the
   * vision model and inline the descriptions — so the model never has to "decide"
   * to look (and can't claim it can't see images). User-initiated, so not gated.
   */
  private async attachImages(userInput: string): Promise<string> {
    const unique = extractImagePaths(userInput).slice(0, 3)
    if (unique.length === 0) return userInput

    const notes: string[] = []
    for (const path of unique) {
      const abs = isAbsolute(path) ? path : join(this.workspaceRoot, path)
      try {
        await access(abs)
      } catch {
        // Common case: a macOS screenshot temp (NSIRD_screencaptureui) already deleted.
        this.events?.onTool?.('ViewImage', { file_path: path })
        this.events?.onToolResult?.('ViewImage', false, 'file not found (a temporary screenshot may have been deleted)')
        notes.push(
          `\n\n[image — ${path}] could not be found. If this was a macOS screenshot, it was likely a temporary preview that has been deleted — save it to disk (e.g. drag it from your Desktop) and try again.`,
        )
        continue
      }
      this.events?.onTool?.('ViewImage', { file_path: path })
      try {
        const description = await describeImage(this.client, abs)
        this.events?.onToolResult?.('ViewImage', true, description)
        notes.push(`\n\n[Attached image — ${path}]\n${description}`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        this.events?.onToolResult?.('ViewImage', false, msg)
        notes.push(`\n\n[Attached image — ${path}] (could not be read: ${msg})`)
      }
    }
    return userInput + notes.join('')
  }

  /** Rebuild the system message with context/memory relevant to the latest request. */
  private async refreshSystemMessage(userInput: string): Promise<void> {
    const instructionEntries = await loadProjectInstructions(this.workspaceRoot).catch(() => [])
    const extensionInstructions = await renderExtensionInstructions(this.workspaceRoot, this.extensionSettings).catch(() => '')
    const relevantMemories = selectRelevantMemories(await loadMemories(this.workspaceRoot).catch(() => []), userInput)
    // Never let a slow/huge/unreadable tree (e.g. running from $HOME) crash the turn.
    const contextDump = await dumpContext(this.workspaceRoot, userInput, this.contextTokenBudget).catch(() => ({
      content: '[workspace context unavailable]',
      approxTokens: 0,
      files: [] as string[],
      source: 'fallback' as const,
    }))
    this.events?.onNotice?.({
      level: 'info',
      title: contextDump.source === 'graph' ? 'GraphRAG context ready' : 'Fallback context ready',
      message:
        contextDump.source === 'graph'
          ? `${contextDump.files.length} files selected from SQLite graph index (${contextDump.approxTokens} tokens).`
          : `${contextDump.files.length} files selected from repo-map/lexical retrieval (${contextDump.approxTokens} tokens). Run /context index to enable GraphRAG.`,
    })
    this.events?.onContext?.({
      files: contextDump.files,
      approxTokens: contextDump.approxTokens,
      budgetTokens: this.contextTokenBudget,
    })
    const system: ChatMessage = {
      role: 'system',
      content: [
        buildSystemPrompt(this.tools, { permissionMode: this.permissionMode }),
        renderInstructionContext(instructionEntries),
        extensionInstructions,
        renderMemoryPrompt(relevantMemories),
        `# Workspace Context\n${contextDump.content}`,
      ].join('\n\n'),
    }
    if (this.messages[0]?.role === 'system') this.messages[0] = system
    else this.messages.unshift(system)
  }

  private async resolveStep(assistant: string): Promise<StepResolution> {
    let current = assistant
    let repaired = false

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parsed = parseToolCalls(current)
      if (!parsed.ok) {
        this.events?.onNotice?.({
          level: parsed.kind === 'incomplete' ? 'warn' : 'error',
          title: parsed.kind === 'incomplete' ? 'Repairing incomplete tool call' : 'Repairing malformed tool call',
          message: parsed.error,
        })
        if (attempt === 1) {
          this.events?.onNotice?.({
            level: 'error',
            title: 'Tool-call parse failed',
            message: parsed.error,
          })
          return { assistant: current, calls: [], repaired, error: `Tool-call parse failed: ${parsed.error}` }
        }
        current = (await this.repairToolCall(current, parsed.error)) ?? current
        repaired = true
        continue
      }
      if (parsed.calls.length === 0) return { assistant: current, calls: [], repaired }

      const validated = validateToolCalls(parsed.calls, this.toolsByName)
      if (validated.ok) return { assistant: current, calls: validated.calls, repaired }
      this.events?.onNotice?.({
        level: 'warn',
        title: 'Repairing invalid tool call',
        message: validated.error,
      })
      if (attempt === 1) {
        this.events?.onNotice?.({
          level: 'error',
          title: 'Tool-call validation failed',
          message: validated.error,
        })
        return { assistant: current, calls: [], repaired, error: `Tool-call validation failed: ${validated.error}` }
      }
      current = (await this.repairToolCall(current, validated.error)) ?? current
      repaired = true
    }
    return { assistant: current, calls: [], repaired, error: 'Tool-call could not be resolved.' }
  }

  private async repairToolCall(badContent: string, error: string): Promise<string | undefined> {
    const profile = getModelProfile('extractor')
    const response = await this.client.chat(
      profile.model,
      [
        {
          role: 'system',
          content:
            'Repair the tool call. Return only JSON shaped as {"name":"ToolName","arguments":{...}}. Use workspace-relative paths. Use Write to create files and Edit only for exact replacements in existing files.',
        },
        { role: 'user', content: `Error:\n${error}\n\nBad content:\n${badContent}` },
      ],
      { ...profile.defaults, format: 'json' },
    )
    return stripThinkBlocks(response.content)
  }

  private async writeMetadata(lastUserPrompt: string, compactSummary: string): Promise<void> {
    const metadata: SessionMetadata = {
      id: this.sessionId,
      title: titleFromPrompt(lastUserPrompt),
      cwd: this.workspaceRoot,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      lastUserPrompt,
      compactSummary,
    }
    await writeSessionMetadata(this.workspaceRoot, metadata).catch(() => {})
  }
}

type StepResolution = {
  assistant: string
  calls: ValidToolCall[]
  repaired: boolean
  error?: string
}

function renderInstructionContext(entries: Awaited<ReturnType<typeof loadProjectInstructions>>): string {
  if (entries.length === 0) return '# Local Instructions\n[none]'
  return ['# Local Instructions', ...entries.map(entry => `## ${entry.path}\n${entry.content.slice(0, 8000)}`)].join('\n\n')
}

const IMG_EXT = '(?:png|jpe?g|gif|webp|bmp)'

/**
 * Find image paths in a user message, tolerant of spaces. Handles quoted paths,
 * absolute/relative paths that contain spaces (up to the extension), and plain
 * no-space tokens. Drag-and-drop "\ " escapes are normalized.
 */
export function extractImagePaths(text: string): string[] {
  const found: string[] = []
  const push = (p?: string) => {
    if (p) found.push(p.replace(/\\ /g, ' ').replace(/^['"]|['"]$/g, '').trim())
  }
  // 1) quoted: '…/a b.png' or "…/a b.png"
  for (const m of text.matchAll(new RegExp(`['"]([^'"\\n]+\\.${IMG_EXT})['"]`, 'gi'))) push(m[1])
  // 2) path starting with / ~/ ./ ../ or C:\ , allowing spaces, up to the extension
  for (const m of text.matchAll(
    new RegExp(`(?:^|\\s)((?:/|~/|\\.{1,2}/|[A-Za-z]:[\\\\/])[^\\n]*?\\.${IMG_EXT})(?=\\s|$)`, 'gi'),
  ))
    push(m[1])
  // 3) plain no-space token ending in an image extension (e.g. shot.png)
  for (const m of text.matchAll(new RegExp(`(?:^|\\s)([^\\s'"]+\\.${IMG_EXT})(?=\\s|$)`, 'gi'))) push(m[1])
  // Drop fragments that are just the tail of a longer matched path (e.g. "PM.png").
  const sorted = [...new Set(found)].sort((a, b) => b.length - a.length)
  const result: string[] = []
  for (const p of sorted) if (!result.some(r => r.endsWith(p))) result.push(p)
  return result
}

/** Human-readable preview of a mutating tool call, for the approval prompt. */
function previewChange(toolName: string, input: unknown): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (toolName === 'Edit') {
    return `${str(rec.file_path)}\n- ${truncate(str(rec.old_string))}\n+ ${truncate(str(rec.new_string))}`
  }
  if (toolName === 'Write') {
    const content = str(rec.content)
    return `${str(rec.file_path)}  (${content.length} chars)\n${truncate(content, 400)}`
  }
  if (toolName === 'Bash') return `$ ${str(rec.command)}`
  if (toolName === 'Read') return `read ${str(rec.file_path)}`
  return truncate(JSON.stringify(input), 300)
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function titleFromPrompt(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? 'Untitled session'
  return truncate(first, 80) || 'Untitled session'
}

async function executeToolSafely(
  tool: AnyTool,
  input: unknown,
  context: ToolContext,
): Promise<{ ok: boolean; content: string }> {
  try {
    return await tool.execute(input, context)
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}
