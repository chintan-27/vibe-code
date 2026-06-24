import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import type { PermissionDecision, PlannedAction } from './types.ts'
import { AgentSession } from './session.ts'

/** Emits a Write tool call on the first turn, then a plain answer. */
class WriteThenDone implements ChatClient {
  private i = 0
  constructor(private readonly file = 'out.txt') {}
  async chat(model: string, _m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    // VibeThinker (reasoner) just "thinks"; qwen (extractor) emits the scripted action.
    if (model.includes('VibeThinker')) {
      return { model, content: 'Reasoning: write the file.', usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
    }
    const outputs = [
      `{"name":"Write","arguments":{"file_path":"${this.file}","content":"hello"}}`,
      'Done.',
    ]
    const content = outputs[this.i] ?? 'Done.'
    this.i += 1
    return { model, content, usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
  }
}

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vibe-perm-'))
}

describe('permission gate', () => {
  test('auto mode writes without asking', async () => {
    const root = await ws()
    const session = new AgentSession({ client: new WriteThenDone(), workspaceRoot: root, permissionMode: 'auto' })
    await session.run('make the file')
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello')
  })

  test('default mode runs the write when approved', async () => {
    const root = await ws()
    const session = new AgentSession({
      client: new WriteThenDone(),
      workspaceRoot: root,
      permissionMode: 'default',
      events: { onPermissionRequest: async () => 'allow' as PermissionDecision },
    })
    await session.run('make the file')
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('hello')
  })

  test('default mode does NOT write when denied', async () => {
    const root = await ws()
    let asked = false
    const session = new AgentSession({
      client: new WriteThenDone(),
      workspaceRoot: root,
      permissionMode: 'default',
      events: {
        onPermissionRequest: async () => {
          asked = true
          return 'deny'
        },
      },
    })
    await session.run('make the file')
    expect(asked).toBe(true)
    expect(await readFile(join(root, 'out.txt'), 'utf8').catch(() => 'MISSING')).toBe('MISSING')
  })

  test('plan mode records the action without writing', async () => {
    const root = await ws()
    let planned: PlannedAction[] = []
    const session = new AgentSession({
      client: new WriteThenDone(),
      workspaceRoot: root,
      permissionMode: 'plan',
      events: { onPlan: actions => (planned = actions) },
    })
    await session.run('make the file')
    expect(await readFile(join(root, 'out.txt'), 'utf8').catch(() => 'MISSING')).toBe('MISSING')
    expect(planned).toHaveLength(1)
    expect(planned[0]?.tool).toBe('Write')
  })
})
