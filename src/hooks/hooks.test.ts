import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { runHooks } from './hooks.ts'

describe('runHooks', () => {
  test('PreToolUse hook blocks on non-zero exit', async () => {
    const outcome = await runHooks('PreToolUse', 'Bash', { command: 'rm' }, { PreToolUse: [{ command: 'exit 3' }] }, tmpdir())
    expect(outcome.block).toBe(true)
  })

  test('PreToolUse hook allows on zero exit', async () => {
    const outcome = await runHooks('PreToolUse', 'Bash', {}, { PreToolUse: [{ command: 'exit 0' }] }, tmpdir())
    expect(outcome.block).toBe(false)
  })

  test('matcher limits which tools a hook applies to', async () => {
    // Hook targets Bash; tool is Read → skipped, so no block.
    const outcome = await runHooks('PreToolUse', 'Read', {}, { PreToolUse: [{ matcher: '^Bash$', command: 'exit 1' }] }, tmpdir())
    expect(outcome.block).toBe(false)
  })

  test('PostToolUse never blocks', async () => {
    const outcome = await runHooks('PostToolUse', 'Edit', {}, { PostToolUse: [{ command: 'exit 1' }] }, tmpdir())
    expect(outcome.block).toBe(false)
  })
})
