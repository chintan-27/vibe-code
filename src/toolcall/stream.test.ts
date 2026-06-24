import { describe, expect, test } from 'bun:test'
import { createThinkStreamFilter } from './parse.ts'

describe('createThinkStreamFilter', () => {
  test('emits only text outside think blocks, across chunk boundaries', () => {
    const filter = createThinkStreamFilter()
    const chunks = ['<thi', 'nk>secret rea', 'soning</thi', 'nk>Hello', ' world']
    const out = chunks.map(filter).join('')
    expect(out).toBe('Hello world')
  })

  test('suppresses an unclosed think block', () => {
    const filter = createThinkStreamFilter()
    expect(filter('Answer: ')).toBe('Answer: ')
    expect(filter('<think>still thinking')).toBe('')
  })

  test('passes through plain text token by token', () => {
    const filter = createThinkStreamFilter()
    expect(filter('foo ')).toBe('foo ')
    expect(filter('bar')).toBe('bar')
  })
})
