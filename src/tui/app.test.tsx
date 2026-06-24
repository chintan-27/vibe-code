import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App } from './app.tsx'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('TUI App', () => {
  test('renders the status bar, model, and input prompt on mount', () => {
    const { lastFrame, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'normal', permissionMode: 'auto' }} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('qwen2.5-coder:7b')
    expect(frame).toContain('normal')
    expect(frame).toContain('quit')
    expect(frame).toContain('❯')
    unmount()
  })

  test('echoes typed input', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'normal', permissionMode: 'auto' }} />)
    await delay(50) // let mount effects + raw-mode setup settle
    stdin.write('hello there')
    await delay(50)
    expect(lastFrame() ?? '').toContain('hello there')
    unmount()
  })

  test('rapid pasted newlines stay in the buffer instead of submitting', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'normal', permissionMode: 'auto' }} />)
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

  test('/help prints command help', async () => {
    const { lastFrame, stdin, unmount } = render(<App options={{ workspaceRoot: tmpdir(), effort: 'normal', permissionMode: 'auto' }} />)
    await delay(50)
    stdin.write('/help')
    await delay(80) // simulate a human pause before Enter (paste newlines arrive far faster)
    stdin.write('\r')
    await delay(50)
    expect(lastFrame() ?? '').toContain('Commands:')
    unmount()
  })
})
