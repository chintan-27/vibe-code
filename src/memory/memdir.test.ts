import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { loadMemories, renderMemoryPrompt, saveMemory, selectRelevantMemories } from './memdir.ts'

describe('memory directory', () => {
  test('saves and reloads a memory with frontmatter', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-mem-'))
    await saveMemory(ws, {
      name: 'auth-flow',
      description: 'How login works',
      type: 'project',
      body: 'Sessions use JWT stored in cookies.',
    })

    const memories = await loadMemories(ws)
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ name: 'auth-flow', type: 'project' })
    expect(memories[0]?.body).toContain('JWT')
  })

  test('selects relevant memories by query and renders them', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-mem-'))
    await saveMemory(ws, { name: 'auth-flow', description: 'login and JWT sessions', type: 'project', body: 'token details' })
    await saveMemory(ws, { name: 'styling', description: 'CSS theme tokens', type: 'reference', body: 'colors' })

    const memories = await loadMemories(ws)
    const relevant = selectRelevantMemories(memories, 'how does JWT login work', 5)
    expect(relevant[0]?.name).toBe('auth-flow')

    const prompt = renderMemoryPrompt(relevant)
    expect(prompt).toContain('auth-flow')
    expect(renderMemoryPrompt([])).toContain('[none]')
  })

  test('bounds oversized memory before adding it to a prompt', () => {
    const prompt = renderMemoryPrompt([{
      name: 'large', description: 'large memory', type: 'project', file: 'large.md', body: 'x'.repeat(20_000),
    }])

    expect(prompt.length).toBeLessThan(8_200)
    expect(prompt).toContain('Memory truncated to preserve model context')
  })
})
