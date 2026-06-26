import { readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

const MAX_DEPTH = 32
const INCLUDE_PATTERN = /^@(.+)$/gm
/** Keep a single checked-in guide from crowding out the active task. */
export const MAX_INSTRUCTION_CHARS = 16_000

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

  entries.push({ path, content: compactInstruction(content) })
}

/**
 * Repository maps are retrieval's job. When a guide is too large, retain the
 * actionable markdown sections instead of blindly keeping its opening tree.
 */
export function compactInstruction(content: string): string {
  if (content.length <= MAX_INSTRUCTION_CHARS) return content
  const sections = splitMarkdownSections(content)
  if (sections.length === 0) return truncateInstruction(content)

  const selected = sections
    .sort((a, b) => sectionPriority(a.heading) - sectionPriority(b.heading))
    .reduce<string[]>((kept, section) => {
      const next = [...kept, section.content].join('\n\n')
      return next.length <= MAX_INSTRUCTION_CHARS ? [...kept, section.content] : kept
    }, [])
  const result = selected.join('\n\n')
  return result ? `${result}\n\n[Large instruction sections omitted to preserve model context.]` : truncateInstruction(content)
}

function splitMarkdownSections(content: string): Array<{ heading: string; content: string }> {
  const matches = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)]
  if (matches.length === 0) return []
  return matches.map((match, index) => {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? content.length
    return { heading: match[1] ?? '', content: content.slice(start, end).trim() }
  })
}

function sectionPriority(heading: string): number {
  const normalized = heading.toLowerCase()
  if (/(rules|instructions|must|workflow|command|convention|style|gotcha|development)/.test(normalized)) return 0
  if (/(overview|architecture|build|run|test|configuration|memory)/.test(normalized)) return 1
  if (/(repository structure|file tree|directory|tree|reference)/.test(normalized)) return 3
  return 2
}

function truncateInstruction(content: string): string {
  return `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[Instruction file truncated to preserve model context.]`
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
