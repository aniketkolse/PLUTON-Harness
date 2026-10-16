import { describe, expect, it } from 'vitest'
import { createTheme, type Theme } from '../../src/tui/theme.ts'
import {
  renderHeader,
  renderInput,
  renderNotice,
  renderStatusLine,
  renderToolLine,
  type StatusView,
} from '../../src/tui/render.ts'
import { displayWidth, stripAnsi } from '../../src/tui/width.ts'

describe('createTheme', () => {
  it('returns identity paint when color is disabled', () => {
    const theme = createTheme({ color: false })
    expect(theme.enabled).toBe(false)
    expect(theme.paint('accent', 'hello')).toBe('hello')
    expect(theme.paint('error', 'fail')).toBe('fail')
    expect(theme.paint('warn', 'warning')).toBe('warning')
    expect(theme.paint('tool', 'toolCall')).toBe('toolCall')
    expect(theme.paint('user', 'input')).toBe('input')
  })

  it('wraps text in ANSI escape codes when color is enabled', () => {
    const theme = createTheme({ color: true })
    expect(theme.enabled).toBe(true)
    const painted = theme.paint('error', 'fail')
    expect(painted).not.toBe('fail')
    expect(painted).toContain('fail')
    expect(stripAnsi(painted)).toBe('fail')
  })

  it('respects NO_COLOR environment variable when color is not explicitly passed', () => {
    const origNoColor = process.env['NO_COLOR']
    try {
      process.env['NO_COLOR'] = '1'
      const theme = createTheme({})
      expect(theme.enabled).toBe(false)
    } finally {
      if (origNoColor === undefined) {
        delete process.env['NO_COLOR']
      } else {
        process.env['NO_COLOR'] = origNoColor
      }
    }
  })
})

describe('renderStatusLine', () => {
  const plain = createTheme({ color: false })

  it('contains muse, engine, model, and state', () => {
    const view: StatusView = {
      museSlug: 'operator',
      engine: 'opencode',
      model: 'anthropic/claude-3-5-sonnet',
      busy: false,
      run: null,
      approvalsPending: 0,
      usage: null,
    }
    const line = renderStatusLine(view, 80, plain)
    expect(line).toContain('operator')
    expect(line).toContain('opencode')
    expect(line).toContain('anthropic/claude-3-5-sonnet')
    expect(displayWidth(line)).toBeLessThanOrEqual(80)
  })

  it('renders busy indicator, active run, pending approvals, and usage tokens', () => {
    const view: StatusView = {
      museSlug: 'operator',
      engine: 'mock',
      model: 'mock-1',
      busy: true,
      run: { id: 'run_12345678', state: 'running' },
      approvalsPending: 2,
      usage: { inputTokens: 1200, outputTokens: 350 },
    }
    const line = renderStatusLine(view, 100, plain)
    expect(line).toContain('busy')
    expect(line).toContain('run_12345678')
    expect(line).toContain('2 approvals')
    expect(line).toContain('1200')
    expect(line).toContain('350')
  })

  it('truncates gracefully with ellipsis when terminal width is narrow', () => {
    const view: StatusView = {
      museSlug: 'operator-long-name',
      engine: 'opencode',
      model: 'anthropic/claude-3-5-sonnet-20241022',
      busy: true,
      run: { id: 'run_12345678', state: 'running' },
      approvalsPending: 1,
      usage: { inputTokens: 5000, outputTokens: 2000 },
    }
    const line = renderStatusLine(view, 30, plain)
    expect(displayWidth(line)).toBeLessThanOrEqual(30)
  })
})

