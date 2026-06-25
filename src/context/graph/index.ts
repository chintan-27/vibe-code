import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'fs'
import { mkdir, readFile, stat } from 'fs/promises'
import { dirname, extname, join } from 'path'
import { buildDependencyGraph, pageRank, type DependencyGraph } from '../depgraph.ts'
import { buildRepoMap, type RepoMapEntry, type SymbolInfo } from '../repomap.ts'

export type GraphContextResult = {
  content: string
  approxTokens: number
  files: string[]
  reasons: Record<string, string>
  graphPaths: string[]
  indexedAt: number
}

export type GraphIndex = {
  db: Database
  path: string
  indexedAt: number
  fresh: boolean
  stats: GraphIndexStats
  close(): void
}

type RetrieveOptions = {
  limit?: number
  tokenBudget?: number
}

export type GraphIndexStats = {
  files: number
  symbols: number
  chunks: number
  edges: number
}

export type GraphIndexProgress = {
  phase: 'scan' | 'repomap' | 'write' | 'done'
  message: string
  current?: number
  total?: number
}

type BuildGraphIndexOptions = {
  onProgress?: (progress: GraphIndexProgress) => void
}

type Candidate = {
  file: string
  score: number
  reason: string[]
}

const DB_RELATIVE = '.vibe/cache/repo-graph.sqlite'
const CHARS_PER_TOKEN = 4
const MAX_CONTEXT_CHARS = 4_000

export async function buildGraphIndex(workspaceRoot: string, options: BuildGraphIndexOptions = {}): Promise<GraphIndex> {
  const dbPath = join(workspaceRoot, DB_RELATIVE)
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  createSchema(db)

  options.onProgress?.({ phase: 'scan', message: 'Scanning dependency graph' })
  const graph = await buildDependencyGraph(workspaceRoot)
  options.onProgress?.({ phase: 'repomap', message: `Extracting symbols from ${graph.files.length} files`, total: graph.files.length })
  const repoMap = await buildRepoMap(workspaceRoot, graph)
  const ranks = pageRank(graph)
  const indexedAt = Date.now()

  options.onProgress?.({ phase: 'write', message: 'Writing SQLite GraphRAG index', current: 0, total: graph.files.length })
  db.transaction(() => {
    clearTables(db)
    db.query('insert into meta(key, value) values (?, ?)').run('indexed_at', String(indexedAt))
    insertFiles(db, workspaceRoot, graph, repoMap)
    insertSymbolsAndChunks(db, workspaceRoot, repoMap)
    insertEdges(db, graph, repoMap, ranks)
    const stats = readStats(db)
    for (const [key, value] of Object.entries(stats)) {
      db.query('insert into meta(key, value) values (?, ?)').run(key, String(value))
    }
  })()

  const stats = readStats(db)
  options.onProgress?.({ phase: 'done', message: `Indexed ${stats.files} files, ${stats.symbols} symbols, ${stats.edges} edges` })
  return { db, path: dbPath, indexedAt, fresh: true, stats, close: () => db.close() }
}

export async function loadGraphIndex(workspaceRoot: string): Promise<GraphIndex | undefined> {
  const dbPath = join(workspaceRoot, DB_RELATIVE)
  try {
    await stat(dbPath)
    const db = new Database(dbPath, { readonly: true })
    const row = db.query('select value from meta where key = ?').get('indexed_at') as { value?: string } | null
    const indexedAt = Number(row?.value ?? 0)
    const fresh = await isFresh(db, workspaceRoot)
    return { db, path: dbPath, indexedAt, fresh, stats: readStats(db), close: () => db.close() }
  } catch {
    return undefined
  }
}

export async function graphIndexStatus(workspaceRoot: string): Promise<string> {
  const index = await loadGraphIndex(workspaceRoot)
  if (!index) return 'GraphRAG index: missing. Run /context index to build it.'
  try {
    const age = index.indexedAt ? new Date(index.indexedAt).toISOString() : 'unknown'
    return [
      `GraphRAG index: ${index.fresh ? 'fresh' : 'stale'}`,
      `path: ${index.path}`,
      `indexed: ${age}`,
      `files: ${index.stats.files}`,
      `symbols: ${index.stats.symbols}`,
      `chunks: ${index.stats.chunks}`,
      `edges: ${index.stats.edges}`,
      index.fresh ? '' : 'Run /context index to rebuild it.',
    ].filter(Boolean).join('\n')
  } finally {
    index.close()
  }
}

