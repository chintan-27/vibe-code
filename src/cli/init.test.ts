import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import type { ChatClient, ChatMessage, ChatOptions, ChatResult } from '@/provider/types.ts'
import { initializeProject, limitVibeGuide, MAX_VIBE_GUIDE_CHARS, renderProjectSnapshot } from './init.ts'

class CapturingClient implements ChatClient {
  messages: ChatMessage[] = []

  async chat(model: string, messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResult> {
    this.messages = messages
    return {
      model,
      content: '# Static Page\n\nOpen `index.html` in a browser.\n',
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 1 },
    }
  }
}

describe('init project snapshot', () => {
  test('caps an oversized generated guide at a section boundary', () => {
    const guide = `# Overview\n${'a'.repeat(MAX_VIBE_GUIDE_CHARS)}\n## Architecture\n${'b'.repeat(500)}`
    const limited = limitVibeGuide(guide)

    expect(limited.length).toBeLessThan(MAX_VIBE_GUIDE_CHARS + 100)
    expect(limited).toContain('Guide truncated by vibe init')
  })

  test('includes static HTML evidence and does not invent package scripts', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-init-static-'))
    await writeFile(join(ws, 'index.html'), '<!doctype html><title>Testing Grounds</title>', 'utf8')

    const snapshot = await renderProjectSnapshot(ws)
    expect(snapshot).toContain('- index.html')
    expect(snapshot).toContain('## index.html')
    expect(snapshot).toContain('Static web entrypoint')
    expect(snapshot).toContain('run: open index.html in a browser')
  })

  test('init prompt forbids invented Express/npm details for static repos', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-init-prompt-'))
    await mkdir(join(ws, 'assets'))
    await writeFile(join(ws, 'index.html'), '<h1>Static</h1>', 'utf8')
    const client = new CapturingClient()
    const stages: string[] = []

    await initializeProject(ws, client, { onProgress: progress => stages.push(progress.stage) })
    const prompt = client.messages.map(message => message.content).join('\n')
    expect(prompt).toContain('index.html')
    expect(prompt).toContain('Detected project facts')
    expect(prompt).toContain('Use the "Detected project facts" and "Proven commands" sections')
    expect(prompt).toContain('Repository structure')
    expect(prompt).toContain('Coding style and conventions')
    expect(prompt).toContain('Do not mention frameworks, package managers')
    expect(prompt).toContain('Do not draw an ASCII tree')
    expect(await readFile(join(ws, 'VIBE.md'), 'utf8')).toContain('Static Page')
    expect(stages).toContain('scan')
    expect(stages).toContain('model')
    expect(stages.at(-1)).toBe('done')
  })

  test('captures Rust/Cargo structure and source snippets for richer VIBE.md output', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-init-rust-'))
    await mkdir(join(ws, 'src'))
    await writeFile(
      join(ws, 'Cargo.toml'),
      '[package]\nname = "harmonium-in-mac"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\neframe = "0.27"\nserde = { version = "1", features = ["derive"] }\n',
      'utf8',
    )
    await writeFile(join(ws, 'src', 'main.rs'), 'mod app;\nfn main() { app::run(); }\n', 'utf8')
    await writeFile(join(ws, 'src', 'app.rs'), 'pub fn run() {}\n', 'utf8')

    const snapshot = await renderProjectSnapshot(ws)
    expect(snapshot).toContain('- Cargo.toml')
    expect(snapshot).toContain('- src/main.rs')
    expect(snapshot).toContain('Rust/Cargo project: Cargo.toml present')
    expect(snapshot).toContain('Cargo name = "harmonium-in-mac"')
    expect(snapshot).toContain('## src/main.rs')
    expect(snapshot).toContain('build: cargo build')
    expect(snapshot).toContain('run: cargo run')
    expect(snapshot).toContain('test: cargo test')
  })

  test('detects non-Rust project facts dynamically', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'vibe-init-node-'))
    await writeFile(
      join(ws, 'package.json'),
      JSON.stringify({ name: 'web-tool', scripts: { dev: 'vite', test: 'vitest run' } }, null, 2),
      'utf8',
    )
    await writeFile(join(ws, 'index.html'), '<div id="root"></div>', 'utf8')

    const snapshot = await renderProjectSnapshot(ws)
    expect(snapshot).toContain('Node/JavaScript project: package.json present')
    expect(snapshot).toContain('package name: web-tool')
    expect(snapshot).toContain('dev: npm run dev')
    expect(snapshot).toContain('test: npm run test')
  })
})
