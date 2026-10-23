import type { Store, SupervisorFence } from '../store/store.ts'

export interface UsageRecord {
  shipId?: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  taskId?: string | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  timestamp?: string
}

export interface BudgetLimits {
  maxRunInputTokens?: number
  maxRunOutputTokens?: number
  maxRunCostUsd?: number
  maxPerShipInputTokens?: number
  maxPerShipOutputTokens?: number
  maxPerShipCostUsd?: number
  /** @deprecated Use `maxPerShipInputTokens`; kept for backward compatibility. */
  maxPerMuseInputTokens?: number
  /** @deprecated Use `maxPerShipOutputTokens`; kept for backward compatibility. */
  maxPerMuseOutputTokens?: number
  /** @deprecated Use `maxPerShipCostUsd`; kept for backward compatibility. */
  maxPerMuseCostUsd?: number
}

export interface RunUsageSummary {
  runId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  totalCostUsd: number
  perShip: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      costUsd: number
    }
  >
  /** @deprecated Use `perShip`; kept for backward compatibility. */
  perMuse: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cachedTokens: number
      costUsd: number
    }
  >
  hardLimitExceeded: boolean
  limitExceededReason?: string
}

export class UsageLedger {
  private readonly runId: string
  private readonly limits: BudgetLimits
  private readonly store?: Store
  private readonly inMemoryRecords: UsageRecord[] = []
  private readonly isMuseBudget: boolean

  constructor(runId: string, limits?: BudgetLimits, store?: Store) {
    this.runId = runId
    const l = limits ?? {}
    this.isMuseBudget = l.maxPerMuseInputTokens !== undefined ||
      l.maxPerMuseOutputTokens !== undefined ||
      l.maxPerMuseCostUsd !== undefined
    this.limits = {
      ...l,
      maxPerShipInputTokens: l.maxPerShipInputTokens ?? l.maxPerMuseInputTokens,
      maxPerShipOutputTokens: l.maxPerShipOutputTokens ?? l.maxPerMuseOutputTokens,
      maxPerShipCostUsd: l.maxPerShipCostUsd ?? l.maxPerMuseCostUsd,
    }
    this.store = store
  }

  /**
   * Record one usage sample and return the budget verdict. `fence` (optional)
   * carries a supervisor's run-ownership proof: a stale owner's sample silently
   * skips the durable write (advisory accounting) while the budget arithmetic
   * stays exactly the same.
   */
  record(usage: UsageRecord, fence?: SupervisorFence): { withinBudget: boolean; limitExceededReason?: string } {
    const shipId = usage.shipId ?? usage.museId ?? 'unknown'
    const normalizedUsage: UsageRecord = {
      ...usage,
      shipId,
      timestamp: usage.timestamp ?? new Date().toISOString(),
    }
    this.inMemoryRecords.push(normalizedUsage)

    if (this.store) {
      this.store.recordUsage(
        {
          runId: this.runId,
          shipId,
          taskId: usage.taskId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          costUsd: usage.costUsd,
        },
        fence,
      )
    }

    return this.checkBudget()
  }

  getSummary(): RunUsageSummary {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedTokens = 0
    let totalCostUsd = 0
    const perShip: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }> = {}