export async function retrieveGraphContext(
  workspaceRoot: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<GraphContextResult | undefined> {
  const index = await loadGraphIndex(workspaceRoot)
  if (!index?.fresh) {
    index?.close()
    return undefined
  }
  try {
    const terms = tokenize(query)
    if (terms.length === 0) return undefined
    const limit = options.limit ?? 10
    const budget = options.tokenBudget ?? 18_000
    const candidates = rankCandidates(index.db, terms, limit)
    if (candidates.length === 0) return undefined
    const expanded = expandGraph(index.db, candidates, limit)
    const { content, files, reasons, graphPaths } = await renderCandidates(workspaceRoot, expanded, budget)
    return {
      content,
      approxTokens: approxTokens(content),
      files,
      reasons,
      graphPaths,
      indexedAt: index.indexedAt,
    }
  } finally {
    index.close()
  }
}

function createSchema(db: Database): void {
  db.exec(`
    create table if not exists meta(key text primary key, value text not null);
    create table if not exists files(
      path text primary key,
      language text not null,
      hash text not null,
      mtime integer not null,
      token_count integer not null
    );
    create table if not exists symbols(
      id integer primary key autoincrement,
      file_path text not null,
      name text not null,
      kind text not null,
      signature text not null,
      exported integer not null,
      start_line integer not null,
      end_line integer not null
    );
    create table if not exists chunks(
      id integer primary key autoincrement,
      file_path text not null,
      symbol_name text,
      kind text not null,
      text text not null,
      start_line integer not null,
      end_line integer not null,
      token_count integer not null
    );
    create table if not exists edges(
      from_type text not null,
      from_id text not null,
      to_type text not null,
      to_id text not null,
      kind text not null,
      weight real not null
    );
    create virtual table if not exists paths_fts using fts5(path);
    create virtual table if not exists symbols_fts using fts5(name, signature, file_path);
    create virtual table if not exists chunks_fts using fts5(text, file_path, symbol_name);
    create virtual table if not exists docs_fts using fts5(path, text);
  `)
}

function clearTables(db: Database): void {
  for (const table of ['files', 'symbols', 'chunks', 'edges', 'paths_fts', 'symbols_fts', 'chunks_fts', 'docs_fts']) {
    db.exec(`delete from ${table}`)
  }
  db.exec('delete from meta')
}

function readStats(db: Database): GraphIndexStats {
  const count = (table: string): number => {
    const row = db.query(`select count(*) as count from ${table}`).get() as { count: number } | null
    return row?.count ?? 0
  }
  return {
    files: count('files'),
    symbols: count('symbols'),
    chunks: count('chunks'),
    edges: count('edges'),
  }
}

function insertFiles(db: Database, workspaceRoot: string, graph: DependencyGraph, repoMap: RepoMapEntry[]): void {
  const byPath = new Map(repoMap.map(entry => [entry.path, entry]))
  const insertFile = db.query('insert into files(path, language, hash, mtime, token_count) values (?, ?, ?, ?, ?)')
  const insertPathFts = db.query('insert into paths_fts(path) values (?)')
  for (const file of graph.files) {
    const abs = join(workspaceRoot, file)
    const content = readFileSync(abs, 'utf8')
    const stats = statSync(abs)
    const hash = hashText(content)
    insertFile.run(file, languageFor(file), hash, Math.trunc(stats.mtimeMs), approxTokens(content))
    insertPathFts.run(file)
    if (isDocOrConfig(file, byPath.get(file))) {
      db.query('insert into docs_fts(path, text) values (?, ?)').run(file, content.slice(0, 12_000))
    }
  }
}

function insertSymbolsAndChunks(db: Database, workspaceRoot: string, repoMap: RepoMapEntry[]): void {
  const insertSymbol = db.query(
    'insert into symbols(file_path, name, kind, signature, exported, start_line, end_line) values (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertSymbolFts = db.query('insert into symbols_fts(name, signature, file_path) values (?, ?, ?)')
  const insertChunk = db.query(
    'insert into chunks(file_path, symbol_name, kind, text, start_line, end_line, token_count) values (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertChunkFts = db.query('insert into chunks_fts(text, file_path, symbol_name) values (?, ?, ?)')
  for (const entry of repoMap) {
    const content = readFileSync(join(workspaceRoot, entry.path), 'utf8')
    const lines = content.split('\n')
    const locations = entry.symbols.map(symbol => ({ symbol, line: findSignatureLine(lines, symbol) }))
    for (let i = 0; i < locations.length; i += 1) {
      const current = locations[i]
      if (!current) continue
      const next = locations[i + 1]
      const start = current.line
      const end = next ? Math.max(start, next.line - 1) : Math.min(lines.length, start + 80)
      const chunk = lines.slice(Math.max(0, start - 1), Math.min(lines.length, end)).join('\n')
      const kind = symbolKind(current.symbol.signature)
      insertSymbol.run(entry.path, current.symbol.name, kind, current.symbol.signature, current.symbol.exported ? 1 : 0, start, end)
      insertSymbolFts.run(current.symbol.name, current.symbol.signature, entry.path)
      insertChunk.run(entry.path, current.symbol.name, kind, chunk, start, end, approxTokens(chunk))
      insertChunkFts.run(chunk, entry.path, current.symbol.name)
    }
    if (locations.length === 0) {
      const chunk = content.slice(0, MAX_CONTEXT_CHARS)
      insertChunk.run(entry.path, null, 'file', chunk, 1, Math.min(lines.length, 120), approxTokens(chunk))
      insertChunkFts.run(chunk, entry.path, '')
    }
  }
}

function insertEdges(db: Database, graph: DependencyGraph, repoMap: RepoMapEntry[], ranks: Map<string, number>): void {
  const insert = db.query('insert into edges(from_type, from_id, to_type, to_id, kind, weight) values (?, ?, ?, ?, ?, ?)')
  for (const entry of repoMap) {
    for (const symbol of entry.symbols) {
      insert.run('file', entry.path, 'symbol', `${entry.path}#${symbol.name}`, 'CONTAINS', 1)
      insert.run('symbol', `${entry.path}#${symbol.name}`, 'file', entry.path, 'CONTAINS', 1)
    }
    for (const target of graph.edges.get(entry.path) ?? []) {
      insert.run('file', entry.path, 'file', target, 'IMPORTS', 1 + (ranks.get(target) ?? 0))
      insert.run('file', target, 'file', entry.path, 'IMPORTED_BY', 0.8)
    }
    for (const symbol of entry.symbols) {
      const name = symbol.name.toLowerCase()
      for (const other of repoMap) {
        if (other.path === entry.path) continue
        if (other.symbols.some(s => s.name.toLowerCase() === name)) continue
        if (other.imports.join(' ').toLowerCase().includes(name)) {
          insert.run('file', other.path, 'symbol', `${entry.path}#${symbol.name}`, 'REFERENCES_SYMBOL_TEXT', 0.4)
        }
      }
    }
    if (/[._-](test|spec)\.[tj]sx?$/.test(entry.path)) {
      const target = entry.path.replace(/[._-](test|spec)(?=\.[tj]sx?$)/, '')
      insert.run('file', entry.path, 'file', target, 'TESTS', 0.7)
    }
    if (isConfig(entry.path)) insert.run('file', entry.path, 'workspace', 'root', 'CONFIGURES', 0.5)
    if (isDoc(entry.path)) insert.run('file', entry.path, 'workspace', 'root', 'DOCUMENTS', 0.5)
  }
}

async function isFresh(db: Database, workspaceRoot: string): Promise<boolean> {
  const rows = db.query('select path, hash, mtime from files').all() as { path: string; hash: string; mtime: number }[]
  if (rows.length === 0) return false
  for (const row of rows) {
    try {
      const content = await readFile(join(workspaceRoot, row.path), 'utf8')
      const stats = await stat(join(workspaceRoot, row.path))
      if (hashText(content) !== row.hash || Math.trunc(stats.mtimeMs) !== Math.trunc(row.mtime)) return false
    } catch {
      return false
    }
  }
  return true
}

function rankCandidates(db: Database, terms: string[], limit: number): Candidate[] {
  const candidates = new Map<string, Candidate>()
  const add = (file: string, score: number, reason: string) => {
    const existing = candidates.get(file)
    if (existing) {
      existing.score += score
      existing.reason.push(reason)
    } else {
      candidates.set(file, { file, score, reason: [reason] })
    }
  }
  const query = ftsQuery(terms)
  for (const row of db.query('select path from paths_fts where paths_fts match ? limit 20').all(query) as { path: string }[]) {
    add(row.path, 12, 'path match')
  }
  for (const row of db.query('select file_path, name from symbols_fts where symbols_fts match ? limit 30').all(query) as { file_path: string; name: string }[]) {
    add(row.file_path, terms.includes(row.name.toLowerCase()) ? 20 : 10, `symbol ${row.name}`)
  }
  for (const row of db.query('select file_path from chunks_fts where chunks_fts match ? limit 40').all(query) as { file_path: string }[]) {
    add(row.file_path, 4, 'chunk text')
  }
  for (const row of db.query('select path from docs_fts where docs_fts match ? limit 10').all(query) as { path: string }[]) {
    add(row.path, 6, 'doc/config text')
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

function expandGraph(db: Database, seeds: Candidate[], limit: number): Candidate[] {
  const byFile = new Map(seeds.map(seed => [seed.file, { ...seed, reason: [...seed.reason] }]))
  for (const seed of seeds.slice(0, 4)) {
    const rows = db
      .query('select to_id, kind, weight from edges where from_type = ? and from_id = ? and to_type = ? order by weight desc limit 8')
      .all('file', seed.file, 'file') as { to_id: string; kind: string; weight: number }[]
    for (const row of rows) {
      const score = seed.score * 0.25 * row.weight
      const existing = byFile.get(row.to_id)
      if (existing) {
        existing.score += score
        existing.reason.push(row.kind)
      } else {
        byFile.set(row.to_id, { file: row.to_id, score, reason: [`${row.kind} ${seed.file}`] })
      }
    }
  }
  return [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

async function renderCandidates(
  workspaceRoot: string,
  candidates: Candidate[],
  tokenBudget: number,
): Promise<{ content: string; files: string[]; reasons: Record<string, string>; graphPaths: string[] }> {
  const blocks: string[] = []
  const files: string[] = []
  const reasons: Record<string, string> = {}
  let used = 0
  for (const candidate of candidates) {
    const content = await readFile(join(workspaceRoot, candidate.file), 'utf8').catch(() => '')
    const block = `## ${candidate.file}  (graph score=${round(candidate.score)}, ${candidate.reason.slice(0, 3).join(', ')})\n\`\`\`\n${content.slice(0, MAX_CONTEXT_CHARS)}${content.length > MAX_CONTEXT_CHARS ? '\n... (truncated)' : ''}\n\`\`\``
    const cost = approxTokens(block)
    if (used + cost > tokenBudget && files.length > 0) break
    blocks.push(block)
    files.push(candidate.file)
    reasons[candidate.file] = candidate.reason.slice(0, 4).join(', ')
    used += cost
  }
  return { content: blocks.join('\n\n'), files, reasons, graphPaths: files }
}

function findSignatureLine(lines: string[], symbol: SymbolInfo): number {
  const needle = symbol.signature.replace(/\s+/g, ' ').slice(0, 80)
  const index = lines.findIndex(line => line.replace(/\s+/g, ' ').includes(symbol.name) && needle.includes(symbol.name))
  return index === -1 ? 1 : index + 1
}

function symbolKind(signature: string): string {
  const match = signature.match(/\b(function\*?|class|interface|type|enum|const|let|var)\b/)
  return match?.[1] ?? 'symbol'
}

function languageFor(path: string): string {
  const ext = extname(path)
  if (ext === '.tsx') return 'tsx'
  if (ext === '.ts') return 'ts'
  if (ext === '.jsx') return 'jsx'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js'
  return ext.slice(1) || 'text'
}

function isDocOrConfig(path: string, entry?: RepoMapEntry): boolean {
  return isDoc(path) || isConfig(path) || (entry?.symbols.length ?? 0) === 0
}

function isDoc(path: string): boolean {
  return /\.(md|mdx|txt)$/i.test(path)
}

function isConfig(path: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|vite\.config|bunfig|eslint|prettier)/i.test(path)
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_$./-]+/).filter(term => term.length > 1))].slice(0, 12)
}

function ftsQuery(terms: string[]): string {
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
