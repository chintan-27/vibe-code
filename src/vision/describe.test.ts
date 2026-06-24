import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { readTool } from '@/tools/read.ts'
import { describeImage, isImagePath } from './describe.ts'

class VisionStub implements ChatClient {
  public lastImages: string[] | undefined
  public lastModel = ''
  async chat(model: string, messages: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    this.lastModel = model
    this.lastImages = messages[0]?.images
    return { model, content: 'A red button on a white page.', usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 } }
  }
}

describe('vision', () => {
  test('isImagePath detects image extensions', () => {
    expect(isImagePath('a/b/shot.PNG')).toBe(true)
    expect(isImagePath('notes.md')).toBe(false)
  })

  test('describeImage sends the file as base64 to the vision model', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-vision-'))
    const file = join(ws, 'img.png')
    await writeFile(file, Buffer.from([1, 2, 3, 4]))
    const stub = new VisionStub()
    const text = await describeImage(stub, file)
    expect(text).toContain('red button')
    expect(stub.lastModel).toBe('gemma3:4b')
    expect(stub.lastImages?.[0]).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'))
  })

  test('Read routes image files through the vision model', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-vision-'))
    await writeFile(join(ws, 'ui.png'), Buffer.from([9, 9, 9]))
    const result = await readTool.execute({ file_path: 'ui.png' }, { workspaceRoot: ws, client: new VisionStub() })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('[image: ui.png]')
    expect(result.content).toContain('red button')
  })
})
