/**
 * Isolated deterministic demo mode (Phase 12).
 * Replays a realistic failed CI build scenario inspired by the reference screenshot.
 * Does not execute real shell commands, make network requests, or touch repository files.
 */

import type { UITheme } from './theme.ts'
import { renderUserMessage, renderAssistantMessage } from './messages.ts'
import { renderToolGroup, renderStep } from './tools.ts'
import { renderResultCard } from './cards.ts'
import { renderFullScreenFrame } from '../tui/render.ts'
import type { ChatIo } from '../tui/terminal.ts'

export function generateDemoTranscript(width: number, theme: UITheme): string[] {
  const contentWidth = Math.max(20, Math.min(width, 100))
  const lines: string[] = []

  // 1. User Message
  lines.push(...renderUserMessage('What happened in my last failed build?', contentWidth, theme))
  lines.push('')

  // 2. Tool Group (3 shell commands)
  lines.push(
    ...renderToolGroup(
      {
        id: 'demo-tg-1',
        running: false,
        tools: [
          { id: '1', name: 'shell', command: 'gh run list --limit 1', status: 'succeeded' },
          { id: '2', name: 'shell', command: 'gh run view 12345 --log-failed', status: 'succeeded' },
          { id: '3', name: 'shell', command: 'git diff HEAD~1', status: 'succeeded' },
        ],
      },
      contentWidth,
      theme,
    ),
  )
  lines.push('')

  // 3. Progress Telemetry Steps
  lines.push(
    ...renderStep(
      {
        title: 'Inspecting the latest failed CI workflow run',
        status: 'success',
        telemetry: { run: '12345', workflow: 'ci.yml', status: 'failed' },
      },
      contentWidth,
      theme,
    ),
  )
  lines.push(
    ...renderStep(
      {
        title: 'Extracting failed test logs from test job',
        status: 'success',
        telemetry: { job: 'test', exit: 1 },
      },
      contentWidth,
      theme,
    ),
  )
  lines.push(
    ...renderStep(
      {
        title: 'Reading the failed test output',
        status: 'success',
        telemetry: { file: 'src/validators/currency.js', test: 'rejects negative amount' },
      },
      contentWidth,
      theme,
    ),
  )
  lines.push('')

  // 4. Assistant Analysis
  lines.push(
    ...renderAssistantMessage(
      'The last CI run failed due to an assertion in `src/validators/currency.js`. The condition permitted zero and negative amounts because `<` was used instead of `<=`.',
      contentWidth,
      theme,
    ),
  )
  lines.push('')

  // 5. Result Card with Checklist & Diff
  lines.push(
    ...renderResultCard(
      {
        title: 'Latest run: 12345 "Currency validator" — failed (43s, CI)',
        status: 'failed',
        sections: [
          {
            type: 'checklist',
            items: [
              { text: 'Build and lint passed', status: 'pass' },
              { text: 'Tests failed (1 failed, 42 passed)', status: 'fail' },
              { text: 'Coverage did not run', status: 'neutral' },
            ],
          },
          {
            type: 'paragraph',
            text: 'Root cause: src/validators/currency.js',
          },
          {
            type: 'diff',
            diff: '- if (amount < 0) {\n+ if (amount <= 0) {',
          },
        ],
        completedDuration: '46s',
      },
      contentWidth,
      theme,
    ),
  )

  return lines
}

export async function runTuiDemo(io: ChatIo, theme: UITheme): Promise<void> {
  let inspectorOpen = false

  function renderCurrentFrame(): void {
    const { columns, rows } = io.size()
    const contentWidth = inspectorOpen ? columns - 36 : columns - 4
    const transcriptLines = generateDemoTranscript(contentWidth, theme)

    const frame = renderFullScreenFrame({
      header: {
        projectName: 'pluton-harness',
        rootDir: process.cwd(),
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
            model: 'deepseek-v4.1-flash-free',
            state: 'idle',
          },
        ],
        tasks: [],
        approvals: [],
        events: [],
      },
      transcriptLines,
      editor: {
        text: '',
        cursor: 0,
      },
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
      theme,
      brandHeader: true,
      inspectorOpen,
      mode: 'chat',
      contextPct: 42,
      cost: 0.04,
    })

    io.redraw(frame)
  }

  renderCurrentFrame()
  io.onResize?.(() => {
    renderCurrentFrame()
  })

  return new Promise<void>((resolve) => {
    io.onKey((input, key) => {
      // Toggle orchestra inspector on Tab
      if (key?.name === 'tab') {
        inspectorOpen = !inspectorOpen
        renderCurrentFrame()
        return
      }

      // Exit on ESC, Ctrl+C, 'q', or Enter
      if (
        key?.name === 'escape' ||
        key?.name === 'return' ||
        key?.name === 'enter' ||
        (key?.name === 'c' && key?.ctrl) ||
        input === 'q'
      ) {
        resolve()
      }
    })
  })
}
