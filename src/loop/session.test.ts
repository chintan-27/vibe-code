import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { saveMemory } from '@/memory/memdir.ts'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import type { ToolDef } from '@/tools/types.ts'
import { listSessionMetadata, readSessionState } from './workflow.ts'
import { AgentSession } from './session.ts'

class CapturingClient implements ChatClient {
  coderMessages: ChatMessage[] = []

  async chat(model: string, messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
    if (model.includes('VibeThinker')) {
      return { model, content: 'Reason about the request.', usage: { promptTokens: 0, completionTokens: 1, durationMs: 1 } }
    }
    this.coderMessages = messages
    return { model, content: 'Done.', usage: { promptTokens: 0, completionTokens: 1, durationMs: 1 } }
  }
}

describe('AgentSession context budget', () => {
  test('bounds oversized instructions and memory before model generation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-session-budget-'))
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'VIBE.md'), `# Guide\n${'instruction '.repeat(12_000)}`)
    await writeFile(join(workspace, 'src', 'main.ts'), 'export const main = () => "ok"\n')
    await saveMemory(workspace, {
      name: 'large-note', description: 'task implementation notes', type: 'project', body: 'memory '.repeat(8_000),
    })
    const client = new CapturingClient()
    const session = new AgentSession({ client, workspaceRoot: workspace, contextTokenBudget: 3_000, maxTurns: 1 })

    await session.run('implement the task')

    const system = client.coderMessages[0]?.content ?? ''
    expect(system.length).toBeLessThan(16_000)
    expect(system).toContain('Instruction file truncated to preserve model context')
    expect(system).toContain('Memory truncated to preserve model context')
  })

  test('restored sessions include prior messages in the next turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-session-restore-'))
    const client = new CapturingClient()
    const session = new AgentSession({
      client,
      workspaceRoot: workspace,
      maxTurns: 1,
      resume: {
        metadata: {
          id: 'saved',
          title: 'Saved',
          cwd: workspace,
          startedAt: '2026-06-26T00:00:00.000Z',
          updatedAt: '2026-06-26T00:00:00.000Z',
          lastUserPrompt: 'old request',
          compactSummary: 'old answer',
        },
        messages: [
          { role: 'user', content: 'old request' },
          { role: 'assistant', content: 'old answer' },
        ],
      },
    })

    await session.run('new request')

    expect(client.coderMessages.some(message => message.role === 'user' && message.content === 'old request')).toBe(true)
    expect(client.coderMessages.some(message => message.role === 'assistant' && message.content === 'old answer')).toBe(true)
    expect(client.coderMessages.some(message => message.role === 'user' && message.content === 'new request')).toBe(true)
  })

  test('research requests seed WebSearch results before generation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-session-web-'))
    const client = new CapturingClient()
    const seenTools: string[] = []
    const webSearchTool = {
      name: 'WebSearch',
      readOnly: true,
      description: 'Search the web.',
      schema: z.object({ query: z.string(), maxResults: z.number().optional() }),
      async execute() {
        return { ok: true, content: '1. Lead-DBS localization paper\n   https://example.test\n   Lead localization uses postoperative imaging and registration.' }
      },
    } satisfies ToolDef

    await new AgentSession({
      client,
      workspaceRoot: workspace,
      tools: [webSearchTool],
      effort: 'low',
      maxTurns: 1,
      events: { onTool: name => seenTools.push(name) },
    }).run('Gather information about DBS lead localization; web search if needed.')

    expect(seenTools).toEqual(['WebSearch'])
    // Results are embedded in the user message, not a separate tool message.
    expect(client.coderMessages.some(message => message.role === 'user' && message.content.includes('Lead localization uses postoperative imaging'))).toBe(true)
  })

  test('failed seeded WebSearch is surfaced and added to final-answer context', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-session-web-fail-'))
    const client = new CapturingClient()
    const notices: string[] = []
    const webSearchTool = {
      name: 'WebSearch',
      readOnly: true,
      description: 'Search the web.',
      schema: z.object({ query: z.string(), maxResults: z.number().optional() }),
      async execute() {
        return { ok: false, content: 'TAVILY_API_KEY not set' }
      },
    } satisfies ToolDef

    await new AgentSession({
      client,
      workspaceRoot: workspace,
      tools: [webSearchTool],
      effort: 'low',
      maxTurns: 1,
      events: { onNotice: notice => notices.push(`${notice.title}: ${notice.message}`) },
    }).run('I need more in depth stages, web search if needed.')

    expect(notices).toContain('WebSearch failed: TAVILY_API_KEY not set')
    // Failed search is surfaced via notice only — nothing is injected into messages.
    expect(client.coderMessages.every(message => message.role !== 'tool')).toBe(true)
  })

  test('shallow answers to in-depth math requests are retried once', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-session-detail-'))
    let calls = 0
    let retryMessages: ChatMessage[] = []
    const notices: string[] = []
    const client: ChatClient = {
      async chat(model, messages) {
        calls += 1
        retryMessages = messages
        const final = calls === 1
          ? 'This is a short summary.'
          : [
              'Scope: This is a detailed educational answer with assumptions, model limits, and practical validation notes.'.repeat(20),
              '1. Register preoperative MRI to postoperative CT.',
              '2. Segment contacts and map them into patient space.',
              '3. Use V = I / (4*pi*sigma*r), where I is current, sigma conductivity, and r distance.',
              '4. Validate against atlas and clinical response.',
              '5. Caveat: this is a simplified educational outline and should be verified against sources.'.repeat(80),
            ].join('\n')
        return {
          model,
          content: JSON.stringify({ kind: 'final', content: final }),
          usage: { promptTokens: 0, completionTokens: 10, durationMs: 1 },
        }
      },
    }

    const session = new AgentSession({
      client,
      workspaceRoot: workspace,
      effort: 'low',
      maxTurns: 2,
      events: { onNotice: notice => notices.push(notice.title) },
    })
    const result = await session.run('I need more in depth stages with math.')

    expect(result.finalContent).toContain('V = I / (4*pi*sigma*r)')
    expect(notices).toContain('Expanding shallow answer')
    expect(calls).toBe(2)
    expect(retryMessages.some(message => message.content.includes('at least 8 numbered stages'))).toBe(true)
    expect(retryMessages.some(message => message.content.includes('at least 600 words'))).toBe(true)
    const meta = (await listSessionMetadata(workspace))[0]
    expect(meta).toBeDefined()
    const saved = await readSessionState(workspace, meta?.id ?? '')
    expect(saved.messages.some(message => message.content.includes('[internal instruction]'))).toBe(false)
  })
})
