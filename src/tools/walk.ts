import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

export const SKIP_DIRS = new Set([
  'node_modules', 'claude-code', 'dist', 'build', 'vendor', 'target',
  'Library', 'Applications', 'CloudStorage', 'OneDrive', 'Dropbox', '__pycache__',
])

/**
 * Recursively visit files under `dir`, skipping hidden entries, symlinks, and SKIP_DIRS.
 * `visit` returns false to stop the walk early (e.g. once a result limit is hit).
 */
export async function walkFiles(dir: string, visit: (file: string) => Promise<boolean>): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return true // unreadable directory (permissions / cloud timeout) — skip, keep going
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!(await walkFiles(fullPath, visit))) return false
    } else if (entry.isFile()) {
      if (!(await visit(fullPath))) return false
    }
  }
  return true
}
