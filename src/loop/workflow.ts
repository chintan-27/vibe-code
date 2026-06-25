import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { resolveWorkspacePath } from '@/tools/path.ts'

export type SessionMetadata = {
  id: string
  title: string
  cwd: string
  startedAt: string
  updatedAt: string
  lastUserPrompt: string
  compactSummary: string
}

export type CheckpointMetadata = {
  sessionId: string
  turn: number
  tool: string
  inputSummary: string
  touchedFiles: string[]
  timestamp: string
}

export function createSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function writeSessionMetadata(
  workspaceRoot: string,
  metadata: SessionMetadata,
): Promise<void> {
  const dir = join(workspaceRoot, '.vibe/sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${metadata.id}.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
}

export async function listSessionMetadata(workspaceRoot: string): Promise<SessionMetadata[]> {
  const dir = join(workspaceRoot, '.vibe/sessions')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const sessions = await Promise.all(
    entries
      .filter(name => name.endsWith('.json'))
      .map(async name => {
        try {
          return JSON.parse(await readFile(join(dir, name), 'utf8')) as SessionMetadata
        } catch {
          return undefined
        }
      }),
  )
  return sessions
    .filter((session): session is SessionMetadata => Boolean(session))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function createToolCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
  toolName: string,
  input: unknown,
): Promise<CheckpointMetadata | undefined> {
  if (toolName !== 'Write' && toolName !== 'Edit') return undefined
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const filePath = typeof rec.file_path === 'string' ? rec.file_path : undefined
  if (!filePath) return undefined

  const abs = resolveWorkspacePath(workspaceRoot, filePath)
  const dir = join(workspaceRoot, '.vibe/checkpoints', sessionId, String(turn))
  await mkdir(dir, { recursive: true })

  const target = join(dir, checkpointFileName(filePath))
  const content = existsSync(abs) ? await readFile(abs, 'utf8') : ''
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')

  const metadata: CheckpointMetadata = {
    sessionId,
    turn,
    tool: toolName,
    inputSummary: summarizeInput(input),
    touchedFiles: [filePath],
    timestamp: new Date().toISOString(),
  }
  await writeFile(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  return metadata
}

export async function listCheckpoints(workspaceRoot: string): Promise<CheckpointMetadata[]> {
  const root = join(workspaceRoot, '.vibe/checkpoints')
  let sessions: string[]
  try {
    sessions = await readdir(root)
  } catch {
    return []
  }
  const checkpoints: CheckpointMetadata[] = []
  for (const session of sessions) {
    const sessionDir = join(root, session)
    const turns = await readdir(sessionDir).catch(() => [])
    for (const turn of turns) {
      const metaPath = join(sessionDir, turn, 'metadata.json')
      try {
        checkpoints.push(JSON.parse(await readFile(metaPath, 'utf8')) as CheckpointMetadata)
      } catch {
        // Ignore corrupt/incomplete checkpoint records.
      }
    }
  }
  return checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

export async function restoreCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  turn: number,
): Promise<CheckpointMetadata> {
  const dir = join(workspaceRoot, '.vibe/checkpoints', sessionId, String(turn))
  const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as CheckpointMetadata
  for (const file of metadata.touchedFiles) {
    const checkpointPath = join(dir, checkpointFileName(file))
    const target = resolveWorkspacePath(workspaceRoot, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(checkpointPath, 'utf8'), 'utf8')
  }
  return metadata
}

function checkpointFileName(path: string): string {
  return `${encodeURIComponent(path.split(/[\\/]+/).join('__')) || basename(path)}.before`
}

function summarizeInput(input: unknown): string {
  try {
    const text = JSON.stringify(input)
    return text.length > 300 ? `${text.slice(0, 299)}…` : text
  } catch {
    return String(input)
  }
}
