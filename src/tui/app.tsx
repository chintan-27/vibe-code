import { Box, render, Static, Text, useApp, useInput, useStdout, type Key } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentSession } from '@/loop/session.ts'
import type {
  EffortMode,
  ContextInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PlannedAction,
  SessionEvents,
} from '@/loop/types.ts'
import { getModelProfile } from '@/provider/models.ts'
import { OllamaClient } from '@/provider/ollama.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'
import { coreTools } from '@/tools/registry.ts'
import type { AnyTool } from '@/tools/types.ts'
import type { HooksConfig } from '@/hooks/hooks.ts'

export type TuiOptions = {
  workspaceRoot: string
  effort: EffortMode
  permissionMode: PermissionMode
  allow?: string[]
  hooks?: HooksConfig
  extraTools?: AnyTool[]
}

type PendingPermission = { request: PermissionRequest; resolve: (d: PermissionDecision) => void }
type PendingQuestion = { question: string; options?: string[]; resolve: (answer: string) => void }

type ToolEntry = { name: string; args: string; raw?: unknown; ok?: boolean; result?: string }

type Block =
  | { kind: 'banner'; id: number; model: string; workspace: string; effort: EffortMode }
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string }
  | { kind: 'reasoning'; id: number; text: string }
  | { kind: 'tool'; id: number; tool: ToolEntry }
  | { kind: 'note'; id: number; text: string }
  | { kind: 'plan'; id: number; actions: PlannedAction[] }

