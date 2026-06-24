import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { bashTool } from './bash.ts'
import { editTool } from './edit.ts'
import { readTool } from './read.ts'
import { resolveWorkspacePath } from './path.ts'

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vibe-code-tools-'))
}

describe('workspace path guard', () => {
  test('rejects paths outside the workspace', async () => {
    const workspace = await tempWorkspace()
    expect(() => resolveWorkspacePath(workspace, '../outside.txt')).toThrow(
      'path escapes workspace',
    )
  })
})

describe('file tools', () => {
  test('reads numbered lines', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree', 'utf8')
    const result = await readTool.execute(
      { file_path: 'a.txt', offset: 2, limit: 1 },
      { workspaceRoot: workspace },
    )
    expect(result.content).toBe('2\ttwo')
  })

  test('edits exactly one occurrence', async () => {
    const workspace = await tempWorkspace()
    await writeFile(join(workspace, 'a.txt'), 'hello world', 'utf8')
    const result = await editTool.execute(
      { file_path: 'a.txt', old_string: 'world', new_string: 'agent' },
      { workspaceRoot: workspace },
    )
    expect(result.ok).toBe(true)
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('hello agent')
  })
})

describe('bash tool', () => {
  test('rejects destructive recursive removal', async () => {
    const workspace = await tempWorkspace()
    const result = await bashTool.execute(
      { command: 'rm -rf important' },
      { workspaceRoot: workspace },
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('workspace-safe policy')
  })
})

