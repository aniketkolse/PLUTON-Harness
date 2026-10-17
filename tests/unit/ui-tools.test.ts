import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { renderToolGroup, renderStep, type ToolGroupData, type StepData } from '../../src/ui/tools.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'

describe('ToolGroup & Progress Telemetry Steps (Phase 4.3 & 4.4)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders ToolGroup with accurate count and rule extending to margin', () => {
    const group: ToolGroupData = {
      id: 'tg-1',
      running: false,
      tools: [
        { id: '1', name: 'shell', command: 'npm test', status: 'succeeded' },
        { id: '2', name: 'shell', command: 'git diff', status: 'succeeded' },
        { id: '3', name: 'shell', command: 'git status', status: 'succeeded' },
      ],
    }

    const lines = renderToolGroup(group, 60, theme)
    expect(lines.length).toBeGreaterThanOrEqual(1)

    const header = stripAnsi(lines[0]!)
    expect(header).toMatch(/Run 3 shell commands/)
    expect(header).toMatch(/┆|\|/)
    expect(displayWidth(header)).toBe(60)
  })

  it('labels mixed tool calls accurately', () => {
    const group: ToolGroupData = {
      id: 'tg-2',
      running: true,
      tools: [
        { id: '1', name: 'shell', status: 'succeeded' },
        { id: '2', name: 'file_read', status: 'running' },
      ],
    }

    const lines = renderToolGroup(group, 50, theme)
    const header = stripAnsi(lines[0]!)
    expect(header).toMatch(/2 tool calls/)
  })

  it('renders Step with colored indicator and indented telemetry', () => {
    const step: StepData = {
      title: 'Reading the failed test output',
      status: 'active',
      telemetry: {
        run: 'abc123',
        status: 'running',
        workflow: 'ci',
      },
    }

    const lines = renderStep(step, 80, theme)
    expect(lines.length).toBe(2)

    const titleLine = stripAnsi(lines[0]!)
    expect(titleLine).toContain('●')
    expect(titleLine).toContain('Reading the failed test output')

    const telemetryLine = stripAnsi(lines[1]!)
    expect(telemetryLine).toMatch(/↳|>/)
    expect(telemetryLine).toContain('run: abc123')
    expect(telemetryLine).toContain('status: running')
    expect(telemetryLine).toContain('workflow: ci')
  })

  it('omits empty or undefined telemetry fields', () => {
    const step: StepData = {
      title: 'Running unit tests',
      status: 'success',
      telemetry: {
        command: 'npm test',
        optionalField: undefined,
      },
    }

    const lines = renderStep(step, 80, theme)
    const telemetryLine = stripAnsi(lines[1]!)
    expect(telemetryLine).toContain('command: npm test')
    expect(telemetryLine).not.toContain('optionalField')
  })
})
