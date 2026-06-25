import { describe, expect, test } from 'bun:test'
import { parseToolCalls, stripThinkBlocks } from './parse.ts'

describe('stripThinkBlocks', () => {
  test('removes model reasoning blocks', () => {
    expect(stripThinkBlocks('<think>hidden</think>\n{"name":"Read"}')).toBe(
      '{"name":"Read"}',
    )
  })
})

describe('parseToolCalls', () => {
  test('parses qwen-style bare JSON', () => {
    const result = parseToolCalls('{"name":"Read","arguments":{"path":"a.ts"}}')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls).toEqual([
      {
        name: 'Read',
        arguments: { path: 'a.ts' },
        raw: '{"name":"Read","arguments":{"path":"a.ts"}}',
      },
    ])
  })

  test('parses VibeThinker XML tool JSON after think stripping', () => {
    const result = parseToolCalls(
      '<think>long reasoning</think><tool_name>{"name":"Grep","arguments":{"pattern":"x"}}</tool_name>',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls[0]?.name).toBe('Grep')
    expect(result.calls[0]?.arguments).toEqual({ pattern: 'x' })
  })

  test('returns no calls for plain prose', () => {
    const result = parseToolCalls('I am done.')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls).toEqual([])
  })

  test('does not treat HTML answers as tool calls', () => {
    const html = 'Here is the page:\n<head><title>Fireworks</title></head>\n<body>\\o/</body>'
    const result = parseToolCalls(html)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls).toEqual([])
  })

  test('does not treat CSS braces as a tool call', () => {
    const result = parseToolCalls('Use this CSS:\nbody { margin: 0; background: #000; }')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls).toEqual([])
  })

  test('still flags a genuinely malformed tool call for repair', () => {
    const result = parseToolCalls('{"name":"Read","arguments":{"file_path":"a.ts"')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected parse failure')
    expect(result.kind).toBe('incomplete')
  })

  test('classifies malformed complete tool JSON separately from incomplete JSON', () => {
    const result = parseToolCalls('{"name":"Read","arguments":oops}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected parse failure')
    expect(result.kind).toBe('malformed')
  })

  test('treats top-level fields beside name as arguments', () => {
    const result = parseToolCalls(
      '{"name":"Edit","path":"a.txt","oldString":"x","newString":"y"}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.calls[0]?.arguments).toEqual({
      path: 'a.txt',
      oldString: 'x',
      newString: 'y',
    })
  })

  test('accepts input and parameters as argument containers', () => {
    const inputResult = parseToolCalls(
      '{"name":"Edit","input":{"path":"a.txt","oldString":"x","newString":"y"}}',
    )
    const parameterResult = parseToolCalls(
      '{"name":"Read","parameters":{"path":"a.txt"}}',
    )

    expect(inputResult.ok).toBe(true)
    expect(parameterResult.ok).toBe(true)
    if (!inputResult.ok) throw new Error(inputResult.error)
    if (!parameterResult.ok) throw new Error(parameterResult.error)
    expect(inputResult.calls[0]?.arguments).toEqual({
      path: 'a.txt',
      oldString: 'x',
      newString: 'y',
    })
    expect(parameterResult.calls[0]?.arguments).toEqual({ path: 'a.txt' })
  })
})
