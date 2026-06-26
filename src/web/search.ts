// Pluggable web-search backend. Pick a provider with VIBE_SEARCH_PROVIDER
// (tavily | brave | searxng); default is Tavily because it returns clean,
// LLM-ready snippets. Each provider needs its own credential/URL env var.
import { envFilesChecked, envFilesLoaded } from '@/config/env.ts'

export type SearchResult = { title: string; url: string; snippet: string }

export type SearchOutcome =
  | { ok: true; results: SearchResult[]; answer?: string }
  | { ok: false; error: string }

type Provider = 'tavily' | 'brave' | 'searxng'

export async function webSearch(query: string, maxResults = 5): Promise<SearchOutcome> {
  const provider = (process.env.VIBE_SEARCH_PROVIDER as Provider | undefined) ?? 'tavily'
  try {
    switch (provider) {
      case 'tavily':
        return await tavily(query, maxResults)
      case 'brave':
        return await brave(query, maxResults)
      case 'searxng':
        return await searxng(query, maxResults)
      default:
        return { ok: false, error: `unknown VIBE_SEARCH_PROVIDER "${provider}"` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function tavily(query: string, maxResults: number): Promise<SearchOutcome> {
  const key = process.env.TAVILY_API_KEY
  if (!key) return { ok: false, error: `TAVILY_API_KEY not set. ${envDiagnostics()}` }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: maxResults, include_answer: true }),
  })
  if (!res.ok) return { ok: false, error: `Tavily HTTP ${res.status}` }
  const json = (await res.json()) as { answer?: string; results?: Array<{ title?: string; url?: string; content?: string }> }
  return {
    ok: true,
    answer: json.answer,
    results: (json.results ?? []).map(r => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' })),
  }
}

function envDiagnostics(): string {
  const checked = envFilesChecked()
  const loaded = envFilesLoaded()
  const checkedText = checked.length ? checked.join(', ') : '[none recorded; restart vibe from the CLI]'
  const loadedText = loaded.length ? loaded.join(', ') : '[none]'
  return `Checked env files: ${checkedText}. Loaded env files: ${loadedText}. Put shared search credentials in ~/.config/vibe/.env or set VIBE_SEARCH_PROVIDER=brave|searxng.`
}

async function brave(query: string, maxResults: number): Promise<SearchOutcome> {
  const key = process.env.BRAVE_API_KEY
  if (!key) return { ok: false, error: 'BRAVE_API_KEY not set' }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`
  const res = await fetch(url, { headers: { 'X-Subscription-Token': key, accept: 'application/json' } })
  if (!res.ok) return { ok: false, error: `Brave HTTP ${res.status}` }
  const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
  return {
    ok: true,
    results: (json.web?.results ?? []).slice(0, maxResults).map(r => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' })),
  }
}

async function searxng(query: string, maxResults: number): Promise<SearchOutcome> {
  const base = process.env.SEARXNG_URL
  if (!base) return { ok: false, error: 'SEARXNG_URL not set' }
  const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`
  const res = await fetch(url)
  if (!res.ok) return { ok: false, error: `SearXNG HTTP ${res.status}` }
  const json = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
  return {
    ok: true,
    results: (json.results ?? []).slice(0, maxResults).map(r => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' })),
  }
}
