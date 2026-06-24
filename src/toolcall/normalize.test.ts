import { describe, expect, test } from 'bun:test'
import { coreTools, toolMap } from '@/tools/registry.ts'
import { validateToolCalls } from './validate.ts'

const tools = toolMap(coreTools)

describe('argument alias normalization', () => {
  test('maps path/oldString/newString to canonical Edit keys', () => {
    const result = validateToolCalls(
      [{ name: 'Edit', arguments: { path: 'a.ts', oldString: 'x', newString: 'y' }, raw: '' }],
      tools,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.calls[0]?.input).toEqual({ file_path: 'a.ts', old_string: 'x', new_string: 'y' })
    }
  })

  test('maps file/filename to Write file_path', () => {
    const result = validateToolCalls(
      [{ name: 'Write', arguments: { file: 'note.txt', content: 'hi' }, raw: '' }],
      tools,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.calls[0]?.input).toEqual({ file_path: 'note.txt', content: 'hi' })
    }
  })

  test('does not hijack Grep path (schema declares path, not file_path)', () => {
    const result = validateToolCalls(
      [{ name: 'Grep', arguments: { pattern: 'foo', path: 'src' }, raw: '' }],
      tools,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.calls[0]?.input).toMatchObject({ pattern: 'foo', path: 'src' })
    }
  })
})
