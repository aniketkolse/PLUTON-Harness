import type { Store } from '../store/store.ts'

export interface UsageRecord {
  museId: string
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
  maxPerMuseInputTokens?: number
  maxPerMuseOutputTokens?: number
  maxPerMuseCostUsd?: number
}

export interface RunUsageSummary {
  runId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  totalCostUsd: number
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

  constructor(runId: string, limits?: BudgetLimits, store?: Store) {
    this.runId = runId
    this.limits = limits ?? {}
    this.store = store
  }

  record(usage: UsageRecord): { withinBudget: boolean; limitExceededReason?: string } {
    this.inMemoryRecords.push({ ...usage, timestamp: usage.timestamp ?? new Date().toISOString() })

    if (this.store) {
      this.store.recordUsage({
        runId: this.runId,
        museId: usage.museId,
        taskId: usage.taskId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: usage.costUsd,
      })
    }

    return this.checkBudget()
  }

  getSummary(): RunUsageSummary {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedTokens = 0
    let totalCostUsd = 0
    const perMuse: Record<string, { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }> = {}

    // Pull either from store (authoritative durable) or in-memory
    if (this.store) {
      const dbUsage = this.store.getRunUsage(this.runId)
      totalInputTokens = dbUsage.totalInputTokens
      totalOutputTokens = dbUsage.totalOutputTokens
      totalCachedTokens = dbUsage.totalCachedTokens
      totalCostUsd = dbUsage.totalCostUsd
      for (const [mId, mData] of Object.entries(dbUsage.perMuse)) {
        perMuse[mId] = { ...mData }
      }
    } else {
      for (const rec of this.inMemoryRecords) {
        totalInputTokens += rec.inputTokens
        totalOutputTokens += rec.outputTokens
        totalCachedTokens += rec.cachedTokens
        totalCostUsd += rec.costUsd

        const m = perMuse[rec.museId] ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }
        m.inputTokens += rec.inputTokens
        m.outputTokens += rec.outputTokens
        m.cachedTokens += rec.cachedTokens
        m.costUsd += rec.costUsd
        perMuse[rec.museId] = m
      }
    }

    const budgetCheck = this.checkBudgetWithTotals(totalInputTokens, totalOutputTokens, totalCostUsd, perMuse)

    return {
      runId: this.runId,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      totalCostUsd,
      perMuse,
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
    perMuse: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>,
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

    for (const [museId, usage] of Object.entries(perMuse)) {
      if (this.limits.maxPerMuseInputTokens !== undefined && usage.inputTokens > this.limits.maxPerMuseInputTokens) {
        return {
          withinBudget: false,
          limitExceededReason: `Muse '${museId}' input tokens (${usage.inputTokens}) exceeded per-muse limit (${this.limits.maxPerMuseInputTokens})`,
        }
      }
      if (this.limits.maxPerMuseOutputTokens !== undefined && usage.outputTokens > this.limits.maxPerMuseOutputTokens) {
        return {
          withinBudget: false,
          limitExceededReason: `Muse '${museId}' output tokens (${usage.outputTokens}) exceeded per-muse limit (${this.limits.maxPerMuseOutputTokens})`,
        }
      }
      if (this.limits.maxPerMuseCostUsd !== undefined && usage.costUsd > this.limits.maxPerMuseCostUsd) {
        return {
          withinBudget: false,
          limitExceededReason: `Muse '${museId}' cost ($${usage.costUsd.toFixed(3)}) exceeded per-muse limit ($${this.limits.maxPerMuseCostUsd.toFixed(3)})`,
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
