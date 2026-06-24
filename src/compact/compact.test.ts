import { describe, expect, test } from 'bun:test'
import type { ChatClient } from '@/loop/agentLoop.ts'
import type { ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { compactMessages, estimateMessagesTokens } from './compact.ts'

class StubClient implements ChatClient {
  public calls = 0
  constructor(private readonly summary: string) {}
  async chat(model: string, _m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    this.calls += 1
    return { model, content: this.summary, usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
  }
}

describe('compactMessages', () => {
  test('is a no-op below the token threshold', async () => {
    const client = new StubClient('summary')
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    const result = await compactMessages(client, messages, { tokenThreshold: 1_000, keepRecent: 6 })
    expect(result.compacted).toBe(false)
    expect(client.calls).toBe(0)
  })

  test('summarizes the older middle, keeps system + recent messages', async () => {
    const client = new StubClient('Goal: test. Next step: continue.')
    const filler = 'x'.repeat(400)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 10 }, (_, i): ChatMessage => ({ role: 'user', content: `${filler} ${i}` })),
    ]
    const before = estimateMessagesTokens(messages)
    const result = await compactMessages(client, messages, { tokenThreshold: 200, keepRecent: 3 })

    expect(result.compacted).toBe(true)
    expect(client.calls).toBe(1)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages[1]?.content).toContain('compacted')
    // Last three originals are preserved verbatim.
    expect(result.messages.at(-1)?.content).toContain(' 9')
    expect(estimateMessagesTokens(result.messages)).toBeLessThan(before)
  })
})
