import { z } from 'zod'
import { htmlToText } from '@/web/html.ts'
import type { ToolDef } from './types.ts'

const DEFAULT_MAX_CHARS = 8_000

export const webFetchTool = {
  name: 'WebFetch',
  readOnly: true,
  description: 'Fetch a URL and return its readable text content (HTML is stripped to plain text).',
  schema: z.object({
    url: z.string().url(),
    maxChars: z.number().int().min(200).max(50_000).optional(),
  }),
  async execute(input, _context) {
    let res: Response
    try {
      res = await fetch(input.url, { headers: { 'user-agent': 'vibe-code/0.1' }, redirect: 'follow' })
    } catch (error) {
      return { ok: false, content: `fetch failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!res.ok) return { ok: false, content: `HTTP ${res.status} for ${input.url}` }

    const contentType = res.headers.get('content-type') ?? ''
    const body = await res.text()
    const text = contentType.includes('html') ? htmlToText(body) : body
    const max = input.maxChars ?? DEFAULT_MAX_CHARS
    return { ok: true, content: text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text }
  },
} satisfies ToolDef
