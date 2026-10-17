import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { generateDemoTranscript, runTuiDemo } from '../../src/ui/demo.ts'
import { stripAnsi } from '../../src/tui/width.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'

describe('Demo Mode (Phase 12)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('generates demo transcript with user prompt, tool group, progress telemetry, diff, and result card', () => {
    const lines = generateDemoTranscript(100, theme)
    expect(lines.length).toBeGreaterThan(15)

    const fullText = lines.map((l) => stripAnsi(l)).join('\n')
    // 1. User message
    expect(fullText).toContain('What happened in my last failed build?')

    // 2. Tool group (3 shell commands)
    expect(fullText).toMatch(/Run 3 shell commands/)

    // 3. Progress steps
    expect(fullText).toContain('Reading the failed test output')
    expect(fullText).toContain('src/validators/currency.js')

    // 4. Result card
    expect(fullText).toContain('Currency validator')
    expect(fullText).toContain('Build and lint passed')
    expect(fullText).toContain('Tests failed')

    // 5. Diff block
    expect(fullText).toContain('- if (amount < 0) {')
    expect(fullText).toContain('+ if (amount <= 0) {')

    // 6. Completion duration
    expect(fullText).toContain('Completed in 46s')
  })

  it('runs interactive demo on ScriptedIo without executing real shell commands or filesystem mutations', async () => {
    const io = new ScriptedIo()
    io.columns = 129
    io.rows = 48

    // Trigger interrupt or exit to finish demo loop
    setTimeout(() => {
      io.press('escape')
    }, 20)

    await runTuiDemo(io, theme)

    expect(io.frames.length).toBeGreaterThan(0)
    const lastFrame = io.frames[io.frames.length - 1]!
    expect(lastFrame.lines.length).toBe(48)

    const plain = stripAnsi(lastFrame.lines.join('\n'))
    expect(plain).toContain('PLUTON')
    expect(plain).toContain('What happened in my last failed build?')
    expect(plain).toContain('Run 3 shell commands')
    expect(plain).toContain('Currency validator')
  })
})
