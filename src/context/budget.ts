import { buildDependencyGraph } from './depgraph.ts'
import { retrieveGraphContext } from './graph/index.ts'
import { buildRepoMap, renderRepoMap } from './repomap.ts'
import { retrieveSnippets, type RetrievedSnippet } from './retrieve.ts'

export type DumpContextResult = {
  content: string
  approxTokens: number
  /** Files included as full snippets, highest-scored first. */
  files: string[]
  source: 'graph' | 'fallback'
  indexedAt?: number
}

const CHARS_PER_TOKEN = 4
// Curated-context budget. Large enough to ingest several files for multi-file edits,
// while still leaving room for output + history inside the model's window.
export const DEFAULT_CONTEXT_TOKEN_BUDGET = readPositiveIntEnv('VIBE_CONTEXT_TOKEN_BUDGET', 32_000)
const REPO_MAP_SHARE = 0.35

export async function dumpContext(
  workspaceRoot: string,
  query: string,
  tokenBudget = DEFAULT_CONTEXT_TOKEN_BUDGET,
): Promise<DumpContextResult> {
  const graphContext = await retrieveGraphContext(workspaceRoot, query, {
    tokenBudget: Math.floor(tokenBudget * (1 - REPO_MAP_SHARE)),
  }).catch(() => undefined)
  if (graphContext) {
    return {
      content: [
        '# Graph Context (SQLite/FTS + dependency expansion)',
        graphContext.content || '[no graph matches]',
      ].join('\n'),
      approxTokens: graphContext.approxTokens,
      files: graphContext.files,
      source: 'graph',
      indexedAt: graphContext.indexedAt,
    }
  }

  const graph = await buildDependencyGraph(workspaceRoot)
  const repoMap = await buildRepoMap(workspaceRoot, graph)
  const snippets = await retrieveSnippets(workspaceRoot, repoMap, graph, query, 16)

  const repoMapBudget = Math.floor(tokenBudget * REPO_MAP_SHARE)
  const snippetBudget = tokenBudget - repoMapBudget

  const repoMapText = fitRepoMap(repoMap, repoMapBudget)
  const { text: snippetText, files } = fitSnippets(snippets, snippetBudget)

  const content = [
    '# Repo Map (most-referenced first; `·` = not exported)',
    repoMapText,
    '',
    '# Relevant Code',
    snippetText || '[no strongly-matching files]',
  ].join('\n')

  return { content, approxTokens: approxTokens(content), files, source: 'fallback' }
}

function fitRepoMap(entries: Awaited<ReturnType<typeof buildRepoMap>>, budget: number): string {
  let limit = entries.length
  let text = renderRepoMap(entries, limit)
  while (limit > 5 && approxTokens(text) > budget) {
    limit = Math.floor(limit * 0.8)
    text = renderRepoMap(entries, limit)
  }
  if (approxTokens(text) > budget) text = clampToTokens(text, budget)
  return text
}

function fitSnippets(snippets: RetrievedSnippet[], budget: number): { text: string; files: string[] } {
  const blocks: string[] = []
  const files: string[] = []
  let used = 0
  for (const snippet of snippets) {
    const block = `## ${snippet.path}  (score=${snippet.score}, ${snippet.reason})\n\`\`\`\n${snippet.content}\n\`\`\``
    const cost = approxTokens(block)
    if (used + cost > budget && files.length > 0) break
    blocks.push(block)
    files.push(snippet.path)
    used += cost
  }
  return { text: blocks.join('\n\n'), files }
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function clampToTokens(text: string, budget: number): string {
  return text.slice(0, budget * CHARS_PER_TOKEN)
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