    // Pull either from store (authoritative durable) or in-memory
    if (this.store) {
      const dbUsage = this.store.getRunUsage(this.runId)
      totalInputTokens = dbUsage.totalInputTokens
      totalOutputTokens = dbUsage.totalOutputTokens
      totalCachedTokens = dbUsage.totalCachedTokens
      totalCostUsd = dbUsage.totalCostUsd
      for (const [mId, mData] of Object.entries(dbUsage.perShip)) {
        perShip[mId] = { ...mData }
      }
    } else {
      for (const rec of this.inMemoryRecords) {
        totalInputTokens += rec.inputTokens
        totalOutputTokens += rec.outputTokens
        totalCachedTokens += rec.cachedTokens
        totalCostUsd += rec.costUsd

        const shipId = rec.shipId ?? rec.museId ?? 'unknown'
        const m = perShip[shipId] ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }
        m.inputTokens += rec.inputTokens
        m.outputTokens += rec.outputTokens
        m.cachedTokens += rec.cachedTokens
        m.costUsd += rec.costUsd
        perShip[shipId] = m
      }
    }

    const budgetCheck = this.checkBudgetWithTotals(totalInputTokens, totalOutputTokens, totalCostUsd, perShip)

    return {
      runId: this.runId,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      totalCostUsd,
      perShip,
      perMuse: perShip,
      hardLimitExceeded: !budgetCheck.withinBudget,
      limitExceededReason: budgetCheck.limitExceededReason,
    }
  }

  checkBudget(): { withinBudget: boolean; limitExceededReason?: string } {
    const summary = this.getSummary()
    return {
      withinBudget: !summary.hardLimitExceeded,
      limitExceededReason: summary.limitExceededReason,
    }
  }

  private checkBudgetWithTotals(
    totalInput: number,
    totalOutput: number,
    totalCost: number,
    perShip: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>,
  ): { withinBudget: boolean; limitExceededReason?: string } {
    if (this.limits.maxRunInputTokens !== undefined && totalInput > this.limits.maxRunInputTokens) {
      return {
        withinBudget: false,
        limitExceededReason: `Run total input tokens (${totalInput}) exceeded limit (${this.limits.maxRunInputTokens})`,
      }
    }
    if (this.limits.maxRunOutputTokens !== undefined && totalOutput > this.limits.maxRunOutputTokens) {
      return {
        withinBudget: false,
        limitExceededReason: `Run total output tokens (${totalOutput}) exceeded limit (${this.limits.maxRunOutputTokens})`,
      }
    }
    if (this.limits.maxRunCostUsd !== undefined && totalCost > this.limits.maxRunCostUsd) {
      return {
        withinBudget: false,
        limitExceededReason: `Run total cost ($${totalCost.toFixed(3)}) exceeded limit ($${this.limits.maxRunCostUsd.toFixed(3)})`,
      }
    }

    const entity = this.isMuseBudget ? 'Muse' : 'Ship'
    const limitLabel = this.isMuseBudget ? 'per-muse' : 'per-ship'

    for (const [shipId, usage] of Object.entries(perShip)) {
      if (this.limits.maxPerShipInputTokens !== undefined && usage.inputTokens > this.limits.maxPerShipInputTokens) {
        return {
          withinBudget: false,
          limitExceededReason: `${entity} '${shipId}' input tokens (${usage.inputTokens}) exceeded ${limitLabel} limit (${this.limits.maxPerShipInputTokens})`,
        }
      }
      if (this.limits.maxPerShipOutputTokens !== undefined && usage.outputTokens > this.limits.maxPerShipOutputTokens) {
        return {
          withinBudget: false,
          limitExceededReason: `${entity} '${shipId}' output tokens (${usage.outputTokens}) exceeded ${limitLabel} limit (${this.limits.maxPerShipOutputTokens})`,
        }
      }
      if (this.limits.maxPerShipCostUsd !== undefined && usage.costUsd > this.limits.maxPerShipCostUsd) {
        return {
          withinBudget: false,
          limitExceededReason: `${entity} '${shipId}' cost ($${usage.costUsd.toFixed(3)}) exceeded ${limitLabel} limit ($${this.limits.maxPerShipCostUsd.toFixed(3)})`,
        }
      }
    }

    return { withinBudget: true }
  }
}

export interface CompactContextInput {
  pinnedRules: string[]
  userConstraints: string[]
  acceptanceCriteria: string[]
  currentTaskState: string
  logs: string[]
}

export function compactContext(
  input: CompactContextInput,
  maxLogLines = 10,
): {
  promptText: string
  originalLogCount: number
  compactedLogCount: number
} {
  const lines: string[] = []

  if (input.pinnedRules.length > 0) {
    lines.push('### Pinned Project Rules:')
    for (const r of input.pinnedRules) lines.push(`- ${r}`)
    lines.push('')
  }

  if (input.userConstraints.length > 0) {
    lines.push('### User Constraints:')
    for (const c of input.userConstraints) lines.push(`- ${c}`)
    lines.push('')
  }

  if (input.acceptanceCriteria.length > 0) {
    lines.push('### Acceptance Criteria:')
    for (const a of input.acceptanceCriteria) lines.push(`- ${a}`)
    lines.push('')
  }

  lines.push(`### Current Task State: ${input.currentTaskState}`, '')

  const originalLogCount = input.logs.length
  let compactedLogs = input.logs

  if (compactedLogs.length > maxLogLines) {
    const headCount = Math.floor(maxLogLines / 2)
    const tailCount = maxLogLines - headCount
    const omitted = compactedLogs.length - (headCount + tailCount)
    compactedLogs = [
      ...compactedLogs.slice(0, headCount),
      `[... ${omitted} repetitive log lines omitted for context compaction ...]`,
      ...compactedLogs.slice(-tailCount),
    ]
  }

  lines.push('### Execution Activity & Evidence Summary:')
  for (const l of compactedLogs) lines.push(`  ${l}`)

  return {
    promptText: lines.join('\n'),
    originalLogCount,
    compactedLogCount: compactedLogs.length,
  }
}
