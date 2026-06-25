import { existsSync } from 'fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { homedir, tmpdir } from 'os'
import type { McpServerConfig } from '@/mcp/client.ts'

export type ExtensionKind = 'skill' | 'mcp' | 'js' | 'bundle'
export type ExtensionTrustState = 'text' | 'untrusted' | 'trusted'
export type ExtensionInstallSource =
  | { type: 'path'; value: string }
  | { type: 'git'; value: string }
  | { type: 'registry'; value: string }

export type ExtensionManifest = {
  id: string
  name?: string
  version?: string
  kind?: ExtensionKind
  description?: string
  instructions?: string
  main?: string
  mcpServers?: Record<string, McpServerConfig>
}

export type InstalledExtension = {
  id: string
  source: ExtensionInstallSource
  path: string
  manifest: ExtensionManifest
  enabled: boolean
  trusted: ExtensionTrustState
  installedAt: string
}

export type RegistryIndexEntry = {
  id: string
  source: string
  description?: string
}

export type PluginSettings = {
  pluginRegistries?: string[]
  trustedPlugins?: string[]
  disabledExtensions?: string[]
}

const MANIFEST_NAMES = ['vibe-plugin.json', 'plugin.json', 'skill.json']
const GLOBAL_PLUGIN_DIR = join(homedir(), '.config', 'vibe', 'plugins')

export async function installExtension(
  workspaceRoot: string,
  sourceText: string,
  settings: PluginSettings = {},
): Promise<InstalledExtension> {
  const source = parseInstallSource(sourceText)
  const installRoot = projectPluginDir(workspaceRoot)
  await mkdir(installRoot, { recursive: true })
  const sourcePath = await materializeSource(workspaceRoot, source, settings)
  const manifest = await readManifest(sourcePath)
  const target = join(installRoot, manifest.id)
  await rm(target, { recursive: true, force: true })
  await cp(sourcePath, target, { recursive: true })
  const installed: InstalledExtension = {
    id: manifest.id,
    source,
    path: target,
    manifest,
    enabled: true,
    trusted: requiresTrust(manifest) ? 'untrusted' : 'text',
    installedAt: new Date().toISOString(),
  }
  await writeRecord(target, installed)
  return installed
}

export async function listExtensions(workspaceRoot: string, settings: PluginSettings = {}): Promise<InstalledExtension[]> {
  const roots = [GLOBAL_PLUGIN_DIR, projectPluginDir(workspaceRoot)]
  const all: InstalledExtension[] = []
  for (const root of roots) {
    const names = await readdir(root).catch(() => [])
    for (const name of names) {
      const record = await readRecord(join(root, name)).catch(() => undefined)
      if (!record) continue
      all.push(applySettings(record, settings))
    }
  }
  return all.sort((a, b) => a.id.localeCompare(b.id))
}

export async function setExtensionEnabled(workspaceRoot: string, id: string, enabled: boolean): Promise<InstalledExtension> {
  return updateExtension(workspaceRoot, id, record => ({ ...record, enabled }))
}

export async function trustExtension(workspaceRoot: string, id: string): Promise<InstalledExtension> {
  return updateExtension(workspaceRoot, id, record => ({ ...record, trusted: 'trusted' }))
}

export async function removeExtension(workspaceRoot: string, id: string): Promise<void> {
  const path = await findExtensionPath(workspaceRoot, id)
  if (!path) throw new Error(`plugin not found: ${id}`)
  await rm(path, { recursive: true, force: true })
}

export async function renderExtensionInstructions(workspaceRoot: string, settings: PluginSettings = {}): Promise<string> {
  const extensions = (await listExtensions(workspaceRoot, settings)).filter(extension => extension.enabled)
  const blocks: string[] = []
  for (const extension of extensions) {
    const instructions = await loadInstructions(extension)
    if (!instructions.trim()) continue
    blocks.push(`## ${extension.manifest.name ?? extension.id}\n${instructions.trim()}`)
  }
  return blocks.length === 0 ? '' : ['# Enabled Skills and Plugin Instructions', ...blocks].join('\n\n')
}

export async function loadTrustedPluginMcpServers(
  workspaceRoot: string,
  settings: PluginSettings = {},
): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {}
  for (const extension of await listExtensions(workspaceRoot, settings)) {
    if (!extension.enabled || extension.trusted !== 'trusted' || !extension.manifest.mcpServers) continue
    for (const [name, config] of Object.entries(extension.manifest.mcpServers)) {
      servers[`${extension.id}.${name}`] = config
    }
  }
  return servers
}

export async function extensionSummary(workspaceRoot: string, settings: PluginSettings = {}): Promise<string> {
  const extensions = await listExtensions(workspaceRoot, settings)
  if (extensions.length === 0) return 'No plugins installed.'
  return extensions
    .map(extension => {
      const state = extension.enabled ? 'enabled' : 'disabled'
      return `${extension.id}  ${extension.manifest.kind ?? 'skill'}  ${state}  ${extension.trusted}  ${extension.path}`
    })
    .join('\n')
}

