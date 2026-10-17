import { describe, expect, it } from 'vitest'
import { getUITheme } from '../../src/ui/theme.ts'
import { renderActionableApprovalCard, type ApprovalCardProps } from '../../src/ui/approval.ts'
import { stripAnsi, displayWidth } from '../../src/tui/width.ts'

describe('Approval Notification UI (Phase 9)', () => {
  const theme = getUITheme({ colorLevel: 'truecolor', unicode: true })

  it('renders a concise, actionable approval notification card', () => {
    const props: ApprovalCardProps = {
      id: 'appr-1234',
      action: 'Execute shell command',
      reason: 'Run npm test in workspace',
      pendingIndex: 1,
      pendingTotal: 1,
    }

    const lines = renderActionableApprovalCard(props, 65, theme)
    expect(lines.length).toBe(4) // compact: top, reason/ref, actions, bottom

    const top = stripAnsi(lines[0]!)
    expect(top).toMatch(/⚠ Approval required: Execute shell command|\[!\] Approval required: Execute shell command/)
    expect(top.startsWith('╭')).toBe(true)
    expect(top.endsWith('╮')).toBe(true)
    expect(displayWidth(top)).toBe(65)

    const reasonLine = stripAnsi(lines[1]!)
    expect(reasonLine).toContain('Run npm test in workspace')
    expect(reasonLine).toContain('appr-1234')

    const actionLine = stripAnsi(lines[2]!)
    expect(actionLine).toContain('[A] Approve once')
    expect(actionLine).toContain('[D] Deny')
    expect(actionLine).toContain('[V] Details')
    expect(actionLine).toContain('[Esc] Close')

    const bottom = stripAnsi(lines[3]!)
    expect(bottom.startsWith('╰')).toBe(true)
    expect(bottom.endsWith('╯')).toBe(true)
  })

  it('indicates queue position when multiple approvals are pending', () => {
    const props: ApprovalCardProps = {
      id: 'appr-5678',
      action: 'integration.apply',
      reason: 'Apply code changes',
      pendingIndex: 2,
      pendingTotal: 3,
    }

    const lines = renderActionableApprovalCard(props, 70, theme)
    const top = stripAnsi(lines[0]!)
    expect(top).toContain('(2 of 3)')
  })
})
