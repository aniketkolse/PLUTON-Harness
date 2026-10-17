import { describe, expect, it } from 'vitest'
import {
  createToolActivity,
  renderToolActivity,
  type ToolActivityState,
} from '../../src/tui/activity.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('Tool Activity Refinement', () => {
  const plain = createTheme({ color: false })

  it('does not duplicate name in header if summary matches name or is empty', () => {
    const act1 = createToolActivity({
      id: 'call_1',
      name: 'bash',
      summary: 'bash',
    })
    const lines1 = renderToolActivity(act1, false, 80, plain)
    const header1 = stripAnsi(lines1[0]!)
    expect(header1).not.toContain('bash — bash')
    expect(header1).toContain('bash')

    const act2 = createToolActivity({
      id: 'call_2',
      name: 'read_file',
      summary: '',
    })
    const lines2 = renderToolActivity(act2, false, 80, plain)
    const header2 = stripAnsi(lines2[0]!)
    expect(header2).not.toContain('read_file —')
    expect(header2).toContain('read_file')
  })

  it('renders distinct action description when summary differs from name', () => {
    const act = createToolActivity({
      id: 'call_3',
      name: 'read_file',
      summary: 'src/app.ts',
    })
    const lines = renderToolActivity(act, false, 80, plain)
    const header = stripAnsi(lines[0]!)
    expect(header).toContain('read_file — src/app.ts')
  })

  it('renders formatted JSON in expanded mode instead of raw JSON blob', () => {
    const act: ToolActivityState = {
      id: 'call_4',
      name: 'run.inspect',
      summary: 'inspect run_1',
      status: 'succeeded',
      input: { runId: 'run_1' },
      output: JSON.stringify({ state: 'active', goal: 'Build search feature' }),
    }
    const lines = renderToolActivity(act, true, 80, plain)
    const fullText = lines.map((l) => stripAnsi(l)).join('\n')
    expect(fullText).toContain('state')
    expect(fullText).toContain('Build search feature')
  })
})
