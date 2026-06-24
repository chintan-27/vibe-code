import { compactMessages, estimateTokens } from '@/compact/compact.ts'
import { dumpContext } from '@/context/budget.ts'
import { loadMemories, renderMemoryPrompt, selectRelevantMemories } from '@/memory/memdir.ts'
import { loadProjectInstructions } from '@/prompt/instructions.ts'
import { buildSystemPrompt } from '@/prompt/system.ts'
import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { parseToolCalls, stripThinkBlocks } from '@/toolcall/parse.ts'
import { validateToolCalls, type ValidToolCall } from '@/toolcall/validate.ts'
import { coreTools, toolMap } from '@/tools/registry.ts'
import type { AnyTool, ToolContext } from '@/tools/types.ts'
import { type HooksConfig, runHooks } from '@/hooks/hooks.ts'
import { runTwoPhaseStep } from './twoPhase.ts'
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
  /** Tools the user approved "always" for this session ("don't ask again"). */
  private readonly allowRules = new Set<string>()
  private messages: ChatMessage[] = []

  constructor(options: AgentSessionOptions) {
    this.client = options.client
    this.workspaceRoot = options.workspaceRoot
    this.tools = options.tools ?? coreTools
    this.toolsByName = toolMap(this.tools)
    this.effort = options.effort ?? 'normal'
    this.maxTurns = options.maxTurns ?? 12
    this.contextTokenBudget = options.contextTokenBudget ?? 12_000
    this.spawnDepth = options.spawnDepth ?? 0
    this.events = options.events
    this.permissionMode = options.permissionMode ?? 'auto'
    this.hooks = options.hooks
    for (const tool of options.allow ?? []) this.allowRules.add(tool)
  }

  /** Drop all conversation history (keeps configuration). */
  reset(): void {
    this.messages = []
  }

  async run(userInput: string): Promise<AgentLoopResult> {
    await this.refreshSystemMessage(userInput)
    this.messages.push({ role: 'user', content: userInput })

    const profile = getModelProfile('coder')
    const context: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      client: this.client,
      spawnDepth: this.spawnDepth,
      askUser: this.events?.onAskUser,
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

      const content = await this.generate()

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
          this.messages.push({ role: 'tool', toolName: call.tool.name, content: gate })
          continue
        }
        // PreToolUse hooks may block execution (non-zero exit).
        const pre = await runHooks('PreToolUse', call.tool.name, call.input, this.hooks, this.workspaceRoot)
        if (pre.block) {
          this.messages.push({ role: 'tool', toolName: call.tool.name, content: `Blocked by PreToolUse hook: ${pre.message}` })
          continue
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
  private async generate(): Promise<string> {
    return runTwoPhaseStep(this.client, this.messages, {
      effort: this.effort,
      onThink: this.events?.onThink,
      onToken: this.events?.onToken,
      onUsage: this.events?.onUsage,
    })
  }

  /** Rebuild the system message with context/memory relevant to the latest request. */
  private async refreshSystemMessage(userInput: string): Promise<void> {
    const instructionEntries = await loadProjectInstructions(this.workspaceRoot)
    const relevantMemories = selectRelevantMemories(await loadMemories(this.workspaceRoot), userInput)
    const contextDump = await dumpContext(this.workspaceRoot, userInput, this.contextTokenBudget)
    this.events?.onContext?.({ files: contextDump.files, approxTokens: contextDump.approxTokens })
    const system: ChatMessage = {
      role: 'system',
      content: [
        buildSystemPrompt(this.tools),
        renderInstructionContext(instructionEntries),
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
        if (attempt === 1) return { assistant: current, calls: [], repaired, error: `Tool-call parse failed: ${parsed.error}` }
        current = (await this.repairToolCall(current, parsed.error)) ?? current
        repaired = true
        continue
      }
      if (parsed.calls.length === 0) return { assistant: current, calls: [], repaired }

      const validated = validateToolCalls(parsed.calls, this.toolsByName)
      if (validated.ok) return { assistant: current, calls: validated.calls, repaired }
      if (attempt === 1) {
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
  return truncate(JSON.stringify(input), 300)
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
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
