import { describe, expect, test } from 'bun:test'
import { OllamaClient } from './ollama.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('OllamaClient', () => {
  test('propagates done_reason and load duration from non-streamed responses', async () => {
    const client = new OllamaClient({
      fetchImpl: (async () =>
        jsonResponse({
          model: 'qwen',
          message: { content: 'partial' },
          prompt_eval_count: 3,
          eval_count: 4,
          total_duration: 10_000_000,
          load_duration: 2_000_000,
          done_reason: 'length',
        })) as unknown as typeof fetch,
    })

    const result = await client.chat('qwen', [{ role: 'user', content: 'hi' }])
    expect(result.usage.doneReason).toBe('length')
    expect(result.usage.loadDurationMs).toBe(2)
  })

  test('stream parser handles a final line without trailing newline', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: 'hel' } })}\n`))
        controller.enqueue(encoder.encode(JSON.stringify({ model: 'qwen', message: { content: 'lo' }, eval_count: 2, done_reason: 'stop' })))
        controller.close()
      },
    })
    const client = new OllamaClient({
      fetchImpl: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
    })

    let streamed = ''
    const result = await client.chatStream('qwen', [{ role: 'user', content: 'hi' }], {}, delta => {
      streamed += delta
    })
    expect(streamed).toBe('hello')
    expect(result.content).toBe('hello')
    expect(result.usage.doneReason).toBe('stop')
  })
})
