import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { loadSettings, mergeSettings } from './settings.ts'

describe('mergeSettings', () => {
  test('override wins for scalars; arrays/objects merge', () => {
    const merged = mergeSettings(
      { permissionMode: 'auto', allow: ['Read'], hooks: { PreToolUse: [{ command: 'a' }] } },
      { permissionMode: 'plan', allow: ['Bash'], mcpServers: { x: { command: 'y' } } },
    )
    expect(merged.permissionMode).toBe('plan')
    expect([...(merged.allow ?? [])].sort()).toEqual(['Bash', 'Read'])
    expect(merged.hooks?.PreToolUse).toHaveLength(1)
    expect(merged.mcpServers?.x?.command).toBe('y')
  })
})

describe('loadSettings', () => {
  test('reads a project .vibe/settings.json', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-settings-'))
    await mkdir(join(ws, '.vibe'), { recursive: true })
    await writeFile(join(ws, '.vibe', 'settings.json'), JSON.stringify({ allow: ['Read'], permissionMode: 'acceptEdits' }))
    const settings = await loadSettings(ws)
    expect(settings.allow).toContain('Read')
    expect(settings.permissionMode).toBe('acceptEdits')
  })

  test('returns empty settings when no files exist', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-settings-'))
    const settings = await loadSettings(ws)
    expect(settings.allow).toEqual([])
  })
})
