import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'bun:test'
import { envFilesChecked, loadEnvFiles, parseEnv } from './env.ts'

const touched = ['VIBE_ENV_TEST_KEY', 'VIBE_ENV_TEST_LOCAL', 'VIBE_ENV_TEST_QUOTED', 'TAVILY_API_KEY']

afterEach(() => {
  for (const key of touched) delete process.env[key]
})

describe('parseEnv', () => {
  test('parses comments, exports, quotes, and inline comments', () => {
    expect(parseEnv(`
# comment
VIBE_ENV_TEST_KEY=plain # trailing comment
export VIBE_ENV_TEST_LOCAL='local value'
VIBE_ENV_TEST_QUOTED="line\\nnext"
bad-name=value
`)).toEqual([
      ['VIBE_ENV_TEST_KEY', 'plain'],
      ['VIBE_ENV_TEST_LOCAL', 'local value'],
      ['VIBE_ENV_TEST_QUOTED', 'line\nnext'],
    ])
  })
})

describe('loadEnvFiles', () => {
  test('loads .env and lets .env.local override it', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-env-'))
    await writeFile(join(ws, '.env'), 'VIBE_ENV_TEST_KEY=base\nVIBE_ENV_TEST_LOCAL=base\n')
    await writeFile(join(ws, '.env.local'), 'VIBE_ENV_TEST_LOCAL=local\n')

    loadEnvFiles(ws)

    expect(process.env.VIBE_ENV_TEST_KEY).toBe('base')
    expect(process.env.VIBE_ENV_TEST_LOCAL).toBe('local')
  })

  test('checks global, app-root, and workspace env locations', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-env-other-workspace-'))

    loadEnvFiles(ws)

    const checked = envFilesChecked()
    expect(checked).toContain(join(homedir(), '.config', 'vibe', '.env'))
    expect(checked).toContain(join(ws, '.env'))
    expect(checked.some(path => path.endsWith('/vibe-code/.env'))).toBe(true)
  })

  test('ignores missing env files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-env-empty-'))
    await mkdir(join(ws, 'nested'))
    expect(() => loadEnvFiles(ws)).not.toThrow()
  })
})
