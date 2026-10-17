import { describe, expect, it } from 'vitest'
import {
  createToolActivity,
  updateToolActivity,
  renderToolActivity,
  type ToolActivityState,
} from '../../src/tui/activity.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('Tool Activity Component', () => {
  const plain = createTheme({ color: false })
  const colored = createTheme({ color: true })

  it('creates a running tool activity with start timestamp', () => {
    const act = createToolActivity({
      id: 'call_1',
      name: 'read_file',
      summary: 'Read package.json',
      input: { path: 'package.json' },
      startTime: 1000,
    })
    expect(act.id).toBe('call_1')
    expect(act.status).toBe('running')

    const rendered = renderToolActivity(act, false, 80, plain, 1500)
    expect(rendered.length).toBe(1)
    expect(rendered[0]).toContain('read_file')
    expect(rendered[0]).toContain('Read package.json')
    expect(rendered[0]).toContain('RUNNING')
  })

  it('updates tool activity on completion with duration and succeeded status', () => {
    const act = createToolActivity({
      id: 'call_1',
      name: 'read_file',
      summary: 'Read 4 files',
      startTime: 1000,
    })
    const done = updateToolActivity(act, {
      status: 'succeeded',
      output: 'Contents of 4 files...',
      endTime: 2200,
    })

    expect(done.status).toBe('succeeded')
    expect(done.durationMs).toBe(1200)

    const rendered = renderToolActivity(done, false, 80, plain)
    expect(rendered[0]).toContain('Read 4 files')
    expect(rendered[0]).toContain('1.2s')
    expect(rendered[0]).toContain('[v]') // check mark fallback
  })

  it('renders expanded details with input and sanitized output when expanded is true', () => {
    const act: ToolActivityState = {
      id: 'call_2',
      name: 'execute_command',
      summary: 'Run auth tests',
      status: 'failed',
      input: 'pnpm test auth',
      output: 'FAIL auth-expiry.test.ts\nExpected 200 got 401',
      startTime: 1000,
      endTime: 1800,
      durationMs: 800,
    }

    const rendered = renderToolActivity(act, true, 80, plain)
    expect(rendered.length).toBeGreaterThan(1)
    expect(rendered[0]).toContain('Run auth tests')
    expect(rendered[0]).toContain('FAILED')
    expect(rendered.some((l) => l.includes('FAIL auth-expiry.test.ts'))).toBe(true)
  })

  it('sanitizes untrusted ANSI control sequences in tool output', () => {
    const act: ToolActivityState = {
      id: 'call_3',
      name: 'danger',
      summary: 'Dangerous script',
      status: 'succeeded',
      output: 'Safe text \x1b[2J\x1b[H\x1b[?1049hMalicious alternate screen',
      startTime: 1000,
      endTime: 1100,
    }

    const rendered = renderToolActivity(act, true, 80, colored)
    const combined = rendered.join('\n')
    // Escape sequences like \x1b[?1049h or \x1b[2J must be removed
    expect(combined).not.toContain('\x1b[?1049h')
    expect(combined).not.toContain('\x1b[2J')
    expect(stripAnsi(combined)).toContain('Malicious alternate screen')
  })
})
