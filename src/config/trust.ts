// Workspace trust. Before the agent indexes/reads/runs commands in a directory,
// the user approves it once; the decision persists in ~/.config/vibe/trust.json.
// A directory is trusted if it (or an ancestor) was approved.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

/** Canonical absolute path (resolves symlinks like macOS /private) so trust matches consistently. */
function canon(dir: string): string {
  const abs = resolve(dir)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

function configDir(): string {
  return process.env.VIBE_CONFIG_DIR ?? join(homedir(), '.config', 'vibe')
}

function trustFile(): string {
  return join(configDir(), 'trust.json')
}

function load(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), 'utf8')) as { trusted?: string[] }
    return parsed.trusted ?? []
  } catch {
    return []
  }
}

export function isTrusted(dir: string): boolean {
  if (process.env.VIBE_TRUST_ALL === '1') return true // CI / tests / opt-out
  const target = canon(dir)
  return load().some(t => target === t || target.startsWith(`${t}/`))
}

export function trustDir(dir: string): void {
  const target = canon(dir)
  const list = load()
  if (list.includes(target)) return
  list.push(target)
  mkdirSync(dirname(trustFile()), { recursive: true })
  writeFileSync(trustFile(), `${JSON.stringify({ trusted: list }, null, 2)}\n`)
}
