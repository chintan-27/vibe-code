import type { ChatClient } from '@/loop/types.ts'
import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'

const CHARS_PER_TOKEN = 4

export function sanitizeTranscript(content: string): string {
  return stripThinkBlocks(content)
}

/** Cheap token estimate for a single string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Cheap token estimate for a whole message array (role + content). */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.role + message.content) + 4, 0)
}

export type CompactOptions = {
  /** Compact once the conversation (excluding system) exceeds this many tokens. */
  tokenThreshold: number
  /** Always keep this many of the most recent messages verbatim. */
  keepRecent: number
}

/**
 * Keep the system message and the most recent turns verbatim; replace the older
 * middle with a terse model-written summary. No-op until the threshold is crossed.
 * The persisted transcript is already <think>-free (the loop strips per turn).
 */
export async function compactMessages(
  client: ChatClient,
  messages: ChatMessage[],
  options: CompactOptions,
): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
  const [system, ...rest] = messages
  if (!system || estimateMessagesTokens(rest) <= options.tokenThreshold) {
    return { messages, compacted: false }
  }

  const keep = Math.min(options.keepRecent, rest.length)
  const older = rest.slice(0, rest.length - keep)
  const recent = rest.slice(rest.length - keep)
  if (older.length === 0) return { messages, compacted: false }

  const summary = await summarizeMessages(client, older)
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `# Summary of earlier work (compacted)\n${summary}`,
  }
  return { messages: [system, summaryMessage, ...recent], compacted: true }
}

/** Ask the fast/low-temp model for a terse, structured running-state summary. */
export async function summarizeMessages(client: ChatClient, messages: ChatMessage[]): Promise<string> {
  const profile = getModelProfile('extractor')
  const transcript = messages
    .map(message => `${message.role}${message.toolName ? `(${message.toolName})` : ''}: ${message.content}`)
    .join('\n\n')

  const response = await client.chat(
    profile.model,
    [
      {
        role: 'system',
        content:
          'Summarize the coding session so far for an agent that will continue it. Be terse and factual. Use these sections:\n' +
          'Goal: the user request.\n' +
          'Files touched: paths and what changed.\n' +
          'Decisions: choices made and why.\n' +
          'Current state: what is done vs not.\n' +
          'Next step: the immediate next action.\n' +
          'Do not include code blocks or hidden reasoning.',
      },
      { role: 'user', content: transcript },
    ],
    { ...profile.defaults, maxTokens: 512 },
  )
  return stripThinkBlocks(response.content).trim() || '[no summary produced]'
}
