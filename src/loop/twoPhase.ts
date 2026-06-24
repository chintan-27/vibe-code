import { getModelProfile } from '@/provider/models.ts'
import type { ChatMessage } from '@/provider/types.ts'
import { createThinkSplitter, stripThinkBlocks } from '@/toolcall/parse.ts'
import type { ChatClient, EffortMode, TurnUsage } from './types.ts'

const RECENT_TAIL = 6

// How long VibeThinker is allowed to reason, by effort.
const REASON_TOKENS: Record<EffortMode, number> = { normal: 640, medium: 1536, high: 3072 }

export type TwoPhaseOptions = {
  effort: EffortMode
  onThink?: (text: string) => void
  onToken?: (text: string) => void
  onUsage?: (usage: TurnUsage) => void
}

/**
 * One turn of the agent's thinking. VibeThinker (the reasoner) always decides;
 * qwen (the extractor) always turns that decision into a structured action. In
 * `high` effort, qwen + gemma review VibeThinker's plan first ("overlookers").
 * Reasoning streams to the thinking panel; the extracted action streams to the
 * answer area.
 */
export async function runTwoPhaseStep(
  client: ChatClient,
  messages: ChatMessage[],
  opts: TwoPhaseOptions,
): Promise<string> {
  const reasoner = getModelProfile('reasoner')
  const extractor = getModelProfile('extractor')
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

  // Phase 2 (high only) — overlookers critique the plan before acting.
  const review = opts.effort === 'high' ? await overlook(client, recent, conclusion, opts.onThink) : ''

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

/** qwen + gemma each critique the plan; non-OK notes are returned for the extractor. */
async function overlook(
  client: ChatClient,
  recent: string,
  conclusion: string,
  onThink?: (text: string) => void,
): Promise<string> {
  const reviewers = [getModelProfile('extractor'), getModelProfile('vision')]
  const notes: string[] = []
  for (const reviewer of reviewers) {
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
        { ...reviewer.defaults, maxTokens: 256 },
      )
      const note = stripThinkBlocks(res.content).trim()
      onThink?.(`\n[review · ${reviewer.role}] ${note}\n`)
      if (note && !/^ok\b/i.test(note)) notes.push(`[${reviewer.role}] ${note}`)
    } catch {
      // A missing/unavailable reviewer model must not break the turn.
    }
  }
  return notes.join('\n')
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
