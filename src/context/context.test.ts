import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { buildDependencyGraph, pageRank } from './depgraph.ts'
import { extractSignatures, buildRepoMap } from './repomap.ts'
import { retrieveSnippets } from './retrieve.ts'
import { dumpContext } from './budget.ts'
import { buildGraphIndex, graphIndexStatus, retrieveGraphContext } from './graph/index.ts'

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

  test('skips node_modules, hidden, and cloud/system directories', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-walk-'))
    await mkdir(join(ws, 'src'))
    await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(ws, '.hidden'))
    await mkdir(join(ws, 'Library'))
    await writeFile(join(ws, 'src', 'keep.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(join(ws, 'node_modules', 'pkg', 'skip.ts'), 'export const b = 2\n', 'utf8')
    await writeFile(join(ws, '.hidden', 'skip.ts'), 'export const c = 3\n', 'utf8')
    await writeFile(join(ws, 'Library', 'skip.ts'), 'export const d = 4\n', 'utf8')

    const graph = await buildDependencyGraph(ws)
    expect(graph.files).toEqual(['src/keep.ts'])
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

describe('dumpContext (multi-file)', () => {
  test('pulls the right files for a cross-file task and fits the budget', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-multifile-'))
    await mkdir(join(ws, 'src'))
    await writeFile(join(ws, 'src', 'auth.ts'), 'export function login(user: string) {\n  return `token-${user}`\n}\n', 'utf8')
    await writeFile(join(ws, 'src', 'server.ts'), "import { login } from './auth.ts'\nexport const handler = (u: string) => login(u)\n", 'utf8')
    await writeFile(join(ws, 'src', 'styles.ts'), 'export const color = "blue"\n', 'utf8')

    const result = await dumpContext(ws, 'login authentication token', 12_000)
    // The defining file and its importer both surface; the unrelated file does not.
    expect(result.files).toContain('src/auth.ts')
    expect(result.files).toContain('src/server.ts')
    expect(result.files).not.toContain('src/styles.ts')
    expect(result.approxTokens).toBeLessThanOrEqual(12_000)
  })
})

describe('GraphRAG index', () => {
  test('indexes files, symbols, chunks, and graph neighbours for retrieval', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-graph-'))
    await mkdir(join(ws, 'src'))
    await writeFile(join(ws, 'src', 'parser.ts'), 'export function parseTokens(input: string) {\n  return input.split(" ")\n}\n', 'utf8')
    await writeFile(join(ws, 'src', 'caller.ts'), "import { parseTokens } from './parser.ts'\nexport const run = () => parseTokens('a b')\n", 'utf8')

    const index = await buildGraphIndex(ws)
    expect(index.stats.files).toBe(2)
    expect(index.stats.symbols).toBeGreaterThan(0)
    expect(index.stats.chunks).toBeGreaterThan(0)
    expect(index.stats.edges).toBeGreaterThan(0)
    const fileCount = (index.db.query('select count(*) as count from files').get() as { count: number }).count
    const symbolCount = (index.db.query('select count(*) as count from symbols').get() as { count: number }).count
    const chunkCount = (index.db.query('select count(*) as count from chunks').get() as { count: number }).count
    const edgeCount = (index.db.query('select count(*) as count from edges').get() as { count: number }).count
    index.close()

    expect(fileCount).toBe(2)
    expect(symbolCount).toBeGreaterThan(0)
    expect(chunkCount).toBeGreaterThan(0)
    expect(edgeCount).toBeGreaterThan(0)

    const result = await retrieveGraphContext(ws, 'parseTokens', { limit: 5 })
    expect(result?.files[0]).toBe('src/parser.ts')
    expect(result?.files).toContain('src/caller.ts')
    expect(await graphIndexStatus(ws)).toContain('GraphRAG index: fresh')
  })

  test('renders the matching symbol chunk instead of the start of its file', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-graph-chunk-'))
    await mkdir(join(ws, 'src'))
    await writeFile(
      join(ws, 'src', 'service.ts'),
      [
        'export function unrelatedBootstrap() {',
        '  return "not the requested implementation"',
        '}',
        '',
        'export function parseTokens(input: string) {',
        '  return input.split(/\\s+/)',
        '}',
      ].join('\n'),
      'utf8',
    )

    const index = await buildGraphIndex(ws)
    const entityCount = (index.db.query('select count(*) as count from entities').get() as { count: number }).count
    expect(entityCount).toBeGreaterThan(1)
    index.close()

    const result = await retrieveGraphContext(ws, 'parseTokens', { limit: 3 })
    expect(result?.content).toContain('function parseTokens')
    expect(result?.content).not.toContain('unrelatedBootstrap')
  })

  test('uses community summaries for broad architecture questions', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-graph-global-'))
    await mkdir(join(ws, 'src', 'tui'), { recursive: true })
    await mkdir(join(ws, 'src', 'loop'), { recursive: true })
    await writeFile(join(ws, 'src', 'loop', 'session.ts'), 'export function runSession() { return "ok" }\n', 'utf8')
    await writeFile(
      join(ws, 'src', 'tui', 'app.ts'),
      "import { runSession } from '../loop/session.ts'\nexport const app = () => runSession()\n",
      'utf8',
    )

    const index = await buildGraphIndex(ws)
    const communities = (index.db.query('select count(*) as count from communities').get() as { count: number }).count
    index.close()
    expect(communities).toBe(2)

    const result = await retrieveGraphContext(ws, 'What are the major architectural subsystems and how do they interact?', { tokenBudget: 2_000 })
    expect(result?.content).toContain('# Architecture Communities')
    expect(result?.content).toContain('src/tui')
    expect(result?.content).toContain('src/loop')
    expect(result?.content).toContain('Connects to: src/loop')
  })

  test('records package, route, test, and configuration entities', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-graph-entities-'))
    await mkdir(join(ws, 'src'))
    await writeFile(join(ws, 'package.json'), '{"scripts":{"test":"bun test"}}\n', 'utf8')
    await writeFile(
      join(ws, 'src', 'routes.ts'),
      "import express from 'express'\nconst router = express.Router()\nrouter.get('/health', () => 'ok')\nexport { router }\n",
      'utf8',
    )
    await writeFile(join(ws, 'src', 'routes.test.ts'), "import { router } from './routes.ts'\ntest('health', () => router)\n", 'utf8')

    const index = await buildGraphIndex(ws)
    const kinds = index.db.query('select kind from entities').all() as { kind: string }[]
    const entityKinds = kinds.map(row => row.kind)
    index.close()

    expect(entityKinds).toContain('package')
    expect(entityKinds).toContain('route')
    expect(entityKinds).toContain('test')
    expect(entityKinds).toContain('config')
  })
})