type Live = {
  active: boolean
  assistant: string
  think: string
  tools: ToolEntry[]
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PASTE_GAP_MS = 45 // a return arriving this soon after a keystroke is a pasted newline, not submit
function freshLive(): Live {
  return { active: false, assistant: '', think: '', tools: [] }
}

// --- design system: one palette + glyph set used across every component ---
const C = {
  brand: 'magenta',
  brandBright: 'magentaBright',
  accent: 'cyan',
  accentBright: 'cyanBright',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  muted: 'gray',
} as const

const G = {
  user: '❯',
  assistant: '●',
  tool: '⏺',
  result: '⎿',
  reasoning: '✶',
  plan: '◇',
  note: '·',
  bullet: '▸',
}

export function startTui(options: TuiOptions): Promise<void> {
  const instance = render(<App options={options} />)
  return instance.waitUntilExit()
}

export function App({ options }: { options: TuiOptions }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.min(stdout?.columns ?? 80, 120)

  const client = useRef(new OllamaClient()).current
  const [effort, setEffort] = useState<EffortMode>(options.effort)
  const sessionRef = useRef<AgentSession | null>(null)

  const [transcript, setTranscript] = useState<Block[]>(() => [
    {
      kind: 'banner',
      id: 0,
      model: getModelProfile('coder').model,
      workspace: options.workspaceRoot,
      effort: options.effort,
    },
  ])
  const [live, setLive] = useState<Live>(freshLive)
  const liveRef = useRef<Live>(freshLive())
  const dirtyRef = useRef(false)
  const tokensRef = useRef(0)
  const turnStartRef = useRef(0)
  const [context, setContext] = useState<ContextInfo>({ files: [], approxTokens: 0 })
  const [tokensThisTurn, setTokensThisTurn] = useState(0)
  const [tokPerSec, setTokPerSec] = useState(0)
  // Input editor state lives in refs (source of truth, burst-safe) mirrored to view state.
  const inputRef = useRef('')
  const cursorRef = useRef(0)
  const lastEditAt = useRef(0)
  const [inputView, setInputView] = useState('')
  const [cursorView, setCursorView] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [showReasoning, setShowReasoning] = useState(false) // thinking lives in the background; ^R to expand
  const [showContext, setShowContext] = useState(false)
  const [permMode, setPermMode] = useState<PermissionMode>(options.permissionMode)
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  const [frame, setFrame] = useState(0)
  const idRef = useRef(0)
  const nextId = () => (idRef.current += 1)

  const profile = getModelProfile('coder')
  const budget = profile.defaults.numCtx

  // --- input editor (refs are the source of truth; view state drives rendering) ---
  const syncInput = () => {
    setInputView(inputRef.current)
    setCursorView(cursorRef.current)
  }
  const setInputAll = (text: string) => {
    inputRef.current = text
    cursorRef.current = text.length
    syncInput()
  }
  const insertText = (text: string) => {
    const i = cursorRef.current
    inputRef.current = inputRef.current.slice(0, i) + text + inputRef.current.slice(i)
    cursorRef.current = i + text.length
    lastEditAt.current = Date.now()
    syncInput()
  }
  const backspaceAt = () => {
    const i = cursorRef.current
    if (i > 0) {
      inputRef.current = inputRef.current.slice(0, i - 1) + inputRef.current.slice(i)
      cursorRef.current = i - 1
      syncInput()
    }
  }
  const deleteAt = () => {
    const i = cursorRef.current
    if (i < inputRef.current.length) {
      inputRef.current = inputRef.current.slice(0, i) + inputRef.current.slice(i + 1)
      syncInput()
    }
  }
  const moveCursor = (delta: number) => {
    cursorRef.current = Math.max(0, Math.min(inputRef.current.length, cursorRef.current + delta))
    setCursorView(cursorRef.current)
  }

  // Build (or rebuild) the session whenever the mode changes.
  useEffect(() => {
    // Events mutate liveRef (cheap) and mark dirty; a 60ms timer flushes to React state
    // so streaming many tokens doesn't trigger a render per token (the source of the lag).
    const events: SessionEvents = {
      onContext: info => setContext(info),
      onThink: text => {
        liveRef.current.think += text
        dirtyRef.current = true
      },
      onToken: text => {
        liveRef.current.assistant += text
        tokensRef.current += approxTokens(text)
        dirtyRef.current = true
      },
      onTool: (name, args) => {
        // A tool call means the streamed JSON wasn't a final answer — drop it and show the tool.
        liveRef.current.assistant = ''
        liveRef.current.tools.push({ name, args: summarizeArgs(args), raw: args })
        dirtyRef.current = true
      },
      onToolResult: (name, ok, result) => {
        liveRef.current.tools = markLastTool(liveRef.current.tools, name, ok, result)
        dirtyRef.current = true
      },
      onUsage: usage => {
        if (usage.durationMs > 0) setTokPerSec(Math.round((usage.completionTokens / usage.durationMs) * 1000))
      },
      onPermissionRequest: request =>
        new Promise<PermissionDecision>(resolve => setPendingPermission({ request, resolve })),
      onAskUser: (question, options2) =>
        new Promise<string>(resolve => setPendingQuestion({ question, options: options2, resolve })),
      onPlan: actions => setTranscript(prev => [...prev, { kind: 'plan', id: nextId(), actions }]),
    }
    sessionRef.current = new AgentSession({
      client,
      workspaceRoot: options.workspaceRoot,
      effort,
      permissionMode: permMode,
      tools: options.extraTools && options.extraTools.length > 0 ? [...coreTools, ...options.extraTools] : undefined,
      allow: options.allow,
      hooks: options.hooks,
      events,
    })
  }, [client, effort, permMode, options.workspaceRoot, options.extraTools, options.allow, options.hooks])

  // While a turn runs: advance the spinner and flush buffered stream output (throttled).
  useEffect(() => {
    if (!live.active) return
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER.length)
      if (dirtyRef.current) {
        dirtyRef.current = false
        const current = liveRef.current
        setLive({ active: true, assistant: current.assistant, think: current.think, tools: [...current.tools] })
        setTokensThisTurn(tokensRef.current)
      }
    }, 60)
    return () => clearInterval(timer)
  }, [live.active])

  const submit = useCallback(async (text: string) => {
    const session = sessionRef.current
    if (!session || liveRef.current.active) return
    setTranscript(prev => [...prev, { kind: 'user', id: nextId(), text }])
    setHistory(prev => [...prev, text])
    setHistoryIdx(-1)
    liveRef.current = { active: true, assistant: '', think: '', tools: [] }
    tokensRef.current = 0
    dirtyRef.current = false
    turnStartRef.current = Date.now()
    setLive({ active: true, assistant: '', think: '', tools: [] })
    setTokensThisTurn(0)

    let result
    try {
      result = await session.run(text)
    } catch (error) {
      setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `Error: ${asMessage(error)}` }])
      liveRef.current = freshLive()
      setLive(freshLive())
      return
    }

    // Finalize the live turn into scrollback blocks.
    const current = liveRef.current
    const finalized: Block[] = []
    if (current.think.trim()) finalized.push({ kind: 'reasoning', id: nextId(), text: current.think.trim() })
    for (const tool of current.tools) finalized.push({ kind: 'tool', id: nextId(), tool })
    const answer = stripThinkBlocks(current.assistant).trim() || stripThinkBlocks(result.finalContent).trim()
    if (answer) finalized.push({ kind: 'assistant', id: nextId(), text: answer })
    setTranscript(prev => [...prev, ...finalized])
    liveRef.current = freshLive()
    setLive(freshLive())
  }, [])

  const resolvePermission = (decision: PermissionDecision) => {
    pendingPermission?.resolve(decision)
    setPendingPermission(null)
  }

  // Shared text editing: cursor movement, edits, paste-safe submit. A return that
  // arrives right after a keystroke is a pasted newline (inserted literally), not submit.
  const editText = (value: string, key: Key, onSubmit: (text: string) => void) => {
    if (key.leftArrow) return moveCursor(-1)
    if (key.rightArrow) return moveCursor(1)
    if (key.delete) return deleteAt()
    if (key.backspace) return backspaceAt()
    if (key.return) {
      if (Date.now() - lastEditAt.current < PASTE_GAP_MS) return insertText('\n')
      const text = inputRef.current
      setInputAll('')
      onSubmit(text)
      return
    }
    if (value && !key.ctrl && !key.meta) insertText(value)
  }

  const runInputLine = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (text === '/exit' || text === '/quit') return exit()
    if (text === '/help') return setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: HELP }])
    if (text === '/clear') return setTranscript([])
    if (text === '/commit') return void submit(COMMIT_PROMPT)
    if (text === '/review') return void submit(REVIEW_PROMPT)
    if (text.startsWith('/image')) {
      const rest = text.slice('/image'.length).trim()
      const [path, ...q] = rest.split(' ')
      if (!path) {
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: 'usage: /image <path> [question]' }])
        return
      }
      const question = q.join(' ').trim()
      return void submit(`Read ${path}${question ? ` then ${question}` : ' and describe what you see'}`)
    }
    if (text.startsWith('/mode') || text.startsWith('/effort')) {
      const next = text.split(' ')[1]
      if (next === 'normal' || next === 'medium' || next === 'high') setEffort(next)
      else setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `effort is ${effort}. Use /effort normal|medium|high` }])
      return
    }
    if (text.startsWith('/perm')) {
      const next = text.split(' ')[1]
      if (next === 'default' || next === 'acceptEdits' || next === 'plan' || next === 'auto') {
        setPermMode(next)
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `permission mode → ${next} (conversation reset)` }])
      } else {
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `permission mode is ${permMode}. Use /perm default|acceptEdits|plan|auto` }])
      }
      return
    }
    void submit(text)
  }

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      exit()
      return
    }
    // A pending permission prompt captures single keys, even mid-turn.
    if (pendingPermission) {
      if (value === 'y') resolvePermission('allow')
      else if (value === 'a') resolvePermission('allow-always')
      else if (value === 'n' || key.escape) resolvePermission('deny')
      return
    }
    // A pending clarifying question captures a typed line, even mid-turn.
    if (pendingQuestion) {
      editText(value, key, answer => {
        pendingQuestion.resolve(answer.trim())
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `↳ ${answer.trim() || '(skipped)'}` }])
        setPendingQuestion(null)
      })
      return
    }
    if (key.ctrl && value === 'r') {
      setShowReasoning(s => !s)
      return
    }
    if (key.ctrl && value === 'o') {
      setShowContext(s => !s)
      return
    }
    if (live.active) return // ignore editing while a turn runs

    // ↑/↓ recall history only on an empty line; otherwise they move the cursor.
    if (key.upArrow && inputRef.current === '') {
      const idx = historyIdx < 0 ? history.length - 1 : Math.max(0, historyIdx - 1)
      if (history[idx] !== undefined) {
        setHistoryIdx(idx)
        setInputAll(history[idx] ?? '')
      }
      return
    }
    if (key.downArrow && historyIdx >= 0) {
      if (historyIdx < history.length - 1) {
        const idx = historyIdx + 1
        setHistoryIdx(idx)
        setInputAll(history[idx] ?? '')
      } else {
        setHistoryIdx(-1)
        setInputAll('')
      }
      return
    }
    editText(value, key, runInputLine)
  })

  const elapsedS = live.active ? Math.max(0, Math.round((Date.now() - turnStartRef.current) / 1000)) : 0

  return (
    <Box flexDirection="column" width={width}>
      <Static items={transcript}>{block => <BlockView key={block.id} block={block} width={width} />}</Static>

      {showContext && context.files.length > 0 && <ContextPanel context={context} width={width} />}

      {live.active && (
        <Box flexDirection="column">
          {live.think.trim() !== '' &&
            (showReasoning ? (
              <ReasoningView text={live.think} live />
            ) : (
              <Box marginTop={1}>
                <Text color={C.muted} dimColor>
                  {`${G.reasoning} thinking… ${approxTokens(live.think)} tok · ${elapsedS}s · ^R to expand`}
                </Text>
              </Box>
            ))}
          {live.tools.map((tool, i) => (
            <ToolView key={`live-tool-${i}`} tool={tool} />
          ))}
          {live.assistant.trim() !== '' && !looksLikeToolDraft(live.assistant) && (
            <Box marginTop={1}>
              <Text>
                <Text color={C.brand} bold>
                  {G.assistant}
                </Text>
                {` ${stripThinkBlocks(live.assistant)}`}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={C.brandBright}>{`${SPINNER[frame]} `}</Text>
            <Text color={C.muted}>{`${spinnerLabel(live)}  ${elapsedS}s`}</Text>
          </Box>
        </Box>
      )}

      {pendingPermission && <PermissionPrompt request={pendingPermission.request} width={width} />}
      {pendingQuestion && <QuestionPrompt question={pendingQuestion.question} options={pendingQuestion.options} width={width} />}

      <StatusBar
        effort={effort}
        permMode={permMode}
        model={profile.model}
        ctxTokens={context.approxTokens}
        budget={budget}
        tokPerSec={tokPerSec}
        tokensThisTurn={tokensThisTurn}
        active={live.active}
        width={width}
      />
      <Box borderStyle="round" borderColor={live.active ? C.muted : C.accent} paddingX={1} width={width}>
        <Text color={live.active ? C.muted : C.accent} bold>
          {`${G.user} `}
        </Text>
        {live.active ? (
          <Text color="gray">working… (^C to quit)</Text>
        ) : inputView === '' ? (
          <Text>
            <Text inverse> </Text>
            <Text color="gray">{'  type or paste a request · Enter to send · /help'}</Text>
          </Text>
        ) : (
          <Text>
            {inputView.slice(0, cursorView)}
            <Text inverse>{inputView.slice(cursorView, cursorView + 1) || ' '}</Text>
            {inputView.slice(cursorView + 1)}
          </Text>
        )}
      </Box>
    </Box>
  )
}

function BlockView({ block, width }: { block: Block; width: number }) {
  if (block.kind === 'banner') {
    return <BannerView model={block.model} workspace={block.workspace} effort={block.effort} width={width} />
  }
  if (block.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color={C.accent} bold>{`${G.user} `}</Text>
        <Text color={C.accent} bold>
          {block.text}
        </Text>
      </Box>
    )
  }
  if (block.kind === 'assistant') {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color={C.brand} bold>
            {G.assistant}
          </Text>
          {` ${block.text}`}
        </Text>
      </Box>
    )
  }
  if (block.kind === 'reasoning') {
    // Thinking is kept in the background — a dim one-liner in scrollback.
    return (
      <Box marginTop={1}>
        <Text color={C.muted} dimColor>
          {`${G.reasoning} thought for ${approxTokens(block.text)} tok`}
        </Text>
      </Box>
    )
  }
  if (block.kind === 'note') {
    return (
      <Box marginTop={1}>
        <Text color={C.warn}>{`${G.note} `}</Text>
        <Text color={C.muted}>{block.text}</Text>
      </Box>
    )
  }
  if (block.kind === 'plan') {
    return <PlanView actions={block.actions} width={width} />
  }
  return <ToolView tool={block.tool} />
}

