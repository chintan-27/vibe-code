import type { ChatOptions } from './types.ts'

const LARGE_TEXT_CONTEXT = readPositiveIntEnv('VIBE_NUM_CTX', 131_072)
const CODER_CONTEXT = readPositiveIntEnv('VIBE_CODER_NUM_CTX', LARGE_TEXT_CONTEXT)
const EXTRACTOR_CONTEXT = readPositiveIntEnv('VIBE_EXTRACTOR_NUM_CTX', LARGE_TEXT_CONTEXT)
const REASONER_CONTEXT = readPositiveIntEnv('VIBE_REASONER_NUM_CTX', LARGE_TEXT_CONTEXT)
const VISION_CONTEXT = readPositiveIntEnv('VIBE_VISION_NUM_CTX', 8_192)

export type ModelRole = 'coder' | 'reasoner' | 'extractor' | 'vision'

export type ModelProfile = {
  role: ModelRole
  model: string
  description: string
  defaults: Required<Pick<ChatOptions, 'temperature' | 'maxTokens' | 'numCtx'>>
}

export const modelProfiles = {
  coder: {
    role: 'coder',
    model: 'qwen2.5-coder:7b',
    description: 'Fast coding and structured-output model.',
    defaults: {
      temperature: 0.2,
      // Large enough to write a full file in one Write call without truncation.
      maxTokens: 8192,
      // Wide window so the curated context can hold several files at once.
      numCtx: CODER_CONTEXT,
    },
  },
  extractor: {
    role: 'extractor',
    model: 'qwen2.5-coder:7b',
    description: 'Low-temperature extraction and repair model.',
    defaults: {
      temperature: 0,
      // Tool-call JSON can contain full-file Write payloads, so extraction needs
      // the same completion room as the direct coder path.
      maxTokens: 8192,
      numCtx: EXTRACTOR_CONTEXT,
    },
  },
  reasoner: {
    role: 'reasoner',
    model: 'NitrAI/VibeThinker-3B:latest',
    description: 'Slow free-form reasoning model.',
    defaults: {
      temperature: 0.6,
      maxTokens: 2048,
      numCtx: REASONER_CONTEXT,
    },
  },
  vision: {
    role: 'vision',
    model: 'gemma3:4b',
    description: 'Multimodal model for describing images (run `ollama pull gemma3:4b`).',
    defaults: {
      temperature: 0.2,
      maxTokens: 1024,
      numCtx: VISION_CONTEXT,
    },
  },
} satisfies Record<ModelRole, ModelProfile>

export function getModelProfile(role: ModelRole): ModelProfile {
  return modelProfiles[role]
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
