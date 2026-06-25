import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { createToolCheckpoint, listCheckpoints, listSessionMetadata, restoreCheckpoint, writeSessionMetadata } from './workflow.ts'

describe('workflow persistence', () => {
  test('mutating tools create checkpoints before edits', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-workflow-'))
    await writeFile(join(ws, 'file.txt'), 'before', 'utf8')

    const checkpoint = await createToolCheckpoint(ws, 'session-a', 1, 'Edit', { file_path: 'file.txt' })
    expect(checkpoint?.touchedFiles).toEqual(['file.txt'])
    const checkpoints = await listCheckpoints(ws)
    expect(checkpoints[0]?.tool).toBe('Edit')
    const saved = await readFile(join(ws, '.vibe/checkpoints/session-a/1/file.txt.before'), 'utf8')
    expect(saved).toBe('before')
    await writeFile(join(ws, 'file.txt'), 'after', 'utf8')
    await restoreCheckpoint(ws, 'session-a', 1)
    expect(await readFile(join(ws, 'file.txt'), 'utf8')).toBe('before')
  })

  test('session metadata is listed newest first', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-sessions-'))
    await mkdir(join(ws, '.vibe/sessions'), { recursive: true })
    await writeSessionMetadata(ws, {
      id: 'old',
      title: 'Old',
      cwd: ws,
      startedAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      lastUserPrompt: 'old',
      compactSummary: '',
    })
    await writeSessionMetadata(ws, {
      id: 'new',
      title: 'New',
      cwd: ws,
      startedAt: '2024-01-02T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
      lastUserPrompt: 'new',
      compactSummary: '',
    })

    const sessions = await listSessionMetadata(ws)
    expect(sessions.map(s => s.id)).toEqual(['new', 'old'])
  })
})
