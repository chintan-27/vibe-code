import { readFile } from 'fs/promises'
import { join } from 'path'
import { type DependencyGraph, pageRank } from './depgraph.ts'

// Matches the head of a top-level declaration (column 0, no leading indent — which
// is exactly what excludes local variables declared inside function bodies).
const DECL_PATTERN =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/

const MAX_SIGNATURE_CHARS = 160
const MAX_CONTINUATION_LINES = 6

export type SymbolInfo = {
  name: string
  signature: string
  exported: boolean
}

export type RepoMapEntry = {
  path: string
  symbols: SymbolInfo[]
  imports: string[]
  rank: number
}

export async function buildRepoMap(
  workspaceRoot: string,
  graph: DependencyGraph,
): Promise<RepoMapEntry[]> {
  const ranks = pageRank(graph)
  const entries: RepoMapEntry[] = []

  for (const file of graph.files) {
    const content = await readFile(join(workspaceRoot, file), 'utf8')
    entries.push({
      path: file,
      symbols: extractSignatures(content),
      imports: graph.imports.get(file) ?? [],
      rank: ranks.get(file) ?? 0,
    })
  }

  // Most-referenced files first — the model sees the architecturally central code.
  return entries.sort((a, b) => b.rank - a.rank)
}

/** Extract high-signal top-level declaration signatures, dropping local noise. */
export function extractSignatures(content: string): SymbolInfo[] {
  const lines = content.split('\n')
  const symbols: SymbolInfo[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const match = DECL_PATTERN.exec(line)
    if (!match) continue

    const exported = Boolean(match[1])
    const kind = match[2] ?? ''
    const name = match[3] ?? ''
    if (!name) continue
    if (!shouldKeep(kind, name, line, exported)) continue

    symbols.push({ name, signature: buildSignature(lines, i), exported })
  }
  return symbols
}

/** Keep structural decls always; keep const/let/var only when they carry real signal. */
function shouldKeep(kind: string, name: string, line: string, exported: boolean): boolean {
  if (kind === 'function' || kind === 'function*' || kind === 'class' || kind === 'interface' || kind === 'type' || kind === 'enum') {
    return true
  }
  // const/let/var
  if (exported) return true
  const isArrowFn = /=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/.test(line) || /=\s*(?:async\s+)?function\b/.test(line)
  const isConstant = /^[A-Z][A-Z0-9_]+$/.test(name)
  return isArrowFn || isConstant
}

/** Assemble a one-line signature, joining continuation lines until parens balance. */
function buildSignature(lines: string[], start: number): string {
  let raw = lines[start] ?? ''
  let depth = parenDelta(raw)
  for (let j = start + 1; depth > 0 && j < lines.length && j - start <= MAX_CONTINUATION_LINES; j += 1) {
    const next = lines[j] ?? ''
    raw += ' ' + next.trim()
    depth += parenDelta(next)
  }
  // Trim to the signature head: drop a trailing block body / assignment value.
  let head = raw.replace(/\s*\{[\s\S]*$/, '').replace(/\s*=>\s*$/, ' =>')
  // For `type X = <rhs>` and `const X = <value>` keep a short hint of the RHS.
  head = head.replace(/\s+/g, ' ').trim()
  if (head.length > MAX_SIGNATURE_CHARS) head = head.slice(0, MAX_SIGNATURE_CHARS - 1) + '…'
  return head
}

function parenDelta(text: string): number {
  let delta = 0
  for (const char of text) {
    if (char === '(') delta += 1
    else if (char === ')') delta -= 1
  }
  return delta
}

export function renderRepoMap(entries: RepoMapEntry[], limit = 60): string {
  return entries
    .slice(0, limit)
    .map(entry => {
      if (entry.symbols.length === 0) return `- ${entry.path}`
      const sigs = entry.symbols
        .map(symbol => `    ${symbol.exported ? '' : '· '}${symbol.signature}`)
        .join('\n')
      return `- ${entry.path}\n${sigs}`
    })
    .join('\n')
}
