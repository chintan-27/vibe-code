import { z } from 'zod'
import { webSearch } from '@/web/search.ts'
import type { ToolDef } from './types.ts'

export const webSearchTool = {
  name: 'WebSearch',
  readOnly: true,
  description: 'Search the web and return ranked results (title, url, snippet). Use WebFetch to read a result in full.',
  schema: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(10).optional(),
  }),
  async execute(input) {
    const outcome = await webSearch(input.query, input.maxResults ?? 5)
    if (!outcome.ok) return { ok: false, content: outcome.error }
    if (outcome.results.length === 0) return { ok: true, content: '[no results]' }
    const lines = outcome.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    const answer = outcome.answer ? `Answer: ${outcome.answer}\n\n` : ''
    return { ok: true, content: `${answer}${lines.join('\n')}` }
  },
} satisfies ToolDef
