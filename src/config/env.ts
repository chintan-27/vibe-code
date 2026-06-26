import { readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ORIGINAL_ENV_KEYS = new Set(Object.keys(process.env))
const LOADED_FILES = new Set<string>()
const CHECKED_FILES = new Set<string>()
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Load env files for installed `vibe` binaries too. Bun's automatic .env
 * loading is tied to specific launch paths, so the CLI owns it.
 *
 * Precedence, lowest to highest:
 *   1. ~/.config/vibe/.env(.local)      shared credentials for every workspace
 *   2. app root .env(.local)            useful during local `bun link`/dev
 *   3. workspace .env(.local)           project override
 *
 * Real shell environment variables still win over all files.
 */
export function loadEnvFiles(workspaceRoot: string): void {
  const dirs = [
    join(homedir(), '.config', 'vibe'),
    APP_ROOT,
    workspaceRoot,
  ]
  for (const dir of [...new Set(dirs)]) loadEnvDirectory(dir)
}

export function envFilesChecked(): string[] {
  return [...CHECKED_FILES]
}

export function envFilesLoaded(): string[] {
  return [...LOADED_FILES]
}

function loadEnvDirectory(dir: string): void {
  for (const name of ['.env', '.env.local']) {
    const path = join(dir, name)
    CHECKED_FILES.add(path)
    if (LOADED_FILES.has(path)) continue
    const raw = readFile(path)
    if (raw === undefined) continue
    LOADED_FILES.add(path)
    for (const [key, value] of parseEnv(raw)) {
      if (!ORIGINAL_ENV_KEYS.has(key)) process.env[key] = value
    }
  }
}

export function parseEnv(raw: string): Array<[string, string]> {
  const values: Array<[string, string]> = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    if (!key) continue
    const rawValue = match[2] ?? ''
    values.push([key, unquote(rawValue.trim())])
  }
  return values
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  const hash = value.indexOf(' #')
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value
}

function readFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
