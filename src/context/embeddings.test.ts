import { afterEach, describe, expect, test } from 'bun:test'
import { cosine, embed, semanticScores } from './embeddings.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('cosine', () => {
  test('1 for identical, 0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
  })
})

describe('embed', () => {
  test('posts to /api/embed and returns vectors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const vectors = await embed(['hello'])
    expect(vectors[0]).toEqual([1, 2, 3])
  })
})

describe('semanticScores', () => {
  test('ranks the item closest to the query highest', async () => {
    // query=[1,0]; itemA=[1,0] (identical), itemB=[0,1] (orthogonal)
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ embeddings: [[1, 0], [1, 0], [0, 1]] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const scores = await semanticScores('q', [
      { key: 'a', text: 'a' },
      { key: 'b', text: 'b' },
    ])
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!)
  })

  test('returns empty on failure (graceful)', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const scores = await semanticScores('q', [{ key: 'a', text: 'a' }])
    expect(scores.size).toBe(0)
  })
})
