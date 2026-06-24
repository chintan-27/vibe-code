import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { buildDependencyGraph, pageRank } from './depgraph.ts'
import { extractSignatures, buildRepoMap } from './repomap.ts'
import { retrieveSnippets } from './retrieve.ts'

describe('extractSignatures', () => {
  test('keeps exported declarations with signatures and drops local variables', () => {
    const code = [
      'export function addNumbers(a: number, b: number): number {',
      '  const total = a + b', // local — must be dropped
      '  return total',
      '}',
      'export interface Widget { id: string }',
      'const INTERNAL_LIMIT = 5',
    ].join('\n')

    const symbols = extractSignatures(code)
    const names = symbols.map(s => s.name)

    expect(names).toContain('addNumbers')
    expect(names).toContain('Widget')
    expect(names).toContain('INTERNAL_LIMIT') // SCREAMING_CASE constant kept
    expect(names).not.toContain('total') // local variable dropped

    const addNumbers = symbols.find(s => s.name === 'addNumbers')
    expect(addNumbers?.exported).toBe(true)
    expect(addNumbers?.signature).toContain('(a: number, b: number): number')
    expect(addNumbers?.signature).not.toContain('{')
  })
})

describe('dependency graph', () => {
  test('resolves @/ alias and relative imports, builds reverse edges, ranks hubs higher', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-depgraph-'))
    await mkdir(join(ws, 'src'))
    await writeFile(join(ws, 'src', 'util.ts'), 'export const helper = 1\n', 'utf8')
    await writeFile(join(ws, 'src', 'a.ts'), "import { helper } from './util.ts'\nexport const a = helper\n", 'utf8')
    await writeFile(join(ws, 'src', 'b.ts'), "import { helper } from '@/util.ts'\nexport const b = helper\n", 'utf8')

    const graph = await buildDependencyGraph(ws)
    expect(graph.edges.get('src/a.ts')).toContain('src/util.ts')
    expect(graph.edges.get('src/b.ts')).toContain('src/util.ts')
    expect(graph.importedBy.get('src/util.ts')?.sort()).toEqual(['src/a.ts', 'src/b.ts'])

    const ranks = pageRank(graph)
    // util.ts is imported by two files; it should outrank its importers.
    expect((ranks.get('src/util.ts') ?? 0)).toBeGreaterThan(ranks.get('src/a.ts') ?? 0)
  })
})

describe('retrieveSnippets', () => {
  test('boosts files that define a queried symbol and expands to graph neighbours', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-retrieve-'))
    await mkdir(join(ws, 'src'))
    await writeFile(join(ws, 'src', 'parser.ts'), 'export function parseTokens(input: string) {\n  return input.split(" ")\n}\n', 'utf8')
    await writeFile(join(ws, 'src', 'caller.ts'), "import { parseTokens } from './parser.ts'\nexport const run = () => parseTokens('a b')\n", 'utf8')
    await writeFile(join(ws, 'src', 'unrelated.ts'), 'export const color = "blue"\n', 'utf8')

    const graph = await buildDependencyGraph(ws)
    const repoMap = await buildRepoMap(ws, graph)
    const snippets = await retrieveSnippets(ws, repoMap, graph, 'parseTokens', 5)
    const paths = snippets.map(s => s.path)

    expect(paths[0]).toBe('src/parser.ts') // exact symbol-definition match ranks first
    expect(paths).toContain('src/caller.ts') // pulled in via graph expansion
    expect(paths).not.toContain('src/unrelated.ts')
  })
})
