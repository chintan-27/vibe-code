import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage, ChatOptions } from '@/provider/types.ts'
import { createThinkSplitter, isIncompleteToolJson, stripThinkBlocks } from '@/toolcall/parse.ts'
import type { ChatClient, EffortMode, RuntimeNotice, TurnUsage } from './types.ts'

const RECENT_TAIL = 6

// How long VibeThinker reasons, by effort (low never reasons).
const REASON_TOKENS: Record<EffortMode, number> = { low: 0, medium: 3072, high: 5120, xhigh: 8192 }
// Research queries get more thinking budget at high/xhigh — they need depth, not speed.
const RESEARCH_REASON_TOKENS: Record<EffortMode, number> = { low: 0, medium: 3072, high: 8192, xhigh: 16384 }

export type TwoPhaseOptions = {
  effort: EffortMode
  isResearch?: boolean
  onThink?: (text: string) => void
  onToken?: (text: string) => void
  onUsage?: (usage: TurnUsage) => void
  onNotice?: (notice: RuntimeNotice) => void
  signal?: AbortSignal
}

/**
 * One turn. Effort controls whether/how much VibeThinker reasons:
 * - low:    no reasoning — qwen acts directly (fast lane).
 * - medium: dynamic — a quick check decides whether reasoning is needed.
 * - high:   reason, then qwen reviews the plan.
 * - xhigh:  reason longer, then qwen + gemma review.
 * qwen always produces the final structured action.
 */
export async function runTwoPhaseStep(
  client: ChatClient,
  messages: ChatMessage[],
  opts: TwoPhaseOptions,
): Promise<string> {
  const extractor = getModelProfile('extractor')

  // LOW — no reasoning: qwen acts directly on the curated conversation.
  if (opts.effort === 'low') return directExtract(client, extractor.model, messages, opts)

  // MEDIUM — dynamic: reason only when the request looks like it needs it.
  if (opts.effort === 'medium' && !(await needsThinking(client, messages, opts.signal, opts.onThink))) {
    return directExtract(client, extractor.model, messages, opts)
  }

  const reasoner = getModelProfile('reasoner')
  const systemPrompt = messages[0]?.role === 'system' ? messages[0].content : ''
  const recent = renderRecent(messages.slice(1).slice(-RECENT_TAIL))
  const tokenBudget = (opts.isResearch ? RESEARCH_REASON_TOKENS : REASON_TOKENS)[opts.effort]

  // Phase 1 — VibeThinker reasons. Whole output is reasoning → thinking panel.
  const reasoning = await streamRaw(
    client,
    reasoner.model,
    messages,
    { ...reasoner.defaults, maxTokens: tokenBudget, signal: opts.signal },
    opts.onThink,
  )
  const conclusion = stripThinkBlocks(reasoning) || reasoning.trim()

  // If VibeThinker produced a substantive explanatory answer with no apparent tool need,
  // emit it directly — qwen's JSON extraction step would only compress it.
  if (conclusion.split(/\s+/).length > 200 && !likelyNeedsToolCall(conclusion)) {
    opts.onToken?.(conclusion)
    return conclusion
  }

  // Phase 2 (high / xhigh) — overlookers critique the plan before acting.
  // xhigh always includes gemma; high includes it only if VIBE_REVIEW_GEMMA=1.
  const review =
    opts.effort === 'high' || opts.effort === 'xhigh'
      ? await overlook(client, recent, conclusion, opts.effort === 'xhigh', opts.signal, opts.onThink)
      : ''

  // Phase 3 — qwen either extracts a required action or returns a direct response.
  const extractionMessages: ChatMessage[] = [
    {
      role: 'system',
      content: `${systemPrompt}\n\n---\nYou are the extraction step. Return kind="tool" only when a tool is necessary for the user's explicit request. Otherwise return kind="final" with the best visible answer or one focused clarifying question. Preserve the useful detail from the reasoning and tool results; do not summarize a requested explanation, tutorial, math derivation, research answer, or architecture answer down to a short paragraph. Never invent a task, exploratory tool call, or next step merely because tools are available. Use the required JSON schema. Output no hidden reasoning.`,
    },
    {
      role: 'user',
      content: `${recent}\n\nReasoning to act on:\n${conclusion}${review ? `\n\nReviewer notes to address:\n${review}` : ''}`,
    },
  ]
  const extracted = (await constrainedExtract(client, extractor.model, extractionMessages, { ...extractor.defaults, signal: opts.signal }, opts))
    ?? (await streamVisible(
    client,
    extractor.model,
    extractionMessages,
    { ...extractor.defaults, signal: opts.signal },
    opts.onToken,
    opts.onUsage,
    opts.onNotice,
  ))

  return stripThinkBlocks(extracted)
}

