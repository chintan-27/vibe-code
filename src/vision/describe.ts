import { readFile } from 'fs/promises'
import { getModelProfile } from '@/provider/models.ts'
import type { ChatClient } from '@/provider/types.ts'
import { stripThinkBlocks } from '@/toolcall/parse.ts'

const DEFAULT_PROMPT =
  'Describe this image for a software developer. Capture any visible text verbatim, the UI/layout structure, colors, and notable elements, so the description alone is enough to act on.'

/** Send an image to the vision model and return a text description. */
export async function describeImage(client: ChatClient, absolutePath: string, question?: string): Promise<string> {
  const base64 = (await readFile(absolutePath)).toString('base64')
  const profile = getModelProfile('vision')
  const result = await client.chat(
    profile.model,
    [{ role: 'user', content: question ?? DEFAULT_PROMPT, images: [base64] }],
    profile.defaults,
  )
  return stripThinkBlocks(result.content).trim()
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase())
}
