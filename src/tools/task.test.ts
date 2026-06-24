import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { taskTool } from './task.ts'

class StubClient implements ChatClient {
  async chat(model: string, _m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    return { model, content: 'Subtask handled.', usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
  }
}

describe('Task subagent tool', () => {
  test('runs a sub-session and returns its final content', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-task-'))
    const result = await taskTool.execute(
      { description: 'inspect', prompt: 'look around' },
      { workspaceRoot: ws, client: new StubClient(), spawnDepth: 0 },
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Subtask handled.')
    expect(result.content).toContain('inspect')
  })

  test('refuses to spawn past the depth limit', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-task-'))
    const result = await taskTool.execute(
      { description: 'deep', prompt: 'recurse' },
      { workspaceRoot: ws, client: new StubClient(), spawnDepth: 2 },
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('depth limit')
  })

  test('fails gracefully without a client', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-task-'))
    const result = await taskTool.execute(
      { description: 'no client', prompt: 'x' },
      { workspaceRoot: ws },
    )
    expect(result.ok).toBe(false)
  })
})