/** No-reasoning path: qwen acts directly on the curated conversation. */
function directExtract(
  client: ChatClient,
  model: string,
  messages: ChatMessage[],
  opts: TwoPhaseOptions,
): Promise<string> {
  const options = { ...getModelProfile('extractor').defaults, signal: opts.signal }
  return constrainedExtract(client, model, messages, options, opts)
    .then(result => result ?? streamVisible(client, model, messages, options, opts.onToken, opts.onUsage, opts.onNotice))
    .then(stripThinkBlocks)
}

async function constrainedExtract(
  client: ChatClient,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  opts: Pick<TwoPhaseOptions, 'onUsage' | 'onNotice'>,
): Promise<string | undefined> {
  try {
    let result = await client.chat(
      model,
      [
        ...messages,
        {
          role: 'user',
          content:
            'Return the next assistant output using the schema. Use kind="tool" with name and arguments for a tool call, or kind="final" with content when no tool is needed. For explanation, research, math, step-by-step, comparison, or architecture requests, final.content must be substantive and structured: include a scope/assumptions paragraph, numbered steps/stages, equations with variable definitions when math is requested, validation/caveats, and grounding from available context/tool results. If a web/search tool failed, explicitly state that failure instead of implying web research succeeded. Do not compress such answers into a brief summary.',
        },
      ],
      {
        ...options,
        temperature: 0,
        format: ACTION_SCHEMA,
      },
    )
    if (result.usage.doneReason === 'length' || isIncompleteToolJson(result.content)) {
      opts.onNotice?.({
        level: 'warn',
        title: 'Retrying truncated action',
        message: 'The constrained response ended before a complete action was available.',
      })
      result = await client.chat(
        model,
        [
          ...messages,
          {
            role: 'user',
            content:
              'Your previous constrained response was truncated. Return the complete action using the schema only. If kind="final", preserve the requested detail rather than shortening the answer.',
          },
        ],
        {
          ...options,
          temperature: 0,
          maxTokens: Math.max((options.maxTokens ?? 0) * 2, 16_384),
          format: ACTION_SCHEMA,
        },
      )
    }
    opts.onUsage?.(result.usage)
    const decoded = JSON.parse(stripThinkBlocks(result.content)) as {
      kind?: string
      name?: unknown
      arguments?: unknown
      content?: unknown
    }
    if (decoded.kind === 'final' && typeof decoded.content === 'string') return decoded.content
    if (decoded.kind === 'tool' && typeof decoded.name === 'string' && decoded.arguments && typeof decoded.arguments === 'object') {
      return JSON.stringify({ name: decoded.name, arguments: decoded.arguments })
    }
    if (typeof decoded.name === 'string' && decoded.arguments && typeof decoded.arguments === 'object') {
      return JSON.stringify({ name: decoded.name, arguments: decoded.arguments })
    }
    opts.onNotice?.({
      level: 'warn',
      title: 'Schema extraction fallback',
      message: 'The constrained response did not contain a usable final answer or tool call.',
    })
    return undefined
  } catch (error) {
    opts.onNotice?.({
      level: 'warn',
      title: 'Schema extraction fallback',
      message: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['tool', 'final'] },
    name: { type: 'string' },
    arguments: { type: 'object' },
    content: { type: 'string' },
  },
  required: ['kind'],
}

/** Quick qwen classification: does this request need step-by-step reasoning? */
async function needsThinking(
  client: ChatClient,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onThink?: (text: string) => void,
): Promise<boolean> {
  const extractor = getModelProfile('extractor')
  const recent = renderRecent(messages.slice(1).slice(-RECENT_TAIL))
  const latest = messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
  if (needsExplanatoryReasoning(latest)) {
    onThink?.('[dynamic] reasoning needed for detailed explanation\n')
    return true
  }
  try {
    const res = await client.chat(
      extractor.model,
      [
        {
          role: 'system',
          content:
            'Reply YES only when the latest user request explicitly requires a multi-step tool-assisted action. Reply NO for statements, shared context, questions answerable from the conversation, or requests with no needed tool call. Reply with exactly YES or NO.',
        },
        { role: 'user', content: recent || (messages.at(-1)?.content ?? '') },
      ],
      { ...extractor.defaults, maxTokens: 8, temperature: 0, signal },
    )
    const yes = /\byes\b/i.test(stripThinkBlocks(res.content))
    onThink?.(yes ? '[dynamic] reasoning needed\n' : '[dynamic] acting directly\n')
    return yes
  } catch {
    return true // when unsure, prefer reasoning
  }
}

function needsExplanatoryReasoning(input: string): boolean {
  return /\b(in[- ]?depth|deep dive|step[- ]by[- ]step|stages?|math|equations?|derive|derivation|explain|how\b|research|gather information|architecture|compare|comparison)\b/i.test(input)
}

function likelyNeedsToolCall(text: string): boolean {
  return /\{\s*"name"\s*:/i.test(text) || /\b(let me|I'll|I should|I need to)\s+(run|call|use|execute|search|read|write|edit|fetch|look up)\b/i.test(text)
}

/**
 * Reviewers critique the plan in parallel. Default reviewer is qwen (already loaded
 * for extraction, so no extra model swap). gemma is opt-in via VIBE_REVIEW_GEMMA=1
 * (it's a separate model — loading it per turn is the main source of `high` slowness).
 */
async function overlook(
  client: ChatClient,
  recent: string,
  conclusion: string,
  forceGemma: boolean,
  signal?: AbortSignal,
  onThink?: (text: string) => void,
): Promise<string> {
  const reviewers = [getModelProfile('extractor')]
  if (forceGemma || process.env.VIBE_REVIEW_GEMMA === '1') reviewers.push(getModelProfile('vision'))

  const notes = await Promise.all(
    reviewers.map(async reviewer => {
      try {
        const res = await client.chat(
          reviewer.model,
          [
            {
              role: 'system',
              content:
                'You are a critical reviewer. In one or two sentences, flag any flaw, risk, or missing step in the proposed plan. If it is sound, reply exactly "OK".',
            },
            { role: 'user', content: `Task context:\n${recent}\n\nProposed plan:\n${conclusion}` },
          ],
          { ...reviewer.defaults, maxTokens: 200, signal },
        )
        const note = stripThinkBlocks(res.content).trim()
        onThink?.(`\n[review · ${reviewer.role}] ${note}\n`)
        return note && !/^ok\b/i.test(note) ? `[${reviewer.role}] ${note}` : ''
      } catch {
        return '' // a missing/unavailable reviewer model must not break the turn
      }
    }),
  )
  return notes.filter(Boolean).join('\n')
}

/** Stream a model's full output to a raw sink (used for reasoning). */
async function streamRaw(
  client: ChatClient,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onText?: (text: string) => void,
): Promise<string> {
  if (onText && client.chatStream) {
    const result = await client.chatStream(model, messages, options, delta => onText(delta))
    return result.content
  }
  const result = await client.chat(model, messages, options)
  return result.content
}

/** Stream a model's output, emitting only the non-think (visible) portion. */
async function streamVisible(
  client: ChatClient,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onToken?: (text: string) => void,
  onUsage?: (usage: TurnUsage) => void,
  onNotice?: (notice: RuntimeNotice) => void,
): Promise<string> {
  const run = async (msgs: ChatMessage[], runOptions: ChatOptions): Promise<{ content: string; usage: TurnUsage }> => {
    if (onToken && client.chatStream) {
      const split = createThinkSplitter()
      const result = await client.chatStream(model, msgs, runOptions, delta => {
        const { visible } = split(delta)
        if (visible) onToken(visible)
      })
      return { content: result.content, usage: result.usage }
    }
    const result = await client.chat(model, msgs, runOptions)
    return { content: result.content, usage: result.usage }
  }

  const first = await run(messages, options)
  onUsage?.(first.usage)
  if (first.usage.doneReason !== 'length' && !isIncompleteToolJson(first.content)) {
    return first.content
  }

  onNotice?.({
    level: 'warn',
    title: 'Retrying truncated action',
    message: 'The model stopped before completing a tool call, so Vibe is retrying once with a larger output cap.',
  })
  const retryMessages: ChatMessage[] = [
    ...messages,
    {
      role: 'user',
      content:
        'Your previous response was truncated or incomplete. Return the complete tool-call JSON only. Do not include prose or hidden reasoning.',
    },
  ]
  const second = await run(retryMessages, {
    ...options,
    temperature: 0,
    maxTokens: Math.max((options.maxTokens ?? 0) * 2, 16_384),
  })
  onUsage?.(second.usage)
  if (second.usage.doneReason === 'length' || isIncompleteToolJson(second.content)) {
    onNotice?.({
      level: 'error',
      title: 'Tool call still incomplete',
      message: 'The retry also ended before a complete tool call was available.',
    })
  }
  return second.content
}

function renderRecent(messages: ChatMessage[]): string {
  if (messages.length === 0) return '[no prior turns]'
  return ['Recent conversation:', ...messages.map(message => `${label(message)}: ${message.content}`)].join('\n')
}

function label(message: ChatMessage): string {
  return message.role === 'tool' && message.toolName ? `tool:${message.toolName}` : message.role
}
