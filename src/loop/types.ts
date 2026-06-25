import type { AnyTool } from '@/tools/types.ts'
import type { HooksConfig } from '@/hooks/hooks.ts'
import type { PluginSettings } from '@/plugins/manager.ts'

export type { ChatClient } from '@/provider/types.ts'
import type { ChatClient } from '@/provider/types.ts'

/**
 * Effort level. qwen always extracts the final structured action.
 * - low:    no reasoning — qwen acts directly (fast lane)
 * - medium: dynamic — a quick check decides whether VibeThinker reasoning is needed
 * - high:   deep VibeThinker reasoning + qwen reviewer (gemma if VIBE_REVIEW_GEMMA=1)
 * - xhigh:  deepest reasoning + qwen AND gemma reviewers (always)
 */
export type EffortMode = 'low' | 'medium' | 'high' | 'xhigh'

export type ContextInfo = { files: string[]; approxTokens: number; budgetTokens?: number }
export type TurnUsage = {
  completionTokens: number
  durationMs: number
  doneReason?: string
  loadDurationMs?: number
}

export type RuntimeNotice = {
  level: 'info' | 'warn' | 'error'
  title: string
  message: string
}

/**
 * Permission posture for a session (mirrors Claude Code):
 * - `default`     ask before each mutating action
 * - `acceptEdits` auto-apply Write/Edit, still ask for Bash
 * - `plan`        read-only; mutating actions are recorded as a proposed plan, not run
 * - `auto`        run everything unattended (bypass)
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto'

/** What the user (or rules) decided for a single permission prompt. */
export type PermissionDecision = 'allow' | 'allow-always' | 'deny'

export type PermissionRequest = {
  tool: string
  input: unknown
  /** Human-readable preview of the change (diff for Edit, new-file body for Write, command for Bash). */
  preview: string
}

/** A mutating action recorded (not executed) while in plan mode. */
export type PlannedAction = { tool: string; input: unknown; preview: string }

/** Optional observers for live (streaming) rendering of a session turn. */
export type SessionEvents = {
  onToken?: (text: string) => void
  onThink?: (text: string) => void
  onTool?: (name: string, input: unknown) => void
  onToolResult?: (name: string, ok: boolean, content: string) => void
  onContext?: (info: ContextInfo) => void
  onUsage?: (usage: TurnUsage) => void
  onNotice?: (notice: RuntimeNotice) => void
  /** Ask the user to approve a mutating tool call. Absent ⇒ non-interactive. */
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>
  /** Ask the user a free-form clarifying question (the AskUser tool). */
  onAskUser?: (question: string, options?: string[]) => Promise<string>
  /** Emitted once per turn in plan mode with the recorded (unexecuted) actions. */
  onPlan?: (actions: PlannedAction[]) => void
}

export type AgentLoopOptions = {
  client: ChatClient
  workspaceRoot: string
  prompt: string
  maxTurns?: number
  tools?: AnyTool[]
  effort?: EffortMode
  contextTokenBudget?: number
  permissionMode?: PermissionMode
  allow?: string[]
  hooks?: HooksConfig
  extensionSettings?: PluginSettings
  events?: SessionEvents
}

export type AgentLoopResult = {
  finalContent: string
  turns: number
  toolCalls: number
  validToolCalls: number
  repairedToolCalls: number
  compactions: number
}
