import { describe, expect, test } from 'bun:test'
import { getModelProfile } from './models.ts'

describe('model profiles', () => {
  test('extractor has enough output budget for full-file Write tool calls', () => {
    expect(getModelProfile('extractor').defaults.maxTokens).toBeGreaterThanOrEqual(8192)
  })

  test('text models default to a 128k ollama context window', () => {
    expect(getModelProfile('coder').defaults.numCtx).toBeGreaterThanOrEqual(131_072)
    expect(getModelProfile('extractor').defaults.numCtx).toBeGreaterThanOrEqual(131_072)
    expect(getModelProfile('reasoner').defaults.numCtx).toBeGreaterThanOrEqual(131_072)
  })
})
