import { readFile } from 'fs/promises'
import { join } from 'path'
import type { DependencyGraph } from './depgraph.ts'
import type { RepoMapEntry } from './repomap.ts'

export type RetrievedSnippet = {
  path: string
  score: number
  /** Why this file surfaced — useful in --dump-context and for debugging. */
  reason: string
  content: string
}

const SNIPPET_WINDOW = 6
const MAX_SNIPPET_LINES = 90
const MAX_SNIPPET_CHARS = 4_000

/**
 * Hybrid retrieval: lexical term overlap weighted by field (symbol name >> path >
 * imports), an exact symbol-definition boost, then dependency-graph expansion so
 * importers/importees of strong hits ride along even without a textual match.
 */
export async function retrieveSnippets(
  workspaceRoot: string,
  entries: RepoMapEntry[],
  graph: DependencyGraph,
  query: string,
  limit = 8,
): Promise<RetrievedSnippet[]> {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const scores = new Map<string, { score: number; reason: string }>()

  for (const entry of entries) {
    const { score, reason } = scoreEntry(entry, terms)
    if (score > 0) scores.set(entry.path, { score, reason })
  }

  // Graph expansion: pull neighbours of the strongest seeds at a discount.
  const seeds = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 4)
  for (const [path, { score }] of seeds) {
    const neighbours = [...(graph.edges.get(path) ?? []), ...(graph.importedBy.get(path) ?? [])]
    for (const neighbour of neighbours) {
      if (!byPath.has(neighbour)) continue
      const existing = scores.get(neighbour)
      const boost = score * 0.25
      if (existing) existing.score += boost
      else scores.set(neighbour, { score: boost, reason: `linked to ${path}` })
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)

  return Promise.all(
    ranked.map(async ([path, { score, reason }]) => {
      const content = await readFile(join(workspaceRoot, path), 'utf8').catch(() => '')
      return { path, score: round(score), reason, content: focusSnippet(content, terms) }
    }),
  )
}

function scoreEntry(entry: RepoMapEntry, terms: string[]): { score: number; reason: string } {
  const pathText = entry.path.toLowerCase()
  const symbolNames = entry.symbols.map(symbol => symbol.name.toLowerCase())
  const importText = entry.imports.join(' ').toLowerCase()
  let score = 0
  const reasons: string[] = []

  for (const term of terms) {
    if (symbolNames.includes(term)) {
      score += 8
      reasons.push(`defines ${term}`)
    } else if (symbolNames.some(name => name.includes(term))) {
      score += 3
    }
    if (pathText.includes(term)) {
      score += 4
      reasons.push(`path~${term}`)
    }
    if (importText.includes(term)) score += 1
  }
  // No textual match — let graph expansion decide whether this file is relevant.
  if (score === 0) return { score: 0, reason: '' }
  // Centrality nudge so ties break toward architecturally important files.
  score += entry.rank * 50
  return { score, reason: reasons.slice(0, 3).join(', ') || 'related' }
}

/** Return the file's most relevant regions: windows around term hits, else the head. */
function focusSnippet(content: string, terms: string[]): string {
  if (!content) return ''
  const lines = content.split('\n')
  const hits: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const lower = (lines[i] ?? '').toLowerCase()
    if (terms.some(term => lower.includes(term))) hits.push(i)
  }

  if (hits.length === 0) {
    return clamp(lines.slice(0, 40).join('\n'))
  }

  const keep = new Set<number>()
  for (const hit of hits) {
    for (let j = Math.max(0, hit - SNIPPET_WINDOW); j <= Math.min(lines.length - 1, hit + SNIPPET_WINDOW); j += 1) {
      keep.add(j)
    }
  }

  const ordered = [...keep].sort((a, b) => a - b).slice(0, MAX_SNIPPET_LINES)
  const out: string[] = []
  let prev = -2
  for (const index of ordered) {
    if (index > prev + 1) out.push(`… (line ${index + 1})`)
    out.push(lines[index] ?? '')
    prev = index
  }
  return clamp(out.join('\n'))
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_$]+/).filter(term => term.length > 1))]
}

function clamp(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) + '\n… (truncated)' : text
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
