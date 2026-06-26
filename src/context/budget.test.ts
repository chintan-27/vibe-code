import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { dumpContext } from './budget.ts'

describe('dumpContext', () => {
  test('includes repo map symbols and retrieved snippets', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-code-context-'))
    await mkdir(join(workspace, 'src'))
    await writeFile(
      join(workspace, 'src', 'alpha.ts'),
      'export function makeAlpha() {\n  return "alpha"\n}\n',
      'utf8',
    )

    const result = await dumpContext(workspace, 'make alpha')
    expect(result.content).toContain('src/alpha.ts')
    expect(result.content).toContain('makeAlpha')
    expect(result.approxTokens).toBeGreaterThan(0)
    expect(result.source).toBe('fallback')
  })

  test('never exceeds a small context allocation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vibe-code-budget-'))
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'large.ts'), `export const value = '${'x'.repeat(20_000)}'\n`, 'utf8')

    const result = await dumpContext(workspace, 'value', 100)

    expect(result.approxTokens).toBeLessThanOrEqual(100)
  })
})
