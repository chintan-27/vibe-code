import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type Memory = {
  name: string
  description: string
  type: MemoryType
  body: string
  file: string
}

const MEMORY_TYPES: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference'])
const MAX_MEMORY_PROMPT_CHARS = 8_000

/** Per-workspace memory directory: `<workspace>/.vibe/memory`. */
export function memoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.vibe', 'memory')
}

export async function loadMemories(workspaceRoot: string): Promise<Memory[]> {
  const dir = memoryDir(workspaceRoot)
  const files = await readdir(dir).catch(() => [] as string[])
  const memories: Memory[] = []
  for (const file of files) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue
    const raw = await readFile(join(dir, file), 'utf8').catch(() => '')
    const parsed = parseMemory(raw, file)
    if (parsed) memories.push(parsed)
  }
  return memories
}

/** Lexical relevance: term overlap across name, description, and body. */
export function selectRelevantMemories(memories: Memory[], query: string, limit = 5): Memory[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_$]+/).filter(term => term.length > 1))]
  if (terms.length === 0) return []
  return memories
    .map(memory => ({ memory, score: scoreMemory(memory, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.memory)
}

export function renderMemoryPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '# Memory\n[none]'
  const prompt = [
    '# Memory (durable notes about this project)',
    ...memories.map(memory => `## ${memory.name} [${memory.type}]\n${memory.description}\n${memory.body}`.trim()),
  ].join('\n\n')
  if (prompt.length <= MAX_MEMORY_PROMPT_CHARS) return prompt
  return `${prompt.slice(0, MAX_MEMORY_PROMPT_CHARS)}\n\n[Memory truncated to preserve model context.]`
}

export async function saveMemory(
  workspaceRoot: string,
  memory: Omit<Memory, 'file'> & { file?: string },
): Promise<string> {
  const dir = memoryDir(workspaceRoot)
  await mkdir(dir, { recursive: true })
  const file = memory.file ?? `${slug(memory.name)}.md`
  const content = `---\nname: ${memory.name}\ndescription: ${memory.description}\ntype: ${memory.type}\n---\n\n${memory.body}\n`
  await writeFile(join(dir, file), content, 'utf8')
  return file
}

function scoreMemory(memory: Memory, terms: string[]): number {
  const name = memory.name.toLowerCase()
  const description = memory.description.toLowerCase()
  const body = memory.body.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += 4
    if (description.includes(term)) score += 3
    if (body.includes(term)) score += 1
  }
  return score
}

function parseMemory(raw: string, file: string): Memory | undefined {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return undefined
  const front = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  const fields = Object.fromEntries(
    front
      .split('\n')
      .map(line => line.match(/^([A-Za-z_]+):\s*(.*)$/))
      .filter((value): value is RegExpMatchArray => Boolean(value))
      .map(value => [value[1], (value[2] ?? '').trim()]),
  )
  const name = fields.name
  const description = fields.description ?? ''
  const type = fields.type ?? 'project'
  if (!name || !MEMORY_TYPES.has(type)) return undefined
  return { name, description, type: type as MemoryType, body, file }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'memory'
}
