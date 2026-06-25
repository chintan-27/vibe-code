import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App, QuestionPrompt, collapsePaste } from './app.tsx'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('TUI App', () => {
  // Bypass the workspace-trust gate for the main UI tests.
  beforeAll(() => {
    process.env.VIBE_TRUST_ALL = '1'
  })
  afterAll(() => {
    delete process.env.VIBE_TRUST_ALL
  })

  test('renders the status bar, model, and input prompt on mount', () => {
    const { lastFrame, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('qwen2.5-coder:7b')
    expect(frame).toContain('medium')
    expect(frame).toContain('quit')
    expect(frame).toContain('›')
    unmount()
  })

  test('keeps the idle frame within the terminal height', () => {
    const { lastFrame, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    const rows = (lastFrame() ?? '').split('\n').length
    expect(rows).toBeLessThanOrEqual(24)
    unmount()
  })

  test('echoes typed input', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50) // let mount effects + raw-mode setup settle
    stdin.write('hello there')
    await delay(50)
    expect(lastFrame() ?? '').toContain('hello there')
    unmount()
  })

  test('backspace (mac DEL 0x7f and BS 0x08) deletes the last character', async () => {
    for (const bs of ['\x7f', '\x08']) {
      const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
      await delay(50)
      stdin.write('abcd')
      await delay(30)
      stdin.write(bs)
      await delay(40)
      const frame = lastFrame() ?? ''
      expect(frame).toContain('abc')
      expect(frame).not.toContain('abcd')
      unmount()
    }
  })

  test('Ctrl+W deletes the previous word; Ctrl+U deletes to line start', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('foo bar')
    await delay(30)
    stdin.write('\x17') // Ctrl+W
    await delay(40)
    expect(lastFrame() ?? '').toContain('foo')
    expect(lastFrame() ?? '').not.toContain('bar')
    stdin.write('\x15') // Ctrl+U
    await delay(40)
    expect(lastFrame() ?? '').not.toContain('foo')
    unmount()
  })

  test('rapid pasted newlines stay in the buffer instead of submitting', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('first line')
    stdin.write('\r') // arrives immediately → treated as a pasted newline, not submit
    stdin.write('second line')
    await delay(50)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('first line')
    expect(frame).toContain('second line') // both retained → no premature submit
    unmount()
  })

  test('backslash then Enter inserts a manual newline', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('first line\\')
    await delay(80)
    stdin.write('\r')
    await delay(40)
    stdin.write('second line')
    await delay(50)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('first line')
    expect(frame).toContain('second line')
    expect(frame).not.toContain('first line\\')
    unmount()
  })

  test('/help prints command help', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('/help')
    await delay(80) // simulate a human pause before Enter (paste newlines arrive far faster)
    stdin.write('\r')
    await delay(50)
    expect(lastFrame() ?? '').toContain('Commands:')
    unmount()
  })

  test('slash input shows command suggestions', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('/')
    await delay(50)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Commands')
    expect(frame).toContain('/help')
    expect(frame).toContain('/init')
    unmount()
  })

  test('tab completes a slash command suggestion', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('/he')
    await delay(40)
    stdin.write('\t')
    await delay(50)
    expect(lastFrame() ?? '').toContain('/help')
    unmount()
  })

  test('/plan toggles read-only planning mode', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'medium', permissionMode: 'default' }} />)
    await delay(50)
    stdin.write('/plan')
    await delay(80)
    stdin.write('\r')
    await delay(50)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Plan mode enabled')
    expect(frame).toContain(' plan ')
    unmount()
  })
})

describe('collapsePaste', () => {
  test('collapses a big text paste, preserving the real content', () => {
    const store = new Map<string, string>()
    const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    const display = collapsePaste(big, store)
    expect(display).toMatch(/\[Pasted \d+ lines\]/)
    expect(store.get(display)).toBe(big)
  })

  test('leaves short inline text verbatim', () => {
    expect(collapsePaste('a short line', new Map())).toBe('a short line')
  })
})

describe('QuestionPrompt', () => {
  test('renders selectable options with a highlight and a custom-answer choice', () => {
    const { lastFrame } = render(
      <QuestionPrompt question="Which framework?" options={['React', 'Vue']} selected={1} typing={false} width={70} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Which framework?')
    expect(frame).toContain('React')
    expect(frame).toContain('Vue')
    expect(frame).toContain('Type my own answer')
    expect(frame).toContain('❯') // highlight marker on the selected option
  })

  test('typing mode shows the free-text hint instead of the list', () => {
    const { lastFrame } = render(
      <QuestionPrompt question="Name?" options={['A']} selected={1} typing width={70} />,
    )
    expect(lastFrame() ?? '').toContain('type your answer below')
  })
})

describe('TUI trust gate', () => {
  test('prompts for an untrusted folder and unlocks on y', async () => {
    delete process.env.VIBE_TRUST_ALL
    const cfg = await mkdtemp(join(tmpdir(), 'vibe-cfg-'))
    process.env.VIBE_CONFIG_DIR = cfg
    const ws = await mkdtemp(join(tmpdir(), 'vibe-untrusted-'))
    const { lastFrame, stdin, unmount } = render(
      <App options={{ workspaceRoot: ws, effort: 'medium', permissionMode: 'auto' }} />,
    )
    await delay(50)
    expect(lastFrame() ?? '').toContain('Do you trust')
    stdin.write('y')
    await delay(60)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('Do you trust')
    expect(frame).toContain('›') // main input is now shown
    unmount()
    delete process.env.VIBE_CONFIG_DIR
  })
})
