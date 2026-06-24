import { readFile } from 'fs/promises'
import { isAbsolute } from 'path'
import { z } from 'zod'
import { describeImage, isImagePath } from '@/vision/describe.ts'
import { resolveWorkspacePath } from './path.ts'
import type { ToolDef } from './types.ts'

const MAX_READ_CHARS = 80_000

export const readTool = {
  name: 'Read',
  description: 'Read a file by path (absolute paths allowed, e.g. a screenshot in /tmp). Text files return their content; image files (png/jpg/…) return a vision-model description.',
  // Gated like a mutating tool: Read can open any absolute path, so it asks for
  // permission unless the user has allowed it (allow-always / settings / auto mode).
  readOnly: false,
  schema: z.object({
    file_path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  async execute(input, context) {
    // Read is read-only, so absolute paths (dragged screenshots, /tmp files) are allowed;
    // relative paths stay workspace-guarded. Un-escape "\ " that terminals insert on drag.
    const requested = input.file_path.replace(/\\ /g, ' ')
    const filePath = isAbsolute(requested) ? requested : resolveWorkspacePath(context.workspaceRoot, requested)

    if (isImagePath(filePath)) {
      if (!context.client) return { ok: false, content: 'Cannot read an image without a model client.' }
      const description = await describeImage(context.client, filePath)
      return { ok: true, content: `[image: ${input.file_path}]\n${description}` }
    }

    if (filePath.toLowerCase().endsWith('.pdf')) {
      return readPdf(filePath, input.file_path)
    }

    const text = await readFile(filePath, 'utf8')
    const lines = text.split(/\r?\n/)
    const start = input.offset ? input.offset - 1 : 0
    const end = input.limit ? start + input.limit : lines.length
    const selected = lines.slice(start, end)
    const numbered = selected.map((line, index) => `${start + index + 1}\t${line}`).join('\n')
    return {
      ok: true,
      content: numbered.length > MAX_READ_CHARS ? `${numbered.slice(0, MAX_READ_CHARS)}\n[truncated]` : numbered,
    }
  },
} satisfies ToolDef

/** Extract text from a PDF. Scanned/image-only PDFs yield little text (use vision later). */
async function readPdf(absolutePath: string, displayPath: string): Promise<{ ok: boolean; content: string }> {
  try {
    const { getDocumentProxy, extractText } = await import('unpdf')
    const bytes = new Uint8Array(await readFile(absolutePath))
    const pdf = await getDocumentProxy(bytes)
    const { text, totalPages } = await extractText(pdf, { mergePages: true })
    const body = Array.isArray(text) ? text.join('\n\n') : text
    const clamped = body.length > MAX_READ_CHARS ? `${body.slice(0, MAX_READ_CHARS)}\n[truncated]` : body
    return { ok: true, content: `[pdf: ${displayPath}, ${totalPages} pages]\n${clamped || '(no extractable text — may be scanned)'}` }
  } catch (error) {
    return { ok: false, content: `failed to read PDF: ${error instanceof Error ? error.message : String(error)}` }
  }
}

