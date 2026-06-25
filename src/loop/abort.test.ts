import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { AgentSession } from './session.ts'

/** A model client that takes a while and rejects when its AbortSignal fires. */
class SlowClient implements ChatClient {
  chat(model: string, _m: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) return reject(new Error('aborted'))
      const timer = setTimeout(
        () => resolve({ model, content: 'done', usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }),
        2_000,
      )
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    })
  }
}

describe('turn cancellation', () => {
  test('aborting the signal stops the in-flight run', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-abort-'))
    const session = new AgentSession({ client: new SlowClient(), workspaceRoot: ws, effort: 'low' })
    const controller = new AbortController()
    const run = session.run('do something', controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expect(run).rejects.toThrow(/abort/i)
  })
})
