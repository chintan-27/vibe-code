import { afterEach, describe, expect, test } from 'bun:test'
import { htmlToText } from './html.ts'
import { webSearch } from './search.ts'
import { webFetchTool } from '@/tools/webfetch.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('htmlToText', () => {
  test('strips tags, scripts, and decodes entities', () => {
    const html = '<html><head><style>x{}</style></head><body><h1>Hi</h1><script>bad()</script><p>a&amp;b</p></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Hi')
    expect(text).toContain('a&b')
    expect(text).not.toContain('bad()')
    expect(text).not.toContain('<')
  })
})

describe('WebFetch tool', () => {
  test('fetches and returns stripped text', async () => {
    globalThis.fetch = (async () =>
      new Response('<p>Hello <b>world</b></p>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const result = await webFetchTool.execute({ url: 'https://example.com' }, { workspaceRoot: '/' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Hello world')
  })

  test('reports HTTP errors', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const result = await webFetchTool.execute({ url: 'https://example.com/missing' }, { workspaceRoot: '/' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('404')
  })
})

describe('webSearch (Tavily provider)', () => {
  test('parses Tavily results', async () => {
    process.env.VIBE_SEARCH_PROVIDER = 'tavily'
    process.env.TAVILY_API_KEY = 'test-key'
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ answer: 'because', results: [{ title: 'T', url: 'https://x', content: 'snippet' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    const outcome = await webSearch('why', 3)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.answer).toBe('because')
      expect(outcome.results[0]).toEqual({ title: 'T', url: 'https://x', snippet: 'snippet' })
    }
  })

  test('errors clearly when no key configured', async () => {
    process.env.VIBE_SEARCH_PROVIDER = 'tavily'
    delete process.env.TAVILY_API_KEY
    const outcome = await webSearch('q')
    expect(outcome.ok).toBe(false)
  })
})
