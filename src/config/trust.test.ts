import { mkdir, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, test } from 'bun:test'
import { isTrusted, trustDir } from './trust.ts'

afterEach(() => {
  delete process.env.VIBE_CONFIG_DIR
})

describe('workspace trust', () => {
  test('trusting a folder trusts its subfolders but not siblings', async () => {
    process.env.VIBE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'vibe-trust-cfg-'))
    delete process.env.VIBE_TRUST_ALL
    const root = await mkdtemp(join(tmpdir(), 'vibe-proj-'))
    const sub = join(root, 'src', 'deep')
    await mkdir(sub, { recursive: true })

    expect(isTrusted(root)).toBe(false)
    trustDir(root)
    expect(isTrusted(root)).toBe(true)
    expect(isTrusted(sub)).toBe(true) // subfolder of a trusted folder

    const sibling = await mkdtemp(join(tmpdir(), 'vibe-other-'))
    expect(isTrusted(sibling)).toBe(false)
  })
})
