import { AgentSession } from './session.ts'
import type { AgentLoopOptions, AgentLoopResult } from './types.ts'

export type { ChatClient, AgentLoopOptions, AgentLoopResult, EffortMode } from './types.ts'

/** One-shot convenience wrapper: a single user request through a fresh session. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const session = new AgentSession({
    client: options.client,
    workspaceRoot: options.workspaceRoot,
    tools: options.tools,
    effort: options.effort,
    maxTurns: options.maxTurns,
    contextTokenBudget: options.contextTokenBudget,
    permissionMode: options.permissionMode,
    allow: options.allow,
    hooks: options.hooks,
    extensionSettings: options.extensionSettings,
    events: options.events,
  })
  return session.run(options.prompt)
}
