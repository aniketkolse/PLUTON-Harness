import { describe, expect, it } from 'vitest'
import { renderFullScreenFrame } from '../../src/tui/render.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { displayWidth, stripAnsi } from '../../src/tui/width.ts'

describe('renderFullScreenFrame', () => {
  const plain = createTheme({ color: false })
  const colored = createTheme({ color: true })

  it('renders exact number of lines matching rows', () => {
    const frame = renderFullScreenFrame({
      header: {
        projectName: 'demo-project',
        rootDir: '/home/user/demo',
        museSlug: 'manager',
        engine: 'opencode',
        model: 'claude-3-5-sonnet',
        runState: 'ready',
      },
      transcriptLines: ['Hello operator!', 'How can I help you today?'],
      editor: { text: '', cursor: 0 },
      statusView: {
        museSlug: 'manager',
        engine: 'opencode',
        model: 'claude-3-5-sonnet',
        busy: false,
        run: null,
        approvalsPending: 0,
        usage: null,
      },
      columns: 120,
      rows: 30,
      theme: plain,
    })

    expect(frame.lines.length).toBe(30)
    for (const l of frame.lines) {
      expect(displayWidth(l)).toBeLessThanOrEqual(120)
    }
    // Cursor parked within composer area
    expect(frame.cursor.row).toBeGreaterThanOrEqual(20)
    expect(frame.cursor.row).toBeLessThan(30)
  })

  it('renders two columns on wide terminal with Orchestra panel', () => {
    const frame = renderFullScreenFrame({
      header: {
        projectName: 'demo-project',
        rootDir: '/home/user/demo',
        museSlug: 'manager',
        engine: 'opencode',
        model: 'claude-3-5-sonnet',
      },
      transcriptLines: ['Turn 1', 'Turn 2'],
      orchestra: {
        muses: [
          {
            id: 'm1',
            slug: 'manager',
            role: 'supervisor',
            engine: 'opencode',
            model: 'claude-3-5',
            state: 'working',
          },
        ],
        tasks: [],
        approvals: [],
        events: [],
      },
      editor: { text: 'my draft', cursor: 8 },
      statusView: {
        museSlug: 'manager',
        engine: 'opencode',
        model: 'claude-3-5',
        busy: true,
        run: null,
        approvalsPending: 0,
        usage: null,
      },
      columns: 130,
      rows: 35,
      theme: plain,
      inspectorOpen: true,
    })

    expect(frame.lines.length).toBe(35)
    const text = frame.lines.join('\n')
    expect(text).toContain('ORCHESTRA')
    expect(text).toContain('manager')
    expect(text).toContain('my draft')
  })

  it('renders resize hint when terminal dimensions are too small', () => {
    const frame = renderFullScreenFrame({
      header: {
        projectName: 'demo',
        rootDir: '/demo',
        museSlug: 'm',
        engine: 'mock',
        model: 'm1',
      },
      transcriptLines: [],
      editor: { text: '', cursor: 0 },
      statusView: {
        museSlug: 'm',
        engine: 'mock',
        model: 'm1',
        busy: false,
        run: null,
        approvalsPending: 0,
        usage: null,
      },
      columns: 30,
      rows: 8,
      theme: plain,
    })

    expect(frame.lines.some((l) => l.includes('Terminal too small'))).toBe(true)
  })

  it('renders pirate ship brand header and live status bar when brandHeader is true', () => {
    const frame = renderFullScreenFrame({
      header: {
        projectName: 'pluton-harness',
        rootDir: 'Y:/Pluton',
        museSlug: 'captain',
        engine: 'opencode',
        model: 'claude-3-7-sonnet',
        version: '0.1.0',
      },
      transcriptLines: ['Welcome aboard!'],
      editor: { text: '', cursor: 0 },
      statusView: {
        museSlug: 'captain',
        engine: 'opencode',
        model: 'claude-3-7-sonnet',
        busy: false,
        run: null,
        approvalsPending: 0,
        usage: null,
      },
      columns: 129,
      rows: 48,
      theme: colored,
      brandHeader: true,
      mode: 'chat',
      contextPct: 42,
      cost: 0.04,
      museCount: 3,
    })

    expect(frame.lines.length).toBe(48)
    const text = frame.lines.join('\n')
    const plain = stripAnsi(text)
    expect(plain).toContain('PLUTON')
    expect(plain).toMatch(/☠|X/)
    expect(plain).toContain('v0.1.0')
    expect(plain).toContain('Context: 42%')
    expect(plain).toContain('/help')
  })
})
