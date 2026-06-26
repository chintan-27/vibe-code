import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { runTwoPhaseStep } from './twoPhase.ts'

describe('runTwoPhaseStep', () => {
  test('constrained final answers are instructed not to compress explanations', async () => {
    let captured: ChatMessage[] = []
    const client = {
      async chat(model: string, messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
        captured = messages
        return {
          model,
          content: JSON.stringify({
            kind: 'final',
            content: '1. Step one\n\nEquation: V = I / (4*pi*sigma*r).',
          }),
          usage: { promptTokens: 0, completionTokens: 12, durationMs: 1 },
        }
      },
    }

    await runTwoPhaseStep(
      client,
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'Explain lead localization step by step with math.' },
      ],
      { effort: 'low' },
    )

    const instruction = captured.at(-1)?.content ?? ''
    expect(instruction).toContain('final.content must be substantive and structured')
    expect(instruction).toContain('numbered steps')
    expect(instruction).toContain('equations with variable definitions')
    expect(instruction).toContain('If a web/search tool failed')
    expect(instruction).toContain('Do not compress')
  })
})
