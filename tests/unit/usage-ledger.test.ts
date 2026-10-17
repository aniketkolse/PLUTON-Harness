import { describe, expect, it } from 'vitest'
import { UsageLedger, compactContext } from '../../src/orchestrator/usage-ledger.ts'

describe('UsageLedger', () => {
  it('aggregates tokens and costs per-Muse and run-wide', () => {
    const ledger = new UsageLedger('run-1')
    ledger.record({
      museId: 'coder-1',
      taskId: 'task-1',
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      costUsd: 0.015,
    })
    ledger.record({
      museId: 'tester-1',
      taskId: 'task-2',
      inputTokens: 2000,
      outputTokens: 800,
      cachedTokens: 500,
      costUsd: 0.025,
    })

    const summary = ledger.getSummary()
    expect(summary.totalInputTokens).toBe(3000)
    expect(summary.totalOutputTokens).toBe(1300)
    expect(summary.totalCachedTokens).toBe(700)
    expect(summary.totalCostUsd).toBeCloseTo(0.04)

    expect(summary.perMuse['coder-1']?.inputTokens).toBe(1000)
    expect(summary.perMuse['tester-1']?.outputTokens).toBe(800)
    expect(summary.hardLimitExceeded).toBe(false)
  })

  it('enforces run-wide token limits', () => {
    const ledger = new UsageLedger('run-1', { maxRunInputTokens: 5000 })
    const r1 = ledger.record({
      museId: 'coder-1',
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 0,
      costUsd: 0.01,
    })
    expect(r1.withinBudget).toBe(true)

    const r2 = ledger.record({
      museId: 'coder-1',
      inputTokens: 2500,
      outputTokens: 500,
      cachedTokens: 0,
      costUsd: 0.01,
    })
    expect(r2.withinBudget).toBe(false)
    expect(r2.limitExceededReason).toContain('Run total input tokens (5500) exceeded limit (5000)')
  })

  it('enforces per-Muse token limits', () => {
    const ledger = new UsageLedger('run-1', { maxPerMuseOutputTokens: 1000 })
    ledger.record({
      museId: 'coder-1',
      inputTokens: 500,
      outputTokens: 600,
      cachedTokens: 0,
      costUsd: 0.005,
    })

    const r = ledger.record({
      museId: 'coder-1',
      inputTokens: 500,
      outputTokens: 500,
      cachedTokens: 0,
      costUsd: 0.005,
    })
    expect(r.withinBudget).toBe(false)
    expect(r.limitExceededReason).toContain("Muse 'coder-1' output tokens (1100) exceeded per-muse limit (1000)")
  })
})

describe('compactContext', () => {
  it('preserves pinned rules, constraints, and acceptance criteria while compacting repetitive logs', () => {
    const logs = [
      'Reading file a.ts',
      'Reading file a.ts',
      'Reading file a.ts',
      'Building project',
      'Testing component 1',
      'Testing component 2',
      'Testing component 3',
      'Testing component 4',
      'Testing component 5',
      'Testing component 6',
      'Testing component 7',
      'All tests passed',
    ]

    const res = compactContext(
      {
        pinnedRules: ['Never edit package-lock.json directly', 'Work only in assigned workspace'],
        userConstraints: ['Target Node 24 and ESM only'],
        acceptanceCriteria: ['Passes unit tests', 'No regressions'],
        currentTaskState: 'verifying',
        logs,
      },
      5,
    )

    expect(res.promptText).toContain('Pinned Project Rules:')
    expect(res.promptText).toContain('Never edit package-lock.json directly')
    expect(res.promptText).toContain('User Constraints:')
    expect(res.promptText).toContain('Target Node 24 and ESM only')
    expect(res.promptText).toContain('Acceptance Criteria:')
    expect(res.promptText).toContain('Passes unit tests')
    expect(res.originalLogCount).toBe(12)
    expect(res.compactedLogCount).toBeLessThanOrEqual(6)
    expect(res.promptText).toContain('omitted')
  })
})
