import { describe, expect, it } from 'vitest'
import { renderApprovalCard, type ApprovalViewData } from '../../src/tui/approval.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('renderApprovalCard', () => {
  const plain = createTheme({ color: false })
  const colored = createTheme({ color: true })

  it('renders framed card with action, target, reason, and key shortcuts', () => {
    const data: ApprovalViewData = {
      id: 'app_12345678',
      action: 'run shell command',
      target: 'project workspace',
      reason: 'Command requests network access outside sandbox',
      requestedByMuse: 'worker-a',
    }

    const lines = renderApprovalCard(data, 60, plain)
    expect(lines.length).toBeGreaterThanOrEqual(6)
    expect(lines[0]).toContain('ACTION NEEDS YOUR APPROVAL')
    expect(lines.some((l) => l.includes('worker-a'))).toBe(true)
    expect(lines.some((l) => l.includes('run shell command'))).toBe(true)
    expect(lines.some((l) => l.includes('project workspace'))).toBe(true)
    expect(lines.some((l) => l.includes('[A] Approve once'))).toBe(true)
    expect(lines.some((l) => l.includes('[D] Deny'))).toBe(true)
  })

  it('applies yellow/warning theme styling when color is enabled', () => {
    const data: ApprovalViewData = {
      id: 'app_12345678',
      action: 'delete file',
      target: 'src/main.ts',
      reason: 'destructive action',
    }
    const lines = renderApprovalCard(data, 60, colored)
    expect(stripAnsi(lines[0]!)).toContain('ACTION NEEDS YOUR APPROVAL')
    expect(lines[0]).toContain('\x1b[') // colored box
  })
})
