import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import {
  extensionSummary,
  installExtension,
  renderExtensionInstructions,
  loadTrustedPluginMcpServers,
  trustExtension,
} from './manager.ts'

describe('plugin manager', () => {
  test('installs a local skill and renders its instructions', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-plugin-ws-'))
    const source = await mkdtemp(join(tmpdir(), 'vibe-plugin-src-'))
    await writeFile(join(source, 'skill.json'), JSON.stringify({ id: 'threejs-app', kind: 'skill', name: 'Three.js App' }))
    await writeFile(join(source, 'SKILL.md'), 'Build immersive Three.js apps with real controls.')

    const installed = await installExtension(ws, source)

    expect(installed.id).toBe('threejs-app')
    expect(installed.trusted).toBe('text')
    expect(await extensionSummary(ws)).toContain('threejs-app')
    expect(await renderExtensionInstructions(ws)).toContain('Build immersive Three.js apps')
  })

  test('executable plugins require explicit trust', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-plugin-ws-'))
    const source = await mkdtemp(join(tmpdir(), 'vibe-plugin-src-'))
    await writeFile(join(source, 'vibe-plugin.json'), JSON.stringify({ id: 'local-tools', kind: 'js', main: 'index.ts' }))

    const installed = await installExtension(ws, source)
    expect(installed.trusted).toBe('untrusted')

    const trusted = await trustExtension(ws, 'local-tools')
    expect(trusted.trusted).toBe('trusted')
  })

  test('trusted MCP plugins expose namespaced server configs', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-plugin-ws-'))
    const source = await mkdtemp(join(tmpdir(), 'vibe-plugin-src-'))
    await writeFile(join(source, 'vibe-plugin.json'), JSON.stringify({
      id: 'db-tools',
      kind: 'mcp',
      mcpServers: { sqlite: { command: 'vibe-sqlite-mcp' } },
    }))

    await installExtension(ws, source)
    expect(await loadTrustedPluginMcpServers(ws)).toEqual({})
    await trustExtension(ws, 'db-tools')

    expect(await loadTrustedPluginMcpServers(ws)).toEqual({
      'db-tools.sqlite': { command: 'vibe-sqlite-mcp' },
    })
  })

  test('installs from a configured registry entry', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-plugin-ws-'))
    const source = await mkdtemp(join(tmpdir(), 'vibe-plugin-src-'))
    await mkdir(join(ws, '.vibe'), { recursive: true })
    await writeFile(join(source, 'skill.json'), JSON.stringify({ id: 'registry-skill', kind: 'skill' }))
    const registry = join(ws, 'registry.json')
    await writeFile(registry, JSON.stringify({ plugins: [{ id: 'registry-skill', source }] }))

    const installed = await installExtension(ws, 'registry-skill', { pluginRegistries: [registry] })

    expect(installed.id).toBe('registry-skill')
  })
})
