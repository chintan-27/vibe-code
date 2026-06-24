import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { readTool } from './read.ts'

describe('Read PDF routing', () => {
  test('routes .pdf through the extractor and fails gracefully on a bad PDF', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-pdf-'))
    await writeFile(join(ws, 'broken.pdf'), 'not really a pdf')
    const result = await readTool.execute({ file_path: 'broken.pdf' }, { workspaceRoot: ws })
    // The point: it took the PDF branch (didn't try utf8 line-reading) and didn't throw.
    expect(result.ok).toBe(false)
    expect(result.content.toLowerCase()).toContain('pdf')
  })
})
