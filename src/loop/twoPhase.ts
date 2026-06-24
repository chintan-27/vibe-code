import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { createThinkSplitter, stripThinkBlocks } from '@/toolcall/parse.ts'
import type { ChatClient, EffortMode, TurnUsage } from './types.ts'

const RECENT_TAIL = 6

// How long VibeThinker reasons, by effort (low never reasons).
const REASON_TOKENS: Record<EffortMode, number> = { low: 0, medium: 3072, high: 5120, xhigh: 8192 }

export type TwoPhaseOptions = {
  effort: EffortMode
  onThink?: (text: string) => void
  onToken?: (text: string) => void
  onUsage?: (usage: TurnUsage) => void
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
  if (opts.effort === 'medium' && !(await needsThinking(client, messages, opts.onThink))) {
    return directExtract(client, extractor.model, messages, opts)
  }

  const reasoner = getModelProfile('reasoner')
  const systemPrompt = messages[0]?.role === 'system' ? messages[0].content : ''
  const recent = renderRecent(messages.slice(1).slice(-RECENT_TAIL))

  // Phase 1 — VibeThinker reasons. Whole output is reasoning → thinking panel.
  const reasoning = await streamRaw(
    client,
    reasoner.model,
    messages,
    { ...reasoner.defaults, maxTokens: REASON_TOKENS[opts.effort] },
    opts.onThink,
  )
  const conclusion = stripThinkBlocks(reasoning) || reasoning.trim()

  // Phase 2 (high / xhigh) — overlookers critique the plan before acting.
  // xhigh always includes gemma; high includes it only if VIBE_REVIEW_GEMMA=1.
  const review =
    opts.effort === 'high' || opts.effort === 'xhigh'
      ? await overlook(client, recent, conclusion, opts.effort === 'xhigh', opts.onThink)
      : ''

  // Phase 3 — qwen extracts the structured action (streamed to the answer area).
  const extracted = await streamVisible(
    client,
    extractor.model,
    [
      {
        role: 'system',
        content: `${systemPrompt}\n\n---\nYou are the extraction step. Convert the reasoning below into the next action using the tools and exact argument names defined above. Emit exactly one tool-call JSON object, or a concise final answer if no tool is needed. Output no hidden reasoning.`,
      },
      {
        role: 'user',
        content: `${recent}\n\nReasoning to act on:\n${conclusion}${review ? `\n\nReviewer notes to address:\n${review}` : ''}`,
      },
    ],
    extractor.defaults,
    opts.onToken,
    opts.onUsage,
  )

  return stripThinkBlocks(extracted)
}

/** No-reasoning path: qwen acts directly on the curated conversation. */
function directExtract(
  client: ChatClient,
  model: string,
  messages: ChatMessage[],
  opts: TwoPhaseOptions,
): Promise<string> {
  return streamVisible(client, model, messages, getModelProfile('extractor').defaults, opts.onToken, opts.onUsage).then(
    stripThinkBlocks,
  )
}

/** Quick qwen classification: does this request need step-by-step reasoning? */
async function needsThinking(
  client: ChatClient,
  messages: ChatMessage[],
  onThink?: (text: string) => void,
): Promise<boolean> {
  const extractor = getModelProfile('extractor')
  const recent = renderRecent(messages.slice(1).slice(-RECENT_TAIL))
  try {
    const res = await client.chat(
      extractor.model,
      [
        {
          role: 'system',
          content:
            'Decide whether the latest coding request needs careful multi-step reasoning before acting (vs. a single obvious action). Reply with exactly YES or NO.',
        },
        { role: 'user', content: recent || (messages.at(-1)?.content ?? '') },
      ],
      { ...extractor.defaults, maxTokens: 8, temperature: 0 },
    )
    const yes = /\byes\b/i.test(stripThinkBlocks(res.content))
    onThink?.(yes ? '[dynamic] reasoning needed\n' : '[dynamic] acting directly\n')
    return yes
  } catch {
    return true // when unsure, prefer reasoning
  }
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
          { ...reviewer.defaults, maxTokens: 200 },
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
  options: Record<string, unknown>,
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
  options: Record<string, unknown>,
  onToken?: (text: string) => void,
  onUsage?: (usage: TurnUsage) => void,
): Promise<string> {
  if (onToken && client.chatStream) {
    const split = createThinkSplitter()
    const result = await client.chatStream(model, messages, options, delta => {
      const { visible } = split(delta)
      if (visible) onToken(visible)
    })
    onUsage?.({ completionTokens: result.usage.completionTokens, durationMs: result.usage.durationMs })
    return result.content
  }
  const result = await client.chat(model, messages, options)
  onUsage?.({ completionTokens: result.usage.completionTokens, durationMs: result.usage.durationMs })
  return result.content
}

function renderRecent(messages: ChatMessage[]): string {
  if (messages.length === 0) return '[no prior turns]'
  return ['Recent conversation:', ...messages.map(message => `${label(message)}: ${message.content}`)].join('\n')
}

function label(message: ChatMessage): string {
  return message.role === 'tool' && message.toolName ? `tool:${message.toolName}` : message.role
}
