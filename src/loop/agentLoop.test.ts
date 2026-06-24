import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { runAgentLoop, type ChatClient } from './agentLoop.ts'

class FakeClient implements ChatClient {
  private index = 0

  constructor(private readonly outputs: string[]) {}

  async chat(
    model: string,
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): Promise<ChatResult> {
    // VibeThinker (reasoner) just "thinks"; qwen (extractor) emits the scripted action.
    if (model.includes('VibeThinker')) {
      return { model, content: 'Reasoning: perform the next step.', usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
    }
    const content = this.outputs[this.index] ?? 'done'
    this.index += 1
    return {
      model,
      content,
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 },
    }
  }
}

describe('runAgentLoop', () => {
  test('executes a validated edit tool call and finishes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-code-loop-'))
    await writeFile(join(workspace, 'file.txt'), 'hello world', 'utf8')
    const client = new FakeClient([
      '{"name":"Edit","arguments":{"path":"file.txt","oldString":"world","newString":"agent"}}',
      'Done.',
    ])

    const result = await runAgentLoop({
      client,
      workspaceRoot: workspace,
      prompt: 'change world to agent',
      maxTurns: 3,
    })

    expect(result.toolCalls).toBe(1)
    expect(result.validToolCalls).toBe(1)
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('hello agent')
  })

  test('feeds tool execution errors back into the loop', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-code-loop-'))
    await writeFile(join(workspace, 'file.txt'), 'hello world', 'utf8')
    const client = new FakeClient([
      '{"name":"Edit","arguments":{"path":"/path/to/file","oldString":"world","newString":"agent"}}',
      '{"name":"Edit","arguments":{"path":"file.txt","oldString":"world","newString":"agent"}}',
      'Done.',
    ])

    const result = await runAgentLoop({
      client,
      workspaceRoot: workspace,
      prompt: 'change world to agent',
      maxTurns: 4,
    })

    expect(result.toolCalls).toBe(2)
    expect(result.validToolCalls).toBe(2)
    expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('hello agent')
  })
})
