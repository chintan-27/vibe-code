import { readFile, readdir, stat } from 'fs/promises'
import { extname, join, relative } from 'path'
import { dirname, resolve as posixResolve } from 'path/posix'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'claude-code', 'dist', 'build', '.next'])
const IMPORT_PATTERN =
  /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]|\bexport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]|\brequire\(['"]([^'"]+)['"]\)|\bimport\(['"]([^'"]+)['"]\)/g
// Candidate suffixes tried when resolving an extensionless import specifier.
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js']

export type DependencyGraph = {
  /** All source files, workspace-relative, posix separators, sorted. */
  files: string[]
  /** Raw import specifiers per file (for display). */
  imports: Map<string, string[]>
  /** Resolved internal edges: file -> files it imports (within the workspace). */
  edges: Map<string, string[]>
  /** Reverse edges: file -> files that import it. */
  importedBy: Map<string, string[]>
}

export async function buildDependencyGraph(workspaceRoot: string): Promise<DependencyGraph> {
  const files = await listSourceFiles(workspaceRoot)
  const fileSet = new Set(files)
  const imports = new Map<string, string[]>()
  const edges = new Map<string, string[]>()
  const importedBy = new Map<string, string[]>()
  for (const file of files) importedBy.set(file, [])

  for (const file of files) {
    const content = await readFile(join(workspaceRoot, file), 'utf8')
    const specifiers = [...content.matchAll(IMPORT_PATTERN)]
      .map(match => match[1] ?? match[2] ?? match[3] ?? match[4])
      .filter((value): value is string => Boolean(value))
    imports.set(file, specifiers)

    const resolved = new Set<string>()
    for (const spec of specifiers) {
      const target = resolveImport(file, spec, fileSet)
      if (target && target !== file) resolved.add(target)
    }
    const resolvedList = [...resolved]
    edges.set(file, resolvedList)
    for (const target of resolvedList) importedBy.get(target)?.push(file)
  }

  return { files, imports, edges, importedBy }
}

/**
 * Resolve an import specifier to a workspace-relative file, or undefined for
 * bare/external (npm) imports. Handles relative paths and the `@/` -> `src/` alias.
 */
function resolveImport(fromFile: string, spec: string, fileSet: Set<string>): string | undefined {
  let base: string
  if (spec.startsWith('@/')) {
    base = posixResolve('/src', spec.slice(2)).slice(1)
  } else if (spec.startsWith('.')) {
    base = posixResolve('/' + dirname(fromFile), spec).slice(1)
  } else {
    return undefined // external/bare specifier
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix
    if (fileSet.has(candidate)) return candidate
  }
  return undefined
}

/**
 * PageRank over the import graph. A file is "important" when many (important)
 * files import it — the same intuition Aider's repo map uses to rank symbols.
 */
export function pageRank(graph: DependencyGraph, damping = 0.85, iterations = 30): Map<string, number> {
  const { files, edges } = graph
  const n = files.length || 1
  let rank = new Map(files.map(file => [file, 1 / n]))
  const outDegree = new Map(files.map(file => [file, edges.get(file)?.length ?? 0]))

  for (let i = 0; i < iterations; i += 1) {
    const next = new Map(files.map(file => [file, (1 - damping) / n]))
    let dangling = 0
    for (const file of files) {
      const out = outDegree.get(file) ?? 0
      const share = rank.get(file) ?? 0
      if (out === 0) {
        dangling += share
        continue
      }
      const contribution = (damping * share) / out
      for (const target of edges.get(file) ?? []) {
        next.set(target, (next.get(target) ?? 0) + contribution)
      }
    }
    // Redistribute rank from dangling (no-outlink) nodes uniformly.
    const danglingShare = (damping * dangling) / n
    for (const file of files) next.set(file, (next.get(file) ?? 0) + danglingShare)
    rank = next
  }
  return rank
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  await walk(root, async path => {
    if (SOURCE_EXTENSIONS.has(extname(path))) out.push(relative(root, path).split('\\').join('/'))
  })
  return out.sort()
}

async function walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, visit)
    } else if (entry.isFile() && (await stat(fullPath)).size < 500_000) {
      await visit(fullPath)
    }
  }
}
