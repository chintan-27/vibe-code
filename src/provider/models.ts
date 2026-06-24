import type { ChatOptions } from './types.ts'

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
      numCtx: 32768,
    },
  },
  extractor: {
    role: 'extractor',
    model: 'qwen2.5-coder:7b',
    description: 'Low-temperature extraction and repair model.',
    defaults: {
      temperature: 0,
      maxTokens: 768,
      numCtx: 8192,
    },
  },
  reasoner: {
    role: 'reasoner',
    model: 'NitrAI/VibeThinker-3B:latest',
    description: 'Slow free-form reasoning model.',
    defaults: {
      temperature: 0.6,
      maxTokens: 2048,
      numCtx: 32768,
    },
  },
  vision: {
    role: 'vision',
    model: 'gemma3:4b',
    description: 'Multimodal model for describing images (run `ollama pull gemma3:4b`).',
    defaults: {
      temperature: 0.2,
      maxTokens: 1024,
      numCtx: 8192,
    },
  },
} satisfies Record<ModelRole, ModelProfile>

export function getModelProfile(role: ModelRole): ModelProfile {
  return modelProfiles[role]
}

