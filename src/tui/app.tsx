import { Box, render, Text, useApp, useInput, useStdout, type Key } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentSession } from '@/loop/session.ts'
import { initializeProject } from '@/cli/init.ts'
import { buildGraphIndex, graphIndexStatus } from '@/context/graph/index.ts'
import type {
  EffortMode,
  ContextInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PlannedAction,
  RuntimeNotice,
  SessionEvents,
} from '@/loop/types.ts'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { isTrusted, trustDir } from '@/config/trust.ts'
import { getModelProfile } from '@/provider/models.ts'
import { OllamaClient } from '@/provider/ollama.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'
import { coreTools } from '@/tools/registry.ts'
import type { AnyTool } from '@/tools/types.ts'
import type { HooksConfig } from '@/hooks/hooks.ts'
import { listCheckpoints, listSessionMetadata, restoreCheckpoint } from '@/loop/workflow.ts'
import {
  extensionInfo,
  extensionSummary,
  installExtension,
  listExtensions,
  removeExtension,
  setExtensionEnabled,
  trustExtension,
} from '@/plugins/manager.ts'
import type { PluginSettings } from '@/plugins/manager.ts'

export type TuiOptions = {
  workspaceRoot: string
  effort: EffortMode
  permissionMode: PermissionMode
  allow?: string[]
  hooks?: HooksConfig
  extraTools?: AnyTool[]
  extensionSettings?: PluginSettings
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
  | { kind: 'notice'; id: number; notice: RuntimeNotice }
  | { kind: 'plan'; id: number; actions: PlannedAction[] }

type Live = {
  active: boolean
  assistant: string
  think: string
  tools: ToolEntry[]
  notices: RuntimeNotice[]
}

type SlashCommand = {
  name: string
  hint: string
  args?: string
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const PASTE_GAP_MS = 45 // a return arriving this soon after a keystroke is a pasted newline, not submit
function freshLive(): Live {
  return { active: false, assistant: '', think: '', tools: [], notices: [] }
}

const IMG_RE = /(?:'[^'\n]+\.(?:png|jpe?g|gif|webp|bmp)'|"[^"\n]+\.(?:png|jpe?g|gif|webp|bmp)"|(?:[^\s'"]|\\ )+\.(?:png|jpe?g|gif|webp|bmp))/gi

/**
 * Process a pasted chunk for display: keep the real content but show a compact
 * placeholder. Image/file paths are copied to a durable temp (macOS deletes
 * screenshot temps fast) and shown as "[Pasted File: name]"; text blocks over a
 * handful of lines collapse to "[Pasted N lines]". The store maps each placeholder
 * back to its real content for submission.
 */
export function collapsePaste(value: string, store: Map<string, string>): string {
  let foundFile = false
  const withFiles = value.replace(IMG_RE, match => {
    const clean = match.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')
    try {
      if (!existsSync(clean)) return match
      const dest = join(tmpdir(), 'vibe-attachments', `${Date.now()}-${basename(clean)}`)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(clean, dest)
      const label = `[Pasted File: ${basename(clean)}]`
      store.set(label, dest)
      foundFile = true
      return label
    } catch {
      return match
    }
  })
  const lines = value.split('\n').length
  if (!foundFile && lines > 6) {
    const label = `[Pasted ${lines} lines]`
    store.set(label, value)
    return label
  }
  return withFiles
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
  user: '›',
  assistant: '●',
  tool: '⏺',
  result: '⎿',
  reasoning: '✸',
  plan: '◇',
  note: '◆',
  bullet: '▸',
  spark: '✦',
}

const COMMANDS: SlashCommand[] = [
  { name: '/help', hint: 'show command help' },
  { name: '/init', hint: 'generate VIBE.md' },
  { name: '/context', hint: 'toggle context panel', args: '[query]' },
  { name: '/diff', hint: 'show git summary' },
  { name: '/rewind', hint: 'list checkpoints', args: '[id]' },
  { name: '/sessions', hint: 'list saved sessions' },
  { name: '/resume', hint: 'planned resume entry', args: '<id>' },
  { name: '/commit', hint: 'commit current changes' },
  { name: '/review', hint: 'review working tree' },
  { name: '/plan', hint: 'toggle read-only planning' },
  { name: '/plugins', hint: 'manage skills/plugins', args: 'list|add|info|trust|enable|disable|remove|update' },
  { name: '/perm', hint: 'set permission mode', args: 'default|acceptEdits|plan|auto' },
  { name: '/effort', hint: 'set effort', args: 'low|medium|high|xhigh' },
  { name: '/image', hint: 'read image path', args: '<path> [question]' },
  { name: '/clear', hint: 'clear transcript' },
  { name: '/exit', hint: 'quit' },
]

export function startTui(options: TuiOptions): Promise<void> {
  const instance = render(<App options={options} />)
  return instance.waitUntilExit()
}

export function App({ options }: { options: TuiOptions }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 100
  const height = stdout?.rows ?? 24

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
  const abortRef = useRef<AbortController | null>(null)
  const [context, setContext] = useState<ContextInfo>({ files: [], approxTokens: 0 })
  const [tokensThisTurn, setTokensThisTurn] = useState(0)
  const [tokPerSec, setTokPerSec] = useState(0)
  const [loadMs, setLoadMs] = useState(0)
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
  const [qIndex, setQIndex] = useState(0) // highlighted option in a question prompt
  const [qTyping, setQTyping] = useState(false) // chose "type my own answer"
  const [frame, setFrame] = useState(0)
  const [trusted, setTrusted] = useState(() => isTrusted(options.workspaceRoot))
  const [commandIndex, setCommandIndex] = useState(0)
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
  const moveCursor = (delta: number) => {
    cursorRef.current = Math.max(0, Math.min(inputRef.current.length, cursorRef.current + delta))
    setCursorView(cursorRef.current)
  }
  const deleteWord = () => {
    const i = cursorRef.current
    if (i === 0) return
    const before = inputRef.current.slice(0, i).replace(/[^\S\n]*[^\s]*$/, '') // trailing spaces + last word
    inputRef.current = before + inputRef.current.slice(i)
    cursorRef.current = before.length
    syncInput()
  }
  const deleteToStart = () => {
    inputRef.current = inputRef.current.slice(cursorRef.current)
    cursorRef.current = 0
    syncInput()
  }
  const insertNewline = () => insertText('\n')
  const replaceTrailingBackslashWithNewline = (): boolean => {
    const i = cursorRef.current
    if (i === 0 || inputRef.current[i - 1] !== '\\') return false
    inputRef.current = `${inputRef.current.slice(0, i - 1)}\n${inputRef.current.slice(i)}`
    cursorRef.current = i
    syncInput()
    return true
  }
  // Paste store: maps a friendly placeholder (e.g. "[Pasted 23 lines]") to the real content.
  const pasteStore = useRef(new Map<string, string>())
  const expandPastes = (text: string): string => {
    let out = text
    for (const [label, content] of pasteStore.current) out = out.split(label).join(content)
    return out
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
        if (usage.loadDurationMs !== undefined) setLoadMs(usage.loadDurationMs)
      },
      onNotice: notice => {
        liveRef.current.notices.push(notice)
        setTranscript(prev => [...prev, { kind: 'notice', id: nextId(), notice }])
        dirtyRef.current = true
      },
      onPermissionRequest: request =>
        new Promise<PermissionDecision>(resolve => setPendingPermission({ request, resolve })),
      onAskUser: (question, options2) =>
        new Promise<string>(resolve => {
          setQIndex(0)
          setQTyping(false)
          setPendingQuestion({ question, options: options2, resolve })
        }),
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
      extensionSettings: options.extensionSettings,
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
        setLive({
          active: true,
          assistant: current.assistant,
          think: current.think,
          tools: [...current.tools],
          notices: [...current.notices],
        })
        setTokensThisTurn(tokensRef.current)
      }
    }, 60)
    return () => clearInterval(timer)
  }, [live.active])

  useEffect(() => {
    setCommandIndex(0)
  }, [inputView])

  const submit = useCallback(async (text: string) => {
    const session = sessionRef.current
    if (!session || liveRef.current.active) return
    setTranscript(prev => [...prev, { kind: 'user', id: nextId(), text }])
    setHistory(prev => [...prev, text])
    setHistoryIdx(-1)
    liveRef.current = { active: true, assistant: '', think: '', tools: [], notices: [] }
    tokensRef.current = 0
    dirtyRef.current = false
    turnStartRef.current = Date.now()
    const controller = new AbortController()
    abortRef.current = controller
    setLive({ active: true, assistant: '', think: '', tools: [], notices: [] })
    setTokensThisTurn(0)

    let result
    try {
      result = await session.run(text, controller.signal)
    } catch (error) {
      const stopped = controller.signal.aborted || /abort/i.test(asMessage(error))
      setTranscript(prev => [
        ...prev,
        { kind: 'note', id: nextId(), text: stopped ? '⊘ Stopped.' : `Error: ${asMessage(error)}` },
      ])
      liveRef.current = freshLive()
      setLive(freshLive())
      abortRef.current = null
      return
    }
    abortRef.current = null

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
    // Word delete: Option/Alt+Backspace, Ctrl+W, or raw ESC+DEL.
    if ((key.meta && (key.backspace || key.delete)) || (key.ctrl && value === 'w') || value === '\x17' || value === '\x1b\x7f')
      return deleteWord()
    // Delete to line start: Cmd+Backspace (when it reaches us) or Ctrl+U.
    if ((key.meta && key.ctrl) || (key.ctrl && value === 'u') || value === '\x15') return deleteToStart()
    // macOS Backspace arrives as key.delete (DEL 0x7f); treat both as delete-before-cursor.
    if (key.backspace || key.delete) return backspaceAt()
    if (key.return) {
      if (key.shift) return insertNewline()
      if (replaceTrailingBackslashWithNewline()) return
      if (Date.now() - lastEditAt.current < PASTE_GAP_MS) return insertText('\n')
      const text = expandPastes(inputRef.current)
      setInputAll('')
      pasteStore.current.clear()
      onSubmit(text)
      return
    }
    if (value && !key.ctrl && !key.meta) {
      // A paste (multi-char): keep the real content but show a compact placeholder for
      // files/images and big text blocks. Verbatim for short inline text.
      insertText(value.length > 1 ? collapsePaste(value, pasteStore.current) : value)
    }
  }

  const runInputLine = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    if (text === '/exit' || text === '/quit') return exit()
    if (text === '/help') return setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: HELP }])
    if (text === '/context index') {
      setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: 'Building GraphRAG index…' }])
      void buildGraphIndex(options.workspaceRoot, {
        onProgress: progress => {
          setTranscript(prev => [...prev, { kind: 'notice', id: nextId(), notice: { level: 'info', title: 'GraphRAG indexing', message: progress.message } }])
        },
      })
        .then(index => {
          const stats = index.stats
          index.close()
          setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `GraphRAG indexed ${stats.files} files, ${stats.symbols} symbols, ${stats.chunks} chunks, ${stats.edges} edges.` }])
        })
        .catch(error => {
          setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `GraphRAG index failed: ${error instanceof Error ? error.message : String(error)}` }])
        })
      return
    }
    if (text === '/context status') {
      void graphIndexStatus(options.workspaceRoot).then(status => {
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: status }])
      })
      return
    }
    if (text.startsWith('/context')) {
      setShowContext(s => !s)
      return
    }
    if (text === '/clear') return setTranscript([])
    if (text === '/commit') return void submit(COMMIT_PROMPT)
    if (text === '/review') return void submit(REVIEW_PROMPT)
    if (text.startsWith('/plugins')) {
      void runPluginCommand(options.workspaceRoot, text.slice('/plugins'.length).trim(), options.extensionSettings).then(message => {
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: message }])
      })
      return
    }
    if (text === '/plan') {
      const next = permMode === 'plan' ? 'default' : 'plan'
      setPermMode(next)
      setTranscript(prev => [
        ...prev,
        {
          kind: 'note',
          id: nextId(),
          text:
            next === 'plan'
              ? 'Plan mode enabled. Mutating tools will be proposed, not executed.'
              : 'Plan mode disabled. Permission mode restored to default.',
        },
      ])
      return
    }
    if (text === '/init') {
      setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: 'Analyzing repository and writing VIBE.md…' }])
      void initializeProject(options.workspaceRoot, client)
        .then(result => {
          setTranscript(prev => [
            ...prev,
            { kind: 'note', id: nextId(), text: `Wrote ${result.path} and seeded a ${result.memoryName} memory.` },
          ])
        })
        .catch(error => {
          setTranscript(prev => [
            ...prev,
            { kind: 'note', id: nextId(), text: `init failed: ${error instanceof Error ? error.message : String(error)}` },
          ])
        })
      return
    }
    if (text === '/diff') return setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: gitSummary(options.workspaceRoot) }])
    if (text === '/rewind') {
      void listCheckpoints(options.workspaceRoot).then(checkpoints => {
        setTranscript(prev => [
          ...prev,
          {
            kind: 'note',
            id: nextId(),
            text:
              checkpoints.length === 0
                ? 'No checkpoints yet.'
                : `${checkpoints
                    .slice(0, 8)
                    .map(cp => `${cp.timestamp}  ${cp.tool}  ${cp.touchedFiles.join(', ')}`)
                    .join('\n')}\nRestore is not available until checkpoint confirmation lands.`,
          },
        ])
      })
      return
    }
    if (text.startsWith('/rewind restore')) {
      const [, , sessionId, turnText, confirm] = text.split(/\s+/)
      if (!sessionId || !turnText || confirm !== '--confirm') {
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: 'usage: /rewind restore <sessionId> <turn> --confirm' }])
        return
      }
      void restoreCheckpoint(options.workspaceRoot, sessionId, Number.parseInt(turnText, 10))
        .then(meta => {
          setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `Restored checkpoint ${meta.sessionId}/${meta.turn}: ${meta.touchedFiles.join(', ')}` }])
        })
        .catch(error => {
          setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `restore failed: ${error instanceof Error ? error.message : String(error)}` }])
        })
      return
    }
    if (text === '/sessions') {
      void listSessionMetadata(options.workspaceRoot).then(sessions => {
        setTranscript(prev => [
          ...prev,
          {
            kind: 'note',
            id: nextId(),
            text: sessions.length === 0 ? 'No saved sessions yet.' : sessions.map(s => `${s.id}  ${s.updatedAt}  ${s.title}`).join('\n'),
          },
        ])
      })
      return
    }
    if (text.startsWith('/resume')) {
      const id = text.split(/\s+/)[1]
      return setTranscript(prev => [
        ...prev,
        { kind: 'note', id: nextId(), text: id ? `Resume ${id} is planned, but full resume is not available yet.` : 'usage: /resume <session-id>' },
      ])
    }
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
      if (next === 'low' || next === 'medium' || next === 'high' || next === 'xhigh') setEffort(next)
      else setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `effort is ${effort}. Use /effort low|medium|high|xhigh` }])
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
      // While a turn is running, ^C interrupts it; when idle, it quits.
      if (live.active && abortRef.current) abortRef.current.abort()
      else exit()
      return
    }
    // Workspace trust gate: nothing else runs until the folder is trusted.
    if (!trusted) {
      if (value === 'y' || value === 'Y') {
        trustDir(options.workspaceRoot)
        setTrusted(true)
      } else if (value === 'n' || value === 'N' || key.escape) {
        exit()
      }
      return
    }
    // A pending permission prompt captures single keys, even mid-turn.
    if (pendingPermission) {
      if (value === 'y') resolvePermission('allow')
      else if (value === 'a') resolvePermission('allow-always')
      else if (value === 'n' || key.escape) resolvePermission('deny')
      return
    }
    // A pending clarifying question: arrow-select options, or type a custom answer.
    if (pendingQuestion) {
      const resolveQuestion = (answer: string) => {
        pendingQuestion.resolve(answer.trim())
        setTranscript(prev => [...prev, { kind: 'note', id: nextId(), text: `↳ ${answer.trim() || '(skipped)'}` }])
        setPendingQuestion(null)
        setQTyping(false)
        setQIndex(0)
      }
      const options = pendingQuestion.options ?? []
      if (options.length > 0 && !qTyping) {
        const total = options.length + 1 // options + "type my own answer"
        if (key.upArrow) return setQIndex(i => (i - 1 + total) % total)
        if (key.downArrow) return setQIndex(i => (i + 1) % total)
        if (key.return) {
          if (qIndex === options.length) setQTyping(true) // chose "type my own"
          else resolveQuestion(options[qIndex] ?? '')
          return
        }
        return // ignore other keys while selecting
      }
      editText(value, key, resolveQuestion)
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
    // Esc interrupts the running turn (model + tools abort, back to the prompt).
    if (live.active && key.escape) {
      abortRef.current?.abort()
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
    const suggestions = commandSuggestions(inputRef.current)
    if (suggestions.length > 0) {
      if (key.upArrow) {
        setCommandIndex(i => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (key.downArrow) {
        setCommandIndex(i => (i + 1) % suggestions.length)
        return
      }
      if (key.tab) {
        completeCommand(suggestions[Math.min(commandIndex, suggestions.length - 1)]?.name)
        return
      }
      if (key.return && !isExactCommand(inputRef.current)) {
        completeCommand(suggestions[Math.min(commandIndex, suggestions.length - 1)]?.name)
        return
      }
    }
    editText(value, key, runInputLine)
  })

  const elapsedS = live.active ? Math.max(0, Math.round((Date.now() - turnStartRef.current) / 1000)) : 0
  const wide = width >= 108
  const mainWidth = width
  const suggestions = live.active ? [] : commandSuggestions(inputView)
  const selectedCommand = Math.min(commandIndex, Math.max(0, suggestions.length - 1))
  const inputRows = Math.min(6, inputView.split('\n').length + 2)
  const reservedRows =
    inputRows + // input
    1 + // status
    (suggestions.length > 0 && !live.active ? Math.min(9, suggestions.length * 2 + 3) : 0) +
    (pendingPermission ? 10 : 0) +
    (pendingQuestion ? 8 : 0) +
    (showContext ? 8 : 0)
  const transcriptRows = Math.max(4, height - reservedRows)
  const visibleTranscript = selectVisibleBlocks(transcript, transcriptRows)

  const completeCommand = (command?: string) => {
    if (!command) return
    setInputAll(`${command} `)
  }

  // Trust gate — shown until the workspace is approved.
  if (!trusted) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <BannerView model={profile.model} workspace={options.workspaceRoot} effort={effort} width={width} />
        <TrustGate workspace={options.workspaceRoot} width={width} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="column" width={width} flexGrow={1} flexShrink={1}>
        <Box flexDirection="column" width={mainWidth} flexGrow={1} flexShrink={1}>
          {visibleTranscript.map(block => (
            <BlockView key={block.id} block={block} width={mainWidth} />
          ))}

          {!wide && showContext && context.files.length > 0 && <ContextPanel context={context} width={mainWidth} />}

          {live.active && (
            <LiveTurnView
              live={live}
              showReasoning={showReasoning}
              elapsedS={elapsedS}
              frame={frame}
              width={mainWidth}
            />
          )}
        </Box>
      </Box>

      {pendingPermission && <PermissionPrompt request={pendingPermission.request} width={width} />}
      {pendingQuestion && (
        <QuestionPrompt
          question={pendingQuestion.question}
          options={pendingQuestion.options}
          selected={qIndex}
          typing={qTyping}
          width={width}
        />
      )}

      {wide && showContext && (
        <TopDashboard
          context={context}
          effort={effort}
          permMode={permMode}
          model={profile.model}
          live={live}
          tokPerSec={tokPerSec}
          loadMs={loadMs}
          width={width}
        />
      )}
      {suggestions.length > 0 && !live.active && (
        <CommandSuggestions commands={suggestions} selected={selectedCommand} width={width} />
      )}
      {wide ? (
        <MissionBar
          workspace={options.workspaceRoot}
          effort={effort}
          permMode={permMode}
          context={context}
          active={live.active}
          tokPerSec={tokPerSec}
          width={width}
        />
      ) : (
        <StatusBar
          effort={effort}
          permMode={permMode}
          model={profile.model}
          ctxTokens={context.approxTokens}
          budget={budget}
          tokPerSec={tokPerSec}
          loadMs={loadMs}
          tokensThisTurn={tokensThisTurn}
          active={live.active}
          width={width}
        />
      )}
      <Box borderStyle="round" borderColor={live.active ? C.muted : C.accent} paddingX={1} width={width}>
        <Text color={live.active ? C.muted : C.accent} bold>
          {`${G.user} `}
        </Text>
        {live.active ? (
          <Text color="gray">turn in progress · Esc stops · ^C quits</Text>
        ) : inputView === '' ? (
          <Text>
            <Text inverse> </Text>
            <Text color="gray">{'  Ask, paste, drag files, type /, or \\↵ newline'}</Text>
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

function MissionBar(props: {
  workspace: string
  effort: EffortMode
  permMode: PermissionMode
  context: ContextInfo
  active: boolean
  tokPerSec: number
  width: number
}) {
  const cwd = basename(props.workspace)
  const budget = props.context.budgetTokens ?? getModelProfile('coder').defaults.numCtx
  const pct = Math.min(100, Math.round((props.context.approxTokens / budget) * 100))
  const model = getModelProfile('coder').model.replace(':7b', '')
  return (
    <Box width={props.width} paddingX={1}>
      <Box flexGrow={1}>
        <Text bold>{model}</Text>
        <Text color={C.muted}>+vibethinker · </Text>
        <Text color={C.accent}>{cwd || 'workspace'}</Text>
        <Text color={C.muted}> · </Text>
        <Badge label={props.permMode} color={permissionColor(props.permMode)} inverse />
        <Text color={C.muted}>{` · ${props.effort}`}</Text>
      </Box>
      <Text color={C.muted}>
        {'ctx '}
        <Text color={C.accent}>{`${pct}%`}</Text>
        {` · ${formatTokens(props.context.approxTokens)}/${formatTokens(budget)} · ${props.tokPerSec} tok/s`}
      </Text>
    </Box>
  )
}

function LiveTurnView({
  live,
  showReasoning,
  elapsedS,
  frame,
  width,
}: {
  live: Live
  showReasoning: boolean
  elapsedS: number
  frame: number
  width: number
}) {
  return (
    <Box flexDirection="column">
      {live.think.trim() !== '' &&
        (showReasoning ? (
          <ReasoningView text={live.think} live />
        ) : (
          <Box marginTop={1}>
            <Text color={C.muted} dimColor>
              {`${G.reasoning} thinking… ${formatTokens(approxTokens(live.think))} · ${elapsedS}s · ^R to expand`}
            </Text>
          </Box>
        ))}
      {live.tools.map((tool, i) => (
        <ToolView key={`live-tool-${i}`} tool={tool} width={width} />
      ))}
      {live.notices.slice(-2).map((notice, i) => (
        <NoticeView key={`live-notice-${i}-${notice.title}`} notice={notice} />
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
        <Text color={C.muted} dimColor>
          {'   ·  Esc stop'}
        </Text>
      </Box>
    </Box>
  )
}

function TopDashboard(props: {
  context: ContextInfo
  effort: EffortMode
  permMode: PermissionMode
  model: string
  live: Live
  tokPerSec: number
  loadMs: number
  width: number
}) {
  const budget = props.context.budgetTokens ?? getModelProfile('coder').defaults.numCtx
  const pct = Math.min(100, Math.round((props.context.approxTokens / budget) * 100))
  const activeTool = props.live.tools.find(tool => tool.ok === undefined)
  return (
    <Box width={props.width} borderStyle="single" borderColor={C.muted} paddingX={1}>
      <Box width={Math.floor(props.width * 0.34)} flexDirection="column">
        <Text color={C.accent} bold>{`${G.spark} Context`}</Text>
        <Text color={C.muted}>{`${meter(pct, 10)} ${formatTokens(props.context.approxTokens)}/${formatTokens(budget)}`}</Text>
        <Text color={C.muted}>{`${props.context.files.length} files${props.context.files[0] ? ` · ${clip(props.context.files[0], 24)}` : ''}`}</Text>
      </Box>
      <Box width={Math.floor(props.width * 0.34)} flexDirection="column">
        <Text color={C.accent} bold>Session</Text>
        <Text>
          <Badge label={props.effort.toUpperCase()} color={C.brand} />
          <Text color={C.muted}> </Text>
          <Badge label={props.permMode.toUpperCase()} color={permissionColor(props.permMode)} />
        </Text>
        <Text color={C.muted}>{`${clip(props.model, 24)} · ${props.tokPerSec} tok/s${props.loadMs ? ` · ${props.loadMs}ms` : ''}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={C.accent} bold>Activity</Text>
        <Text color={activeTool ? C.warn : C.muted}>{activeTool ? `running ${toolTitle(activeTool.name)}` : 'idle'}</Text>
        <Text color={C.muted}>{`${props.live.tools.length} tools · ${props.live.notices.length} notices · ^R reasoning · / commands`}</Text>
      </Box>
    </Box>
  )
}

function CommandSuggestions({
  commands,
  selected,
  width,
}: {
  commands: SlashCommand[]
  selected: number
  width: number
}) {
  const panelWidth = Math.min(Math.max(48, width - 8), 72)
  const marginLeft = Math.max(0, Math.floor((width - panelWidth) / 2))
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={C.muted}
      paddingX={1}
      width={panelWidth}
      marginLeft={marginLeft}
      marginTop={1}
    >
      <Text color={C.muted} bold>Commands</Text>
      {commands.slice(0, 6).map((command, i) => (
        <Box key={command.name} flexDirection="column">
          <Text color={i === selected ? C.accentBright : undefined} bold={i === selected}>
            {i === selected ? '› ' : '  '}
            {command.name}
            {command.args ? ` ${command.args}` : ''}
            <Text color={C.muted}>{`  ${command.hint}`}</Text>
          </Text>
          {i === selected && (
            <Text color={C.muted}>{`  ${commandDescription(command.name)}`}</Text>
          )}
        </Box>
      ))}
      <Text color={C.muted} dimColor>{'  ↑/↓ select · Tab complete · Enter choose/run'}</Text>
    </Box>
  )
}

function commandDescription(name: string): string {
  switch (name) {
    case '/context':
      return 'Toggle context panel, or run /context index and /context status.'
    case '/diff':
      return 'Show the current working-tree summary.'
    case '/rewind':
      return 'List checkpoints from previous mutating actions.'
    case '/init':
      return 'Analyze this repository and write a project-specific VIBE.md.'
    case '/plan':
      return 'Toggle read-only mode: propose writes/edits/commands without executing them.'
    case '/plugins':
      return 'Install and manage local skills, MCP plugins, JS plugins, and registry entries.'
    case '/sessions':
      return 'List saved local session metadata.'
    default:
      return 'Run command or insert it into the composer.'
  }
}

async function runPluginCommand(workspaceRoot: string, input: string, settings?: PluginSettings): Promise<string> {
  const [command = 'list', ...rest] = input.split(/\s+/).filter(Boolean)
  const arg = rest.join(' ')
  try {
    if (command === 'list') return extensionSummary(workspaceRoot, settings)
    if (command === 'add') {
      if (!arg) return 'usage: /plugins add <path|git|registry-id>'
      const extension = await installExtension(workspaceRoot, arg, settings)
      return `Installed ${extension.id} (${extension.manifest.kind ?? 'skill'}).${extension.trusted === 'untrusted' ? ` Run /plugins trust ${extension.id} before executable features load.` : ''}`
    }
    if (command === 'info') {
      if (!arg) return 'usage: /plugins info <id>'
      return extensionInfo(workspaceRoot, arg, settings)
    }
    if (command === 'enable' || command === 'disable') {
      if (!arg) return `usage: /plugins ${command} <id>`
      const extension = await setExtensionEnabled(workspaceRoot, arg, command === 'enable')
      return `${extension.id} ${extension.enabled ? 'enabled' : 'disabled'}.`
    }
    if (command === 'trust') {
      if (!arg) return 'usage: /plugins trust <id>'
      const extension = await trustExtension(workspaceRoot, arg)
      return `${extension.id} trusted. Restart or reset the session for executable features to load.`
    }
    if (command === 'remove') {
      if (!arg) return 'usage: /plugins remove <id>'
      await removeExtension(workspaceRoot, arg)
      return `${arg} removed.`
    }
    if (command === 'update') {
      const id = arg.trim()
      if (!id) {
        const extensions = await listExtensions(workspaceRoot, settings)
        if (extensions.length === 0) return 'No plugins installed.'
        const updated = await Promise.all(extensions.map(extension => installExtension(workspaceRoot, extension.source.value, settings)))
        return `Updated ${updated.map(extension => extension.id).join(', ')}.`
      }
      const extension = (await listExtensions(workspaceRoot, settings)).find(item => item.id === id)
      if (!extension) return `plugin not found: ${id}`
      const updated = await installExtension(workspaceRoot, extension.source.value, settings)
      return `Updated ${updated.id}.`
    }
    return 'usage: /plugins list|add|info|enable|disable|trust|remove|update'
  } catch (error) {
    return `plugins ${command} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function selectVisibleBlocks(blocks: Block[], maxRows: number): Block[] {
  let used = 0
  const out: Block[] = []
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (!block) continue
    const rows = estimateBlockRows(block)
    if (out.length > 0 && used + rows > maxRows) break
    out.unshift(block)
    used += rows
  }
  return out
}

function estimateBlockRows(block: Block): number {
  if (block.kind === 'banner') return 12
  if (block.kind === 'tool') return block.tool.name === 'Edit' ? 6 : 3
  if (block.kind === 'plan') return block.actions.length + 3
  if (block.kind === 'notice') return 3
  return Math.min(8, Math.max(2, 'text' in block ? block.text.split('\n').length + 1 : 2))
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
  if (block.kind === 'notice') {
    return <NoticeView notice={block.notice} />
  }
  if (block.kind === 'plan') {
    return <PlanView actions={block.actions} width={width} />
  }
  return <ToolView tool={block.tool} width={width} />
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
  const reasoner = getModelProfile('reasoner')
  const coder = getModelProfile('coder')
  const showLogo = width >= 70
  return (
    <Box flexDirection="column" width={width} marginBottom={1}>
      {showLogo ? (
        <Box flexDirection="column">
          {LOGO.map((line, i) => (
            <Text key={`logo-${i}`} color={LOGO_COLORS[i] ?? C.accent} bold>
              {line}
            </Text>
          ))}
          <Text> </Text>
        </Box>
      ) : (
        <Text>
          <Text color={C.accent} bold>▌ vibe code</Text>
        </Text>
      )}
      <Text>
        <Text bold>Vibe Code</Text>
        <Text color={C.muted}>{'  ·  local-first coding agent'}</Text>
      </Text>
      <Text color={C.muted}>
        {'model   '}
        <Text color={C.accent}>{model}</Text>
        {' + '}
        <Text color={C.brand}>vibethinker</Text>
        {`   (ctx ${formatTokens(coder.defaults.numCtx)} / ${formatTokens(reasoner.defaults.numCtx)})`}
      </Text>
      <Text color={C.muted}>
        {'cwd     '}
        <Text>{workspace}</Text>
      </Text>
      <Text color={C.muted} dimColor>
        {`hint    type a task, or /help for commands · ^C quit · effort ${effort}`}
      </Text>
    </Box>
  )
}

function ToolView({ tool, width }: { tool: ToolEntry; width: number }) {
  const dotColor = tool.ok === undefined ? C.warn : tool.ok ? C.ok : C.err
  const isTodos = tool.name === 'TodoWrite' && tool.ok
  const state = tool.ok === undefined ? 'running' : tool.ok ? 'done' : 'failed'
  const maxArg = Math.max(24, Math.min(86, width - 28))
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={dotColor}>{`${G.tool} `}</Text>
        <Text bold>{toolTitle(tool.name)}</Text>
        {prettyArgs(tool) ? (
          <Text color={C.muted}>{`(${clip(prettyArgs(tool), maxArg)})`}</Text>
        ) : null}
        <Text color={dotColor} dimColor={tool.ok !== undefined}>{` · ${state}`}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        <ToolPreview tool={tool} />
      </Box>
      {tool.name === 'Edit' ? <EditDiff raw={tool.raw} /> : null}
      {isTodos ? (
        <Box marginLeft={2}>
          <TodoView result={tool.result ?? ''} />
        </Box>
      ) : tool.result && tool.ok !== undefined ? (
        <Text color={tool.ok ? C.muted : C.err} dimColor={tool.ok}>
          {`  ${G.result} ${resultLine(tool)}`}
        </Text>
      ) : null}
    </Box>
  )
}

function ToolPreview({ tool }: { tool: ToolEntry }) {
  const raw = tool.raw && typeof tool.raw === 'object' ? (tool.raw as Record<string, unknown>) : {}
  const s = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (tool.name === 'Write') {
    const content = s(raw.content)
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color={C.muted}>{`${content.length} chars · ${Buffer.byteLength(content, 'utf8')} bytes`}</Text>
        <Text color={C.accent}>{firstLines(content || '[empty file]', 8)}</Text>
      </Box>
    )
  }
  if (tool.name === 'Read') return null
  if (tool.name === 'Bash') {
    return <Text color={C.brandBright}>{`$ ${clip(s(raw.command), 90)}`}</Text>
  }
  if (tool.name === 'Edit') return null
  return null
}

function NoticeView({ notice }: { notice: RuntimeNotice }) {
  const color = notice.level === 'error' ? C.err : notice.level === 'warn' ? C.warn : C.accent
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={color} paddingX={1}>
      <Text color={color} bold>
        {notice.title}
      </Text>
      <Text color={C.muted}>{clip(notice.message, 110)}</Text>
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
  const pending = live.tools.find(tool => tool.ok === undefined)
  if (pending) return `running ${toolTitle(pending.name)}…`
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
      {oldStr !== undefined && <Text color={C.err}>{`- ${firstLines(oldStr, 6)}`}</Text>}
      {newStr !== undefined && <Text color={C.ok}>{`+ ${firstLines(newStr, 6)}`}</Text>}
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
  const budget = context.budgetTokens ?? getModelProfile('coder').defaults.numCtx
  const pct = Math.min(100, Math.round((context.approxTokens / budget) * 100))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} width={width} marginTop={1}>
      <Text color={C.accent} bold>
        {`${G.spark} Context  ${meter(pct, 12)}  ${formatTokens(context.approxTokens)} / ${formatTokens(budget)}  ·  ${context.files.length} files`}
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
  loadMs: number
  tokensThisTurn: number
  active: boolean
  width: number
}) {
  const pct = Math.min(100, Math.round((props.ctxTokens / props.budget) * 100))
  const permColor = props.permMode === 'auto' ? C.err : props.permMode === 'plan' ? C.accent : C.ok
  return (
    <Box marginTop={1} width={props.width} paddingX={1}>
      <Text bold>{clip(props.model.replace(':7b', ''), 16)}</Text>
      <Text color={C.muted}>+vibethinker · </Text>
      <Text color={C.accent}>agent</Text>
      <Text color={C.muted}> · </Text>
      <Badge label={props.permMode} color={permColor} inverse />
      <Text color={C.muted}> · ctx </Text>
      <Text color={C.accent}>{`${pct}%`}</Text>
      <Text color={C.muted}>
        {` · ${props.tokPerSec} tok/s${props.loadMs ? ` · ${props.loadMs}ms` : ''}${props.active ? ` · +${formatTokens(props.tokensThisTurn)}` : ''}`}
      </Text>
    </Box>
  )
}

function Badge({ label, color, inverse = false }: { label: string; color: string; inverse?: boolean }) {
  return (
    <Text color={color} bold inverse={inverse}>
      {inverse ? ` ${label} ` : `[${label}]`}
    </Text>
  )
}

function permissionColor(mode: PermissionMode): string {
  if (mode === 'auto') return C.err
  if (mode === 'plan') return C.accent
  if (mode === 'acceptEdits') return C.warn
  return C.ok
}

function commandSuggestions(input: string): SlashCommand[] {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return []
  if (/\s/.test(trimmed)) return []
  const matches = COMMANDS.filter(command => command.name.startsWith(trimmed))
  return matches.length > 0 ? matches : COMMANDS.filter(command => command.name.includes(trimmed))
}

function isExactCommand(input: string): boolean {
  const trimmed = input.trim()
  return COMMANDS.some(command => command.name === trimmed)
}

/** Compact unicode progress meter, e.g. ███░░░. */
function meter(pct: number, width: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

function TrustGate({ workspace, width }: { workspace: string; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} width={width} marginTop={1}>
      <Text color={C.warn} bold>
        Do you trust the files in this folder?
      </Text>
      <Text color={C.muted}>{`  ${workspace}`}</Text>
      <Text color={C.muted}>
        {'  Vibe Code will read and index files here, and may run shell commands.'}
      </Text>
      <Text color={C.muted}>{'  Only proceed if you trust this folder.'}</Text>
      <Box marginTop={1}>
        <Text color={C.ok} bold>
          {' [y] '}
        </Text>
        <Text color={C.muted}>yes, trust it </Text>
        <Text color={C.err} bold>
          {' [n] '}
        </Text>
        <Text color={C.muted}>no, quit</Text>
      </Box>
    </Box>
  )
}

function PermissionPrompt({ request, width }: { request: PermissionRequest; width: number }) {
  const preview = formatPermissionPreview(request)
  const summary = formatPermissionSummary(request)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} width={width} marginTop={1}>
      <Text color={C.warn} bold>
        {'Approve'}
        <Text color={C.muted}>{'  ·  '}</Text>
        <Text>{summary}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>{preview}</Box>
      <Box marginTop={1}>
        <KeyChip label="y" color={C.ok} />
        <Text color={C.muted}>allow once </Text>
        <KeyChip label="a" color={C.accent} />
        <Text color={C.muted}>always </Text>
        <KeyChip label="n" color={C.err} />
        <Text color={C.muted}>deny</Text>
      </Box>
    </Box>
  )
}

function formatPermissionSummary(request: PermissionRequest): string {
  const raw = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {}
  const path = typeof raw.file_path === 'string' ? raw.file_path : ''
  const command = typeof raw.command === 'string' ? raw.command : ''
  if (path) return `${toolTitle(request.tool)}(${path})`
  if (command) return `${toolTitle(request.tool)}(${clip(command, 52)})`
  return toolTitle(request.tool)
}

function formatPermissionPreview(request: PermissionRequest): React.ReactNode[] {
  const raw = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {}
  const s = (value: unknown): string => (typeof value === 'string' ? value : '')
  if (request.tool === 'Edit') {
    return [
      <Text key="path" color={C.muted}>{`  file  ${s(raw.file_path)}`}</Text>,
      <Text key="old" color={C.err}>{`  - ${firstLines(s(raw.old_string), 4)}`}</Text>,
      <Text key="new" color={C.ok}>{`  + ${firstLines(s(raw.new_string), 4)}`}</Text>,
    ]
  }
  if (request.tool === 'Write') {
    const content = s(raw.content)
    return [
      <Text key="path" color={C.muted}>{`  file  ${s(raw.file_path)}`}</Text>,
      <Text key="count" color={C.muted}>{`  ${content.length} chars · ${Buffer.byteLength(content, 'utf8')} bytes`}</Text>,
      <Text key="body" color={C.muted}>{`  ${firstLines(content || '[empty file]', 6)}`}</Text>,
    ]
  }
  if (request.tool === 'Bash') {
    return [
      <Text key="cmd" color={C.muted}>{`  $ ${s(raw.command)}`}</Text>,
      <Text key="hint" color={C.warn}>{'  Review command side effects before allowing.'}</Text>,
    ]
  }
  return request.preview.split('\n').map((line, i) => (
    <Text key={`preview-${i}`} color={C.muted}>{`  ${line}`}</Text>
  ))
}

export function QuestionPrompt({
  question,
  options,
  selected,
  typing,
  width,
}: {
  question: string
  options?: string[]
  selected: number
  typing: boolean
  width: number
}) {
  const opts = options ?? []
  const hasOptions = opts.length > 0
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} width={width} marginTop={1}>
      <Text color={C.accent} bold>Question</Text>
      <Text>{question}</Text>
      {hasOptions && !typing ? (
        <Box flexDirection="column" marginTop={1}>
          {opts.map((opt, i) => (
            <Option key={`opt-${i}`} label={opt} active={selected === i} />
          ))}
          <Option label="✎ Type my own answer…" active={selected === opts.length} />
          <Text color={C.muted} dimColor>
            {'  ↑/↓ select · ↵ choose'}
          </Text>
        </Box>
      ) : (
        <Text color={C.muted} dimColor>
          {'  type your answer below, then Enter ↵'}
        </Text>
      )}
    </Box>
  )
}

function Option({ label, active }: { label: string; active: boolean }) {
  return (
    <Text color={active ? C.accentBright : C.muted} bold={active}>
      {active ? '❯ ' : '  '}
      {label}
    </Text>
  )
}

function KeyChip({ label, color }: { label: string; color: string }) {
  return (
    <Text color={color} inverse bold>
      {` ${label} `}
    </Text>
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
        {'  approve by switching out of /plan, or use /perm acceptEdits|auto'}
      </Text>
    </Box>
  )
}

const HELP = `Commands:  /help  /init  /plan  /context index|status  /effort low|medium|high|xhigh  /perm default|acceptEdits|plan|auto  /image <path>  /diff  /rewind  /sessions  /commit  /review  /clear  /exit
Modes:     /plan proposes changes without running them. default asks before edits, acceptEdits auto-applies file edits, auto runs unattended.
Approvals:  [y] allow once  [a] always  [n] deny   ·   Keys: ^R thinking  ^O context  ↑/↓ history  ^C quit`

const COMMIT_PROMPT =
  'Commit the current changes. First run `git status` and `git diff --staged` (and `git add -A` if nothing is staged) using Bash, then write a clear, concise commit message and run `git commit`. Show me the message you used.'

const REVIEW_PROMPT =
  'Review the current working-tree changes. Run `git diff` (and `git status`) using Bash, then summarize the changes and flag any bugs, risks, or improvements. Do not modify any files.'

function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}m`
  if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`
  return String(tokens)
}

function trimFixed(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
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

function gitSummary(cwd: string): string {
  const status = Bun.spawnSync(['git', 'status', '--short'], { cwd })
  const stat = Bun.spawnSync(['git', 'diff', '--stat'], { cwd })
  const statusText = status.stdout.toString().trim() || '[working tree clean]'
  const statText = stat.stdout.toString().trim()
  return [`# git status --short`, statusText, '', '# git diff --stat', statText || '[no unstaged diff]'].join('\n')
}