const LOGO = [
  ' ██╗   ██╗██╗██████╗ ███████╗',
  ' ██║   ██║██║██╔══██╗██╔════╝',
  ' ██║   ██║██║██████╔╝█████╗  ',
  ' ╚██╗ ██╔╝██║██╔══██╗██╔══╝  ',
  '  ╚████╔╝ ██║██████╔╝███████╗',
  '   ╚═══╝  ╚═╝╚═════╝ ╚══════╝',
]
// Top-to-bottom cyan→magenta gradient across the six logo rows.
const LOGO_COLORS = ['cyan', 'cyan', 'cyanBright', 'magentaBright', 'magenta', 'magenta'] as const

function BannerView({
  model,
  workspace,
  effort,
  width,
}: {
  model: string
  workspace: string
  effort: EffortMode
  width: number
}) {
  return (
    <Box flexDirection="column" width={width} marginBottom={1}>
      {LOGO.map((line, i) => (
        <Text key={`logo-${i}`} color={LOGO_COLORS[i]} bold>
          {line}
          {i === 2 ? <Text color="gray">{'   a local coding agent · 100% local via ollama'}</Text> : null}
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color={C.muted}>
          <Text color={C.brand}>{`  ${G.bullet} `}</Text>
          {`reason  VibeThinker-3B  ·  format ${model}`}
          <Text color={C.muted}>{`   ·   effort ${effort}`}</Text>
        </Text>
        <Text color={C.muted}>
          <Text color={C.brand}>{`  ${G.bullet} `}</Text>
          {`cwd     ${workspace}`}
        </Text>
        <Text color={C.muted} dimColor>
          {'      /help · ^R thinking · ^O context · ^C quit'}
        </Text>
      </Box>
    </Box>
  )
}

function ToolView({ tool }: { tool: ToolEntry }) {
  const dotColor = tool.ok === undefined ? C.warn : tool.ok ? C.ok : C.err
  const isTodos = tool.name === 'TodoWrite' && tool.ok
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={dotColor}>{`${G.tool} `}</Text>
        <Text bold>{toolTitle(tool.name)}</Text>
        <Text color={C.muted}>{prettyArgs(tool) ? `(${prettyArgs(tool)})` : ''}</Text>
      </Box>
      {tool.name === 'Edit' ? <EditDiff raw={tool.raw} /> : null}
      {isTodos ? (
        <TodoView result={tool.result ?? ''} />
      ) : tool.result && tool.ok !== undefined ? (
        <Box>
          <Text color={C.muted}>{`  ${G.result}  `}</Text>
          <Text color={tool.ok ? C.muted : C.err} dimColor={tool.ok}>
            {resultLine(tool)}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** Display title: collapse `mcp__server__tool` into `server·tool`. */
function toolTitle(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    return `${server}·${tool}`
  }
  return name
}

/** Friendly one-line argument summary per tool (falls back to compact JSON). */
function prettyArgs(tool: ToolEntry): string {
  const r = tool.raw && typeof tool.raw === 'object' ? (tool.raw as Record<string, unknown>) : {}
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return s(r.file_path)
    case 'Grep':
    case 'Glob':
      return s(r.pattern)
    case 'Bash':
      return clip(s(r.command), 60)
    case 'WebFetch':
      return s(r.url)
    case 'WebSearch':
      return clip(s(r.query), 50)
    case 'Task':
      return clip(s(r.description), 50)
    case 'TodoWrite':
      return ''
    default:
      return clip(tool.args, 50)
  }
}

/** Tool-aware one-line result summary (counts where it helps, first line otherwise). */
function resultLine(tool: ToolEntry): string {
  const result = tool.result ?? ''
  if (!tool.ok) return clip(firstNonEmpty(result), 80)
  const lines = result.split('\n').filter(l => l.trim() !== '')
  switch (tool.name) {
    case 'Read': {
      if (result.startsWith('[image:')) return 'image described'
      if (result.startsWith('[pdf:')) return firstNonEmpty(result)
      return `read ${lines.length} lines`
    }
    case 'Grep':
      return `${lines.length} match${lines.length === 1 ? '' : 'es'}`
    case 'Glob':
      return result.includes('[no matches]') ? 'no matches' : `${lines.length} file${lines.length === 1 ? '' : 's'}`
    case 'Bash':
      return clip(firstNonEmpty(result), 80)
    case 'WebSearch':
      return `${lines.filter(l => /^\d+\./.test(l)).length || lines.length} results`
    case 'WebFetch':
      return `${result.length} chars fetched`
    default: {
      const head = clip(firstNonEmpty(result), 80)
      return lines.length > 1 ? `${head}  (+${lines.length - 1} more)` : head
    }
  }
}

function firstNonEmpty(text: string): string {
  return text.split('\n').find(l => l.trim() !== '') ?? ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Render a TodoWrite result (`- [status] content` lines) as a styled checklist. */
function TodoView({ result }: { result: string }) {
  const items = result
    .split('\n')
    .map(line => line.match(/^- \[(\w+)\]\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
  if (items.length === 0) {
    return (
      <Box>
        <Text color={C.muted}>{`  ${G.result}  ${clip(firstNonEmpty(result), 80)}`}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      {items.map((m, i) => {
        const status = m[1] ?? 'pending'
        const text = m[2] ?? ''
        const box = status === 'completed' ? '☑' : status === 'in_progress' ? '◐' : '☐'
        const color = status === 'completed' ? C.ok : status === 'in_progress' ? C.accent : C.muted
        return (
          <Text key={`todo-${i}`} color={color}>
            {`${box} `}
            <Text color={status === 'completed' ? C.muted : undefined} strikethrough={status === 'completed'}>
              {text}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

function looksLikeToolDraft(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('<')
}

function spinnerLabel(live: Live): string {
  if (live.think && !live.assistant) return 'thinking…'
  if (looksLikeToolDraft(live.assistant)) return 'preparing action…'
  return 'working…'
}

function EditDiff({ raw }: { raw: unknown }) {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  if (!parsed) return null
  const oldStr = typeof parsed.old_string === 'string' ? parsed.old_string : undefined
  const newStr = typeof parsed.new_string === 'string' ? parsed.new_string : undefined
  if (oldStr === undefined && newStr === undefined) return null
  return (
    <Box flexDirection="column" marginLeft={2}>
      {oldStr !== undefined && <Text color={C.err}>{`- ${firstLines(oldStr, 3)}`}</Text>}
      {newStr !== undefined && <Text color={C.ok}>{`+ ${firstLines(newStr, 3)}`}</Text>}
    </Box>
  )
}

function ReasoningView({ text, live }: { text: string; live?: boolean }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={C.muted} dimColor>
        {`${G.reasoning} ${live ? 'thinking' : 'thought'}  `}
      </Text>
      <Text color={C.muted} dimColor italic>
        {firstLines(text.trim(), 10)
          .split('\n')
          .map(l => `   ${l}`)
          .join('\n')}
      </Text>
    </Box>
  )
}

function ContextPanel({ context, width }: { context: ContextInfo; width: number }) {
  const pct = Math.min(100, Math.round((context.approxTokens / 12_000) * 100))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} width={width} marginTop={1}>
      <Text color={C.accent} bold>
        {`Context  ·  ${context.files.length} files  ·  ~${context.approxTokens} tok  ${meter(pct, 12)}`}
      </Text>
      {context.files.slice(0, 10).map(file => (
        <Text key={file} color={C.muted}>
          {`  ${G.bullet} ${file}`}
        </Text>
      ))}
    </Box>
  )
}

function StatusBar(props: {
  effort: EffortMode
  permMode: PermissionMode
  model: string
  ctxTokens: number
  budget: number
  tokPerSec: number
  tokensThisTurn: number
  active: boolean
  width: number
}) {
  const pct = Math.min(100, Math.round((props.ctxTokens / props.budget) * 100))
  const permColor = props.permMode === 'auto' ? C.err : props.permMode === 'plan' ? C.accent : C.ok
  return (
    <Box marginTop={1} width={props.width}>
      <Text color={props.active ? C.brandBright : C.brand}>{`${G.tool} `}</Text>
      <Text color={C.brand} bold>
        VibeThinker
      </Text>
      <Text color={C.muted}>{`  ·  ${props.effort}  ·  `}</Text>
      <Text color={permColor}>{props.permMode}</Text>
      <Text color={C.muted}>
        {`  ·  ctx ${meter(pct, 10)} ${pct}%  ·  ${props.tokPerSec} tok/s${props.active ? `  ·  +${props.tokensThisTurn}` : ''}`}
      </Text>
    </Box>
  )
}

/** Compact unicode progress meter, e.g. ▰▰▰▱▱▱. */
function meter(pct: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled))
}

function PermissionPrompt({ request, width }: { request: PermissionRequest; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} width={width} marginTop={1}>
      <Text color={C.warn} bold>
        {`Approve  ${toolTitle(request.tool)}?`}
      </Text>
      <Text color={C.muted}>
        {request.preview
          .split('\n')
          .map(l => `  ${l}`)
          .join('\n')}
      </Text>
      <Box marginTop={1}>
        <Text color={C.ok} bold>
          {' [y] '}
        </Text>
        <Text color={C.muted}>allow once </Text>
        <Text color={C.accent} bold>
          {' [a] '}
        </Text>
        <Text color={C.muted}>always </Text>
        <Text color={C.err} bold>
          {' [n] '}
        </Text>
        <Text color={C.muted}>deny</Text>
      </Box>
    </Box>
  )
}

function QuestionPrompt({ question, options, width }: { question: string; options?: string[]; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} width={width} marginTop={1}>
      <Box>
        <Text color={C.accent} bold>
          {'? '}
        </Text>
        <Text color={C.accent} bold>
          {question}
        </Text>
      </Box>
      {options && options.length > 0 ? <Text color={C.muted}>{`  options: ${options.join(' · ')}`}</Text> : null}
      <Text color={C.muted} dimColor>
        {'  type your answer below, then Enter ↵'}
      </Text>
    </Box>
  )
}

function PlanView({ actions, width }: { actions: PlannedAction[]; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} width={width} marginTop={1}>
      <Text color={C.accent} bold>
        {`${G.plan} Proposed plan · ${actions.length} action${actions.length === 1 ? '' : 's'}`}
      </Text>
      {actions.map((action, i) => (
        <Text key={`plan-${i}`} color={C.muted}>
          {`  ${i + 1}. `}
          <Text color={C.muted} bold>
            {toolTitle(action.tool)}
          </Text>
          {`  ${clip(action.preview.split('\n')[0] ?? '', 70)}`}
        </Text>
      ))}
      <Text color={C.muted} dimColor>
        {'  approve with /perm acceptEdits or /perm auto'}
      </Text>
    </Box>
  )
}

const HELP = `Commands:  /help  /effort normal|medium|high  /perm default|acceptEdits|plan|auto  /image <path>  /commit  /review  /clear  /exit
Approvals:  [y] allow once  [a] always  [n] deny   ·   Keys: ^R thinking  ^O context  ↑/↓ history  ^C quit`

const COMMIT_PROMPT =
  'Commit the current changes. First run `git status` and `git diff --staged` (and `git add -A` if nothing is staged) using Bash, then write a clear, concise commit message and run `git commit`. Show me the message you used.'

const REVIEW_PROMPT =
  'Review the current working-tree changes. Run `git diff` (and `git status`) using Bash, then summarize the changes and flag any bugs, risks, or improvements. Do not modify any files.'

function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

function summarizeArgs(input: unknown): string {
  const text = safeStringify(input)
  return text.length > 72 ? `${text.slice(0, 71)}…` : text
}

function markLastTool(tools: ToolEntry[], name: string, ok: boolean, result: string): ToolEntry[] {
  const copy = [...tools]
  for (let i = copy.length - 1; i >= 0; i -= 1) {
    if (copy[i]?.name === name && copy[i]?.ok === undefined) {
      copy[i] = { ...(copy[i] as ToolEntry), ok, result }
      break
    }
  }
  return copy
}

function firstLines(text: string, max: number): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : `${lines.slice(0, max).join('\n')}\n…`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
