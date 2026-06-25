import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './system.ts'
import { coreTools } from '@/tools/registry.ts'

describe('buildSystemPrompt', () => {
  test('guards greenfield projects against generic Express/Node defaults', () => {
    const prompt = buildSystemPrompt(coreTools)

    expect(prompt).toContain('For greenfield/new-project requests')
    expect(prompt).toContain('Do not default to Express, Node.js')
    expect(prompt).toContain('Node.js is a runtime/tooling ecosystem')
    expect(prompt).toContain('do not create a backend just because')
    expect(prompt).toContain('do not use Task to hide implementation')
    expect(prompt).toContain('If the user specifies a frontend stack')
    expect(prompt).toContain('use TodoWrite')
    expect(prompt).toContain('Make generated apps actually runnable')
    expect(prompt).toContain('implement the real first-screen experience')
    expect(prompt).not.toContain('Plan mode:')
  })

  test('adds a specialized planning contract in plan mode', () => {
    const prompt = buildSystemPrompt(coreTools, { permissionMode: 'plan' })

    expect(prompt).toContain('Plan mode:')
    expect(prompt).toContain('read-only planning pass')
    expect(prompt).toContain('Current-state findings with concrete file paths')
    expect(prompt).toContain('Ordered implementation steps grouped by file/module')
    expect(prompt).toContain('Tests/verification commands to run')
    expect(prompt).toContain('For greenfield work')
  })
})
