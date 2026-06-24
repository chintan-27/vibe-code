import { readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

const MAX_DEPTH = 32
const INCLUDE_PATTERN = /^@(.+)$/gm

/** Project-instruction filenames, walked from cwd up to the filesystem root. */
const INSTRUCTION_FILES = ['VIBE.md', 'AGENTS.md']

export type InstructionEntry = {
  path: string
  content: string
}

export async function loadProjectInstructions(cwd: string): Promise<InstructionEntry[]> {
  const roots = ancestorDirs(resolve(cwd))
  const entries: InstructionEntry[] = []
  const seen = new Set<string>()

  for (const root of roots.reverse()) {
    for (const name of INSTRUCTION_FILES) {
      await loadOne(join(root, name), entries, seen, 0)
    }
  }

  return entries
}

async function loadOne(
  path: string,
  entries: InstructionEntry[],
  seen: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH || seen.has(path)) return
  seen.add(path)

  const content = await readFile(path, 'utf8').catch(() => undefined)
  if (content === undefined) return

  for (const match of content.matchAll(INCLUDE_PATTERN)) {
    const includePath = match[1]?.trim()
    if (!includePath) continue
    const resolved = includePath.startsWith('/')
      ? includePath
      : join(dirname(path), includePath.replace(/^.\//, ''))
    await loadOne(resolved, entries, seen, depth + 1)
  }

  entries.push({ path, content })
}

function ancestorDirs(start: string): string[] {
  const dirs = [start]
  let current = start
  while (dirname(current) !== current) {
    current = dirname(current)
    dirs.push(current)
  }
  return dirs
}
