import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { HooksConfig } from '@/hooks/hooks.ts'
import type { McpServerConfig } from '@/mcp/client.ts'
import type { PermissionMode } from '@/loop/types.ts'

export type Settings = {
  /** Default permission posture when no CLI flag is given. */
  permissionMode?: PermissionMode
  /** Sets VIBE_SEARCH_PROVIDER if not already in the environment. */
  searchProvider?: string
  /** Tools to always allow without prompting (e.g. ["Read", "Bash"]). */
  allow?: string[]
  hooks?: HooksConfig
  mcpServers?: Record<string, McpServerConfig>
  /** JSON registry files/URLs used by `/plugins add <id>`. */
  pluginRegistries?: string[]
  /** Executable plugin IDs trusted globally/project-locally. */
  trustedPlugins?: string[]
  /** Installed plugin IDs disabled by settings. */
  disabledExtensions?: string[]
}

const GLOBAL_PATH = join(homedir(), '.config', 'vibe', 'settings.json')

/** Load and merge global (~/.config/vibe) then project (<root>/.vibe) settings. */
export async function loadSettings(workspaceRoot: string): Promise<Settings> {
  const global = await readJson(GLOBAL_PATH)
  const project = await readJson(join(workspaceRoot, '.vibe', 'settings.json'))
  return mergeSettings(global, project)
}

export function mergeSettings(base: Settings, override: Settings): Settings {
  return {
    permissionMode: override.permissionMode ?? base.permissionMode,
    searchProvider: override.searchProvider ?? base.searchProvider,
    allow: [...new Set([...(base.allow ?? []), ...(override.allow ?? [])])],
    hooks: { ...base.hooks, ...override.hooks },
    mcpServers: { ...base.mcpServers, ...override.mcpServers },
    pluginRegistries: [...new Set([...(base.pluginRegistries ?? []), ...(override.pluginRegistries ?? [])])],
    trustedPlugins: [...new Set([...(base.trustedPlugins ?? []), ...(override.trustedPlugins ?? [])])],
    disabledExtensions: [...new Set([...(base.disabledExtensions ?? []), ...(override.disabledExtensions ?? [])])],
  }
}

async function readJson(path: string): Promise<Settings> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as Settings
  } catch {
    console.error(`Ignoring invalid settings file: ${path}`)
    return {}
  }
}

/** Apply non-session settings (currently the search provider env default). */
export function applyAmbientSettings(settings: Settings): void {
  if (settings.searchProvider && !process.env.VIBE_SEARCH_PROVIDER) {
    process.env.VIBE_SEARCH_PROVIDER = settings.searchProvider
  }
}
