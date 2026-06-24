export type ParsedToolCall = {
  name: string
  arguments: unknown
  raw: string
}

export type ToolCallParseResult =
  | {
      ok: true
      calls: ParsedToolCall[]
      contentWithoutThink: string
    }
  | {
      ok: false
      error: string
      contentWithoutThink: string
    }

const TOOL_TAG_PATTERN = /<([A-Za-z][A-Za-z0-9_-]*)>\s*([\s\S]*?)\s*<\/\1>/g

export function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * Build an incremental filter for streaming output: feed it raw deltas, it returns
 * only the newly-visible text outside `<think>` blocks. Suppresses everything from
 * an unclosed `<think>` onward and holds back a possible partial opening tag so the
 * user never sees reasoning leak through.
 */
export function createThinkStreamFilter(): (delta: string) => string {
  let full = ''
  let emitted = 0
  return (delta: string): string => {
    full += delta
    let visible = full.replace(/<think>[\s\S]*?<\/think>/gi, '')
    const open = visible.toLowerCase().lastIndexOf('<think>')
    if (open !== -1) visible = visible.slice(0, open)
    // Hold back a trailing partial that might be the start of "<think>".
    for (let k = Math.min(6, visible.length); k >= 1; k -= 1) {
      if ('<think>'.startsWith(visible.slice(visible.length - k))) {
        visible = visible.slice(0, visible.length - k)
        break
      }
    }
    if (visible.length <= emitted) return ''
    const out = visible.slice(emitted)
    emitted = visible.length
    return out
  }
}

/**
 * Like {@link createThinkStreamFilter} but also surfaces the reasoning stream:
 * returns the newly-visible text AND the newly-revealed `<think>` content per delta.
 */
export function createThinkSplitter(): (delta: string) => { visible: string; think: string } {
  let full = ''
  let visibleEmitted = 0
  let thinkEmitted = 0
  return (delta: string) => {
    full += delta
    let visible = full.replace(/<think>[\s\S]*?<\/think>/gi, '')
    const open = visible.toLowerCase().lastIndexOf('<think>')
    if (open !== -1) visible = visible.slice(0, open)
    for (let k = Math.min(6, visible.length); k >= 1; k -= 1) {
      if ('<think>'.startsWith(visible.slice(visible.length - k))) {
        visible = visible.slice(0, visible.length - k)
        break
      }
    }
    const think = extractThink(full)
    const visibleOut = visible.length > visibleEmitted ? visible.slice(visibleEmitted) : ''
    visibleEmitted = Math.max(visibleEmitted, visible.length)
    const thinkOut = think.length > thinkEmitted ? think.slice(thinkEmitted) : ''
    thinkEmitted = Math.max(thinkEmitted, think.length)
    return { visible: visibleOut, think: thinkOut }
  }
}

function extractThink(text: string): string {
  let out = ''
  const re = /<think>([\s\S]*?)<\/think>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) out += match[1] ?? ''
  const lower = text.toLowerCase()
  const open = lower.lastIndexOf('<think>')
  const close = lower.lastIndexOf('</think>')
  if (open !== -1 && open > close) out += text.slice(open + '<think>'.length)
  return out
}

export function parseToolCalls(content: string): ToolCallParseResult {
  const contentWithoutThink = stripThinkBlocks(content)
  const xmlCalls = parseXmlToolCalls(contentWithoutThink)
  if (xmlCalls.length > 0) {
    return { ok: true, calls: xmlCalls, contentWithoutThink }
  }

  const jsonText = extractJsonCandidate(contentWithoutThink)
  if (!jsonText) {
    return { ok: true, calls: [], contentWithoutThink }
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown
    const normalized = normalizeJsonToolCalls(parsed, jsonText)
    // Parsed JSON that isn't a tool call (no name) is just content — not an error.
    return { ok: true, calls: normalized, contentWithoutThink }
  } catch (error) {
    // Only flag an error when the text was clearly an *attempted* tool call.
    // Plain prose, HTML, or CSS that merely contains braces/tags is a final answer.
    if (looksLikeToolCallAttempt(jsonText)) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        contentWithoutThink,
      }
    }
    return { ok: true, calls: [], contentWithoutThink }
  }
}

/**
 * Collect tool calls written as XML-ish tags (VibeThinker emits
 * `<read_file>{"name":...,"arguments":...}</read_file>`). A tag only counts when
 * its body is JSON that describes a call — so HTML like `<head>…</head>` in an
 * answer is ignored, never treated as a malformed tool call.
 */
function parseXmlToolCalls(content: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  for (const match of content.matchAll(TOOL_TAG_PATTERN)) {
    const tagName = match[1]
    const body = match[2]
    const raw = match[0]
    if (!tagName || !body) continue
    if (tagName.toLowerCase() === 'think') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      continue // body isn't JSON → it's markup/content, not a tool call
    }
    calls.push(...normalizeJsonToolCalls(parsed, raw))
  }
  return calls
}

/** Heuristic: the text was meant to be a tool call (has name + an args container). */
function looksLikeToolCallAttempt(text: string): boolean {
  return /"name"\s*:/.test(text) && /"(arguments|input|parameters)"\s*:/.test(text)
}

function normalizeJsonToolCalls(parsed: unknown, raw: string): ParsedToolCall[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap(item => normalizeJsonToolCalls(item, raw))
  }

  if (!isRecord(parsed)) return []

  const maybeCalls = parsed.tool_calls ?? parsed.toolCalls
  if (Array.isArray(maybeCalls)) {
    return maybeCalls.flatMap(item => normalizeJsonToolCalls(item, raw))
  }

  const name = typeof parsed.name === 'string' ? parsed.name : undefined
  if (!name) return []
  const {
    name: _name,
    arguments: explicitArguments,
    input,
    parameters,
    tool_calls: _toolCalls,
    toolCalls: _toolCallsCamel,
    ...rest
  } = parsed
  const hasRestArguments = Object.keys(rest).length > 0

  return [
    {
      name,
      arguments: explicitArguments ?? input ?? parameters ?? (hasRestArguments ? rest : {}),
      raw,
    },
  ]
}

function extractJsonCandidate(content: string): string | undefined {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const start = findFirstJsonStart(content)
  if (start === -1) return undefined

  const end = findMatchingJsonEnd(content, start)
  if (end === -1) return content.slice(start).trim()
  return content.slice(start, end + 1).trim()
}

function findFirstJsonStart(content: string): number {
  const objectStart = content.indexOf('{')
  const arrayStart = content.indexOf('[')
  if (objectStart === -1) return arrayStart
  if (arrayStart === -1) return objectStart
  return Math.min(objectStart, arrayStart)
}

function findMatchingJsonEnd(content: string, start: number): number {
  const opener = content[start]
  const closer = opener === '{' ? '}' : ']'
  const stack = [closer]
  let inString = false
  let escaped = false

  for (let index = start + 1; index < content.length; index += 1) {
    const char = content[index]
    if (!char) continue

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('}')
    } else if (char === '[') {
      stack.push(']')
    } else if (char === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return index
    }
  }

  return -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
