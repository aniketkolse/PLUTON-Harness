import { describe, expect, it } from 'vitest'
import { getUITheme, PALETTE } from '../../src/ui/theme.ts'
import { generateDemoTranscript } from '../../src/ui/demo.ts'
import { renderFullScreenFrame } from '../../src/tui/render.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'
import { computeLayout } from '../../src/tui/layout.ts'
import { renderActionableApprovalCard } from '../../src/ui/approval.ts'

describe('Visual Acceptance & Layout Verification (Phase 13)', () => {
  const truecolorTheme = getUITheme({ colorLevel: 'truecolor', unicode: true })
  const asciiTheme = getUITheme({ colorLevel: 'none', unicode: false })

  it('renders standard 129x48 terminal layout with all 10 visual criteria satisfied', () => {
    const columns = 129
    const rows = 48

    const transcript = generateDemoTranscript(columns - 36, truecolorTheme)

    const frame = renderFullScreenFrame({
      header: {
        projectName: 'pluton-harness',
        rootDir: 'Y:/Pluton',
        museSlug: 'captain',
        engine: 'opencode',
        model: 'opencode/deepseek-v4',
        version: '0.1.0',
      },
      orchestra: {
        muses: [
          {
            id: 'captain',
            slug: 'captain',
            role: 'supervisor',
            engine: 'opencode',
            model: 'deepseek-v4',
            state: 'idle',
          },
          {
            id: 'coder',
            slug: 'coder',
            role: 'coder',
            engine: 'opencode',
            model: 'qwen-coder-32b',
            state: 'idle',
          },
        ],
        tasks: [],
        approvals: [],
        events: [],
      },
      transcriptLines: transcript,
      editor: { text: '', cursor: 0 },
      statusView: {
        museSlug: 'captain',
        engine: 'opencode',
        model: 'opencode/deepseek-v4',
        busy: false,
        run: null,
        approvalsPending: 0,
        usage: { inputTokens: 4200, outputTokens: 850 },
      },
      placeholder: 'Ask Pluton to plan, implement, investigate…',
      museCount: 2,
      columns,
      rows,
      theme: truecolorTheme,
      brandHeader: true,
      inspectorOpen: true,
      mode: 'chat',
      contextPct: 42,
      cost: 0.04,
    })

    // Criterion 1: Screen dimensions
    expect(frame.lines.length).toBe(rows)
    for (let r = 0; r < rows; r++) {
      expect(displayWidth(frame.lines[r]!)).toBeLessThanOrEqual(columns)
    }

    const screenBuffer = frame.lines.map((l) => stripAnsi(l)).join('\n')

    // Criterion 2: Branding (ship silhouette, skull flag, PLUTON wordmark)
    expect(screenBuffer).toContain('PLUTON')
    expect(screenBuffer).toMatch(/☠|X/)
    expect(screenBuffer).toMatch(/█▀█|___/)

    // Criterion 3: Header metadata (version, agentic coding harness, project path)
    expect(screenBuffer).toContain('v0.1.0')
    expect(screenBuffer).toContain('Agentic Coding Harness')
    expect(screenBuffer).toContain('Y:/Pluton')

    // Criterion 4: Conversation hierarchy (User message)
    expect(screenBuffer).toContain('What happened in my last failed build?')

    // Criterion 5: Tool Activity (grouped commands)
    expect(screenBuffer).toMatch(/Run 3 shell commands/)

    // Criterion 6: Progress telemetry (icons & indented telemetry)
    expect(screenBuffer).toContain('Reading the failed test output')
    expect(screenBuffer).toContain('src/validators/currency.js')

    // Criterion 7: Result Card (checklist & diff block)
    expect(screenBuffer).toContain('Currency validator')
    expect(screenBuffer).toContain('Build and lint passed')
    expect(screenBuffer).toContain('Tests failed')
    expect(screenBuffer).toContain('- if (amount < 0) {')
    expect(screenBuffer).toContain('+ if (amount <= 0) {')
    expect(screenBuffer).toContain('Completed in 46s')

    // Criterion 8: Docked Input Box
    expect(screenBuffer).toContain('Ask Pluton to plan, implement, investigate…')

    // Criterion 9: Live Status Bar
    expect(screenBuffer).toContain('● Ready')
    expect(screenBuffer).toContain('Mode: chat')
    expect(screenBuffer).toContain('Context: 42%')
    expect(screenBuffer).toContain('$0.04')
    expect(screenBuffer).toContain('/help')

    // Criterion 10: Orchestra Inspector side-panel
    expect(screenBuffer).toContain('ORCHESTRA')
    expect(screenBuffer).toContain('captain')
    expect(screenBuffer).toContain('coder')
  })

  it('handles narrow terminals (< 80 columns) with compact header and collapsed inspector', () => {
    const layout = computeLayout(72, 30, { brandHeader: true })
    expect(layout.twoColumn).toBe(false)
    expect(layout.inspector).toBeNull()
    expect(layout.header.height).toBe(1)
  })

  it('handles short terminals (< 24 rows) with compact layout', () => {
    const layout = computeLayout(120, 20, { brandHeader: true })
    expect(layout.header.height).toBe(1)
  })

  it('deduplicates approval notifications to a single actionable card', () => {
    const cardLines = renderActionableApprovalCard(
      {
        id: 'req-99',
        action: 'Execute shell command',
        reason: 'npm test',
      },
      70,
      truecolorTheme,
    )

    expect(cardLines.length).toBe(4)
    const text = cardLines.map((l) => stripAnsi(l)).join('\n')
    expect(text).toContain('Approval required: Execute shell command')
    expect(text).toContain('[A] Approve once')
  })
})
