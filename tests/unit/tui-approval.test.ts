import { describe, expect, it } from 'vitest'
import { renderApprovalCard, renderEngineRequestNotice, type ApprovalViewData } from '../../src/tui/approval.ts'
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
    expect(lines[0]).toContain('APPROVAL REQUIRED')
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
    expect(stripAnsi(lines[0]!)).toContain('APPROVAL REQUIRED')
    expect(lines[0]).toContain('\x1b[') // colored box
  })

  it('strips terminal control bytes from engine-supplied reason and scope', () => {
    const data: ApprovalViewData = {
      id: 'app_esc',
      action: 'engine.permission',
      reason: 'engine requested permission: \u001b[2Jclear\u0007 screen',
      scope: { paths: ['src/a.ts'] },
    }
    const card = renderApprovalCard(data, 72, plain)
    // No raw control byte survives into any rendered row (the reason is the
    // raw-text vector; JSON.stringify additionally escapes control bytes in
    // scope values into inert literal text).
    for (const line of card) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
    const joined = card.join('\n')
    expect(joined).toContain('clear screen')
    expect(joined).toContain('src/a.ts')
  })

  it('strips terminal control bytes from the action row', () => {
    const data: ApprovalViewData = {
      id: 'app_act',
      action: 'muse.create\u0007 \u001b[2Jforged',
      reason: 'routine',
    }
    const card = renderApprovalCard(data, 72, plain)
    for (const line of card) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    }
    expect(card.join('\n')).toContain('muse.create forged')
  })

  it('strips terminal control bytes from the engine request notice', () => {
    const joined = renderEngineRequestNotice(
      'call_1',
      'engine requested permission: \u001b[2Jboom\u0007',
      60,
      plain,
    ).join('\n')
    expect(joined).not.toContain('\u001b')
    expect(joined).not.toContain('\u0007')
    expect(joined).toContain('boom')
  })
})