describe('renderInput', () => {
  const plain = createTheme({ color: false })
  const opts = { prompt: '> ' } // width 2

  it('renders a single-line input with cursor at start, middle, and end', () => {
    const text = 'hello'
    // cursor at 0
    const at0 = renderInput(text, 0, 40, plain, opts)
    expect(at0.lines).toEqual(['> hello'])
    expect(at0.cursor).toEqual({ row: 0, col: 2 })

    // cursor at 2 ('he|llo')
    const at2 = renderInput(text, 2, 40, plain, opts)
    expect(at2.lines).toEqual(['> hello'])
    expect(at2.cursor).toEqual({ row: 0, col: 4 })

    // cursor at 5 ('hello|')
    const at5 = renderInput(text, 5, 40, plain, opts)
    expect(at5.lines).toEqual(['> hello'])
    expect(at5.cursor).toEqual({ row: 0, col: 7 })
  })

  it('handles multi-line input and computes row/col relative to the block', () => {
    const text = 'line 1\nline 2 is here'
    // Cursor at 'line 2 is |here' (index 7 + 10 = 17)
    // 'line 1\n' has length 7.
    // 'line 2 is ' has length 10.
    const rendered = renderInput(text, 17, 40, plain, opts)
    expect(rendered.lines).toEqual(['> line 1', '  line 2 is here'])
    expect(rendered.cursor).toEqual({ row: 1, col: 12 }) // 2 (prompt/indent) + 10 = 12
  })

  it('wraps long lines and positions cursor accurately within the wrapped block', () => {
    // Width 10: prompt '> ' takes 2, leaving 8 for text
    const text = 'abcdefghijklm'
    // cursor at end (13)
    const rendered = renderInput(text, 13, 10, plain, opts)
    expect(rendered.lines.length).toBeGreaterThan(1)
    for (const l of rendered.lines) {
      expect(displayWidth(l)).toBeLessThanOrEqual(10)
    }
    expect(rendered.cursor.row).toBe(rendered.lines.length - 1)
  })
})

describe('renderToolLine', () => {
  const plain = createTheme({ color: false })

  it('suppresses start phase when collapsed (opts.expanded = false)', () => {
    const line = renderToolLine(
      { name: 'project.status', phase: 'start' },
      { expanded: false },
      80,
      plain,
    )
    expect(line).toBeNull()
  })

  it('renders start phase when expanded (opts.expanded = true)', () => {
    const line = renderToolLine(
      { name: 'project.status', phase: 'start' },
      { expanded: true },
      80,
      plain,
    )
    expect(line).not.toBeNull()
    expect(line).toContain('project.status')
  })

  it('renders end phase with summary and success icon', () => {
    const line = renderToolLine(
      { name: 'run.list', phase: 'end', summary: '3 runs active' },
      { expanded: false },
      80,
      plain,
    )
    expect(line).not.toBeNull()
    expect(line).toContain('run.list')
    expect(line).toContain('3 runs active')
  })

  it('renders end phase with error indication when isError is true', () => {
    const line = renderToolLine(
      { name: 'run.start', phase: 'end', summary: 'permission denied', isError: true },
      { expanded: false },
      80,
      plain,
    )
    expect(line).not.toBeNull()
    expect(line).toContain('run.start')
    expect(line).toContain('permission denied')
  })
})

describe('renderHeader', () => {
  const plain = createTheme({ color: false })

  it('includes project, muse, engine, model, and session information', () => {
    const header = renderHeader(
      {
        projectName: 'my-project',
        rootDir: '/workspace/my-project',
        museSlug: 'operator',
        engine: 'opencode',
        model: 'anthropic/claude-3-5-sonnet',
        mode: 'container',
        sessionId: 'chat_12345678',
        resumed: true,
        messageCount: 14,
      },
      plain,
    )
    expect(header).toContain('my-project')
    expect(header).toContain('operator')
    expect(header).toContain('opencode')
    expect(header).toContain('anthropic/claude-3-5-sonnet')
    expect(header).toContain('chat_12345678')
    expect(header).toContain('resumed')
    expect(header).toContain('14 messages')
  })
})

describe('renderNotice', () => {
  const plain = createTheme({ color: false })

  it('formats notice text and stays within width bounds', () => {
    const notice = renderNotice('Run run_abc completed successfully', 40, plain)
    expect(notice).toContain('Run run_abc completed successfully')
    expect(displayWidth(notice)).toBeLessThanOrEqual(40)
  })
})
