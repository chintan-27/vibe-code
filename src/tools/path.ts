import { relative, resolve } from 'path'

export function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot)
  const resolved = resolve(root, inputPath)
  const rel = relative(root, resolved)
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) {
    return resolved
  }
  throw new Error(`path escapes workspace: ${inputPath}`)
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return relative(resolve(workspaceRoot), resolve(absolutePath)) || '.'
}

