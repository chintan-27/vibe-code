import { z } from 'zod'

// Small models emit Claude-Code-style argument names, but not always the exact
// canonical key. Each group lists interchangeable names; we remap any present
// alias onto whichever canonical key the target tool's schema actually declares.
const ALIAS_GROUPS: string[][] = [
  ['file_path', 'path', 'filepath', 'filePath', 'file', 'filename', 'fileName'],
  ['old_string', 'oldString', 'old', 'old_str', 'search', 'find', 'oldText'],
  ['new_string', 'newString', 'new', 'new_str', 'replacement', 'replace', 'newText'],
  ['content', 'contents', 'text', 'data', 'body'],
  ['pattern', 'regex', 'query', 'search_pattern'],
  ['command', 'cmd', 'script'],
]

/** Return the top-level keys of a ZodObject schema, or undefined for other schemas. */
export function schemaKeys(schema: z.ZodType): Set<string> | undefined {
  if (schema instanceof z.ZodObject) {
    return new Set(Object.keys(schema.shape as Record<string, unknown>))
  }
  return undefined
}

/**
 * Remap alias argument keys to the canonical key declared by the tool's schema.
 * Schema-aware so `path` correctly maps to `file_path` for Write but stays `path`
 * for Grep (whose schema declares `path`). Only fills a canonical key that's absent.
 */
export function normalizeArgs(args: unknown, schema: z.ZodType): unknown {
  if (!isRecord(args)) return args
  const keys = schemaKeys(schema)
  if (!keys) return args

  const out: Record<string, unknown> = { ...args }
  for (const group of ALIAS_GROUPS) {
    const canonical = group.find(key => keys.has(key))
    if (!canonical) continue
    if (out[canonical] !== undefined) continue
    const alias = group.find(key => key !== canonical && out[key] !== undefined)
    if (alias) out[canonical] = out[alias]
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