export async function extensionInfo(workspaceRoot: string, id: string, settings: PluginSettings = {}): Promise<string> {
  const extension = (await listExtensions(workspaceRoot, settings)).find(item => item.id === id)
  if (!extension) throw new Error(`plugin not found: ${id}`)
  return [
    `id: ${extension.id}`,
    `name: ${extension.manifest.name ?? extension.id}`,
    `kind: ${extension.manifest.kind ?? 'skill'}`,
    `version: ${extension.manifest.version ?? '0.0.0'}`,
    `enabled: ${extension.enabled}`,
    `trusted: ${extension.trusted}`,
    `source: ${extension.source.type}:${extension.source.value}`,
    `path: ${extension.path}`,
    extension.manifest.description ? `description: ${extension.manifest.description}` : '',
  ].filter(Boolean).join('\n')
}

function parseInstallSource(source: string): ExtensionInstallSource {
  if (/^https?:\/\/.+\.git$/.test(source) || /^git@/.test(source) || /^github:[\w.-]+\/[\w.-]+/.test(source)) {
    return { type: 'git', value: source }
  }
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) return { type: 'path', value: source }
  return { type: 'registry', value: source }
}

async function materializeSource(
  workspaceRoot: string,
  source: ExtensionInstallSource,
  settings: PluginSettings,
): Promise<string> {
  if (source.type === 'path') return resolvePath(workspaceRoot, source.value)
  if (source.type === 'registry') {
    const entry = await resolveRegistryEntry(source.value, settings)
    return materializeSource(workspaceRoot, parseInstallSource(entry.source), settings)
  }
  const url = source.value.startsWith('github:')
    ? `https://github.com/${source.value.slice('github:'.length)}.git`
    : source.value
  const target = join(tmpdir(), 'vibe-plugin-clones', `${Date.now()}-${basename(url).replace(/\.git$/, '')}`)
  await mkdir(dirname(target), { recursive: true })
  const result = Bun.spawnSync(['git', 'clone', '--depth', '1', url, target])
  if (result.exitCode !== 0) throw new Error(`git clone failed: ${result.stderr.toString().trim()}`)
  return target
}

async function resolveRegistryEntry(id: string, settings: PluginSettings): Promise<RegistryIndexEntry> {
  for (const registry of settings.pluginRegistries ?? []) {
    const raw = await readRegistry(registry)
    const entries = Array.isArray(raw) ? raw : Array.isArray(raw.plugins) ? raw.plugins : []
    const match = entries.find((entry: RegistryIndexEntry) => entry.id === id)
    if (match) return match
  }
  throw new Error(`plugin "${id}" was not found in configured registries`)
}

async function readRegistry(source: string): Promise<any> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`registry fetch failed (${response.status}): ${source}`)
    return response.json()
  }
  return JSON.parse(await readFile(resolvePath(process.cwd(), source), 'utf8'))
}

async function readManifest(root: string): Promise<ExtensionManifest> {
  for (const name of MANIFEST_NAMES) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const raw = JSON.parse(await readFile(path, 'utf8')) as ExtensionManifest
    if (!raw.id || !/^[a-zA-Z0-9._-]+$/.test(raw.id)) throw new Error(`invalid plugin id in ${path}`)
    return { kind: 'skill', ...raw }
  }
  throw new Error(`no plugin manifest found in ${root}`)
}

async function loadInstructions(extension: InstalledExtension): Promise<string> {
  const inline = extension.manifest.instructions ?? ''
  const skillMd = await readFile(join(extension.path, 'SKILL.md'), 'utf8').catch(() => '')
  return [inline, skillMd].filter(Boolean).join('\n\n')
}

function requiresTrust(manifest: ExtensionManifest): boolean {
  return Boolean(manifest.main || manifest.mcpServers || manifest.kind === 'js' || manifest.kind === 'mcp' || manifest.kind === 'bundle')
}

function applySettings(record: InstalledExtension, settings: PluginSettings): InstalledExtension {
  return {
    ...record,
    enabled: settings.disabledExtensions?.includes(record.id) ? false : record.enabled,
    trusted: settings.trustedPlugins?.includes(record.id) ? 'trusted' : record.trusted,
  }
}

async function updateExtension(
  workspaceRoot: string,
  id: string,
  update: (record: InstalledExtension) => InstalledExtension,
): Promise<InstalledExtension> {
  const path = await findExtensionPath(workspaceRoot, id)
  if (!path) throw new Error(`plugin not found: ${id}`)
  const next = update(await readRecord(path))
  await writeRecord(path, next)
  return next
}

async function findExtensionPath(workspaceRoot: string, id: string): Promise<string | undefined> {
  for (const root of [projectPluginDir(workspaceRoot), GLOBAL_PLUGIN_DIR]) {
    const path = join(root, id)
    if (existsSync(join(path, 'installed.json'))) return path
  }
  return undefined
}

async function readRecord(path: string): Promise<InstalledExtension> {
  return JSON.parse(await readFile(join(path, 'installed.json'), 'utf8')) as InstalledExtension
}

async function writeRecord(path: string, record: InstalledExtension): Promise<void> {
  await writeFile(join(path, 'installed.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function projectPluginDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.vibe', 'plugins')
}

function resolvePath(workspaceRoot: string, value: string): string {
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value
  return isAbsolute(expanded) ? expanded : resolve(workspaceRoot, expanded)
}
