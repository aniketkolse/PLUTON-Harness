import { bootstrapStore } from '../../bootstrap.ts'
import type { ApprovalRecord, ApprovalStatus, JsonValue } from '../../domain/models.ts'
import type { Store } from '../../store/store.ts'
import type { ProjectContext } from '../context.ts'
import { runByRef } from './status.ts'
import {
  sweepExpiredApprovals,
  decideApproval,
  type ApprovalDecideOptions,
  type ApprovalDecideDeps,
  type ApprovalDecideReport,
} from '../../orchestrator/service.ts'

export {
  sweepExpiredApprovals,
  decideApproval,
  type ApprovalDecideOptions,
  type ApprovalDecideDeps,
  type ApprovalDecideReport,
}

export interface ApprovalListOptions {
  /** Include decided (approved/denied/expired) rows; default = pending only. */
  all?: boolean
  /** Only approvals of this run (full id or unique suffix). */
  runRef?: string
}

export interface ApprovalListView {
  approvals: {
    id: string
    action: string
    status: ApprovalStatus
    runId: string | null
    taskId: string | null
    requestedByShipId: string | null
    /** @deprecated Use `requestedByShipId`; kept for backward compatibility. */
    requestedByMuseId?: string | null
    reason: string
    scope: JsonValue
    createdAt: string
    expiresAt: string | null
    decidedAt: string | null
    decidedBy: string | null
    ageMinutes: number
    expiresInMinutes: number | null
  }[]
  counts: Record<ApprovalStatus, number>
}

function toView(record: ApprovalRecord, nowMs: number): ApprovalListView['approvals'][number] {
  return {
    id: record.id,
    action: record.action,
    status: record.status,
    runId: record.runId,
    taskId: record.taskId,
    requestedByShipId: record.requestedByShipId,
    requestedByMuseId: record.requestedByShipId,
    reason: record.reason,
    scope: record.scope,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
    decidedBy: record.decidedBy,
    ageMinutes: Math.max(0, Math.floor((nowMs - Date.parse(record.createdAt)) / 60_000)),
    expiresInMinutes:
      record.expiresAt === null ? null : Math.round((Date.parse(record.expiresAt) - nowMs) / 60_000),
  }
}

export async function listApprovals(ctx: ProjectContext, opts: ApprovalListOptions): Promise<ApprovalListView> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const now = new Date().toISOString()
    sweepExpiredApprovals(store, projectId, now)

    let runId: string | null = null
    if (opts.runRef !== undefined) runId = runByRef(store, opts.runRef).id

    const rows = store.listApprovalsByProject(
      projectId,
      opts.all === true ? { limit: 1_000 } : { status: 'pending', limit: 1_000 },
    )
    const counts: Record<ApprovalStatus, number> = { pending: 0, approved: 0, denied: 0, expired: 0 }
    for (const record of store.listApprovalsByProject(projectId, { limit: 1_000 })) counts[record.status] += 1

    const nowMs = Date.parse(now)
    return {
      approvals: rows
        .filter((record) => runId === null || record.runId === runId)
        .map((record) => toView(record, nowMs)),
      counts,
    }
  } finally {
    store.close()
  }
}
