import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapStore } from '../../bootstrap.ts'
import { stateDir, workspaceDir } from '../../config/load.ts'
import { ValidationError } from '../../domain/errors.ts'
import type { JsonValue, TaskRecord, WorkspaceRecord } from '../../domain/models.ts'
import type { Store } from '../../store/store.ts'
import { run } from '../../util/exec.ts'
import { GitWorkspaceManager } from '../../workspace/manager.ts'
import { matchProtectedPath } from '../../workspace/protected-paths.ts'
import type { ProjectContext } from '../context.ts'
import { runByRef, taskById } from './status.ts'

/**
 * `pluton integrate --run <id> [--task <id...>]` — merge the run's verified
 * (completed) task branches through one Pluton-owned integration checkout
 * (ADR-0009), never the user's tree and never main:
 *
 * - the checkout lives at `pluton/integration/<run>` under `.pluton/workspaces/`
 *   and is reused while its workspace row is `active`;
 * - a dirty (uncommitted) task checkout is committed FIRST (ADR-0009), so the
 *   verified work actually lands on the task branch before any merge;
 * - every task merge is `fetch` + `merge --no-ff` (the workspace primitives);
 *   a conflict stops the loop and is PRESERVED — Pluton never resets or aborts;
 * - a task whose diff touches `git.protected_paths` is held behind a pending
 *   `integration.apply` approval for that task; rerun after approval merges it;
 * - after any successful merge with no conflict, the integration checks from
 *   `project.verification` run in the checkout, and the whole report is written
 *   to `.pluton/state/artifacts/integration-<run>.json`.
 *
 * The command is verdict data, not a gate: conflicts, blocked tasks and failed
 * checks return `ok: true` in the report. Only pre-flight problems (unknown
 * run, non-completed task selection, nothing to integrate) throw.
 */

export interface IntegrateCommandOptions {
  runRef: string
  /** Integrate only these tasks (full id or unique suffix); each must be completed. */
  taskRefs?: string[]
}

export interface IntegrateDeps {
  /** Test seam: replaces the GitWorkspaceManager built from the project root. */
  workspaceManager?: GitWorkspaceManager
}

export interface IntegrateReport {
  runId: string
  checkout: { id: string; path: string; branch: string }
  integrated: {
    taskId: string
    title: string
    status: 'merged' | 'already_integrated'
    commit: string | null
  }[]
  /** Task checkouts whose dirty state this invocation committed before merging. */
  committed: { taskId: string; commit: string }[]
  conflicts: { taskId: string; files: string[] }[]
  blockedProtected: { taskId: string; files: string[]; approvalId: string }[]
  failed: { taskId: string; detail: string }[]
  /** Completed tasks the loop never reached because an earlier merge conflicted. */
  notAttempted: { taskId: string }[]
  stoppedAfterConflict: boolean
  checks: {
    name: string
    status: 'passed' | 'failed'
    exitCode: number | null
    outputTail: string | null
  }[]
  artifactPath: string | null
}

const CHECK_TIMEOUT_MS = 600_000
const CHECK_MAX_OUTPUT_BYTES = 200_000
const OUTPUT_TAIL_CHARS = 2_000

function approvalScopeTaskId(scope: JsonValue): string | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  const value = (scope as Record<string, JsonValue>)['taskId']
  return typeof value === 'string' ? value : null
}

/** An approved `integration.apply` approval for exactly this task unblocks the gate. */
function hasApprovedApply(store: Store, runId: string, taskId: string): boolean {
  return store
    .listApprovals(runId)
    .some(
      (a) =>
        a.action === 'integration.apply' &&
        a.status === 'approved' &&
        approvalScopeTaskId(a.scope) === taskId,
    )
}

function resolveCandidates(store: Store, runId: string, taskRefs: string[] | undefined): TaskRecord[] {
  if (taskRefs !== undefined && taskRefs.length > 0) {
    return taskRefs.map((ref) => {
      const task = taskById(store, ref)
      if (task.runId !== runId) {
        throw new ValidationError(`task ${task.id} belongs to run ${task.runId}, not ${runId}`)
      }
      if (task.state !== 'completed') {
        throw new ValidationError(
          `task ${task.id} is '${task.state}'; only completed (verified) tasks can be integrated`,
        )
      }
      return task
    })
  }
  const completed = store.listTasks(runId).filter((t) => t.state === 'completed')
  if (completed.length === 0) {
    throw new ValidationError(`run ${runId} has no completed (verified) tasks; nothing to integrate`)
  }
  return completed
}

/** Reuse the run's active integration checkout, else clone one on `pluton/integration/<run>`. */
async function ensureIntegrationCheckout(
  store: Store,
  projectId: string,
  repoPath: string,
  runId: string,
  manager: GitWorkspaceManager,
): Promise<WorkspaceRecord> {
  const existing = store
    .listWorkspaces(projectId, 'active')
    .find((ws) => ws.kind === 'integration-checkout' && ws.runId === runId)
  if (existing !== undefined) return existing
  const info = await manager.createCheckout({
    repoPath,
    kind: 'integration-checkout',
    runId,
    destName: `integration-${runId}`,
  })
  return store.createWorkspace({
    projectId,
    runId,
    taskId: null,
    museId: null,
    kind: 'integration-checkout',
    path: info.path,
    branch: info.branch,
    baseCommit: info.baseCommit,
  })
}

export async function integrateRun(
  ctx: ProjectContext,
  opts: IntegrateCommandOptions,
  deps: IntegrateDeps = {},
): Promise<IntegrateReport> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const runRecord = runByRef(store, opts.runRef)
    const candidates = resolveCandidates(store, runRecord.id, opts.taskRefs)
    const manager =
      deps.workspaceManager ?? new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) })
    const checkout = await ensureIntegrationCheckout(store, projectId, ctx.rootDir, runRecord.id, manager)
    const protectedPatterns = ctx.loaded.config.git.protected_paths

    const integrated: IntegrateReport['integrated'] = []
    const committed: IntegrateReport['committed'] = []
    const conflicts: IntegrateReport['conflicts'] = []
    const blockedProtected: IntegrateReport['blockedProtected'] = []
    const failed: IntegrateReport['failed'] = []
    const notAttempted: IntegrateReport['notAttempted'] = []
    let stoppedAfterConflict = false

    for (const [index, task] of candidates.entries()) {
      const ws = store.getWorkspaceByTask(task.id)
      if (ws === null) {
        const detail = 'no active checkout is recorded for this task; nothing to integrate'
        failed.push({ taskId: task.id, detail })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.failed',
          payload: { taskId: task.id, detail },
        })
        continue
      }

      // ADR-0009: all task changes are committed. The supervisor may leave a
      // verified checkout dirty on purpose (the manager reviews the diff
      // there), so commit it BEFORE the protected-path diff and the merge —
      // otherwise the branch head still equals the base commit and the merge
      // would be a useless `already_integrated`.
      try {
        const { commit } = await manager.commitAll(
          ws.path,
          `pluton: task ${task.id} — ${task.title} (committed at integration)`,
        )
        if (commit !== null) {
          store.updateWorkspace(ws.id, { headCommit: commit })
          store.appendEvent({
            projectId,
            runId: runRecord.id,
            taskId: task.id,
            type: 'integration.task_committed',
            payload: { taskId: task.id, commit },
          })
          committed.push({ taskId: task.id, commit })
        }
      } catch (error) {
        // A checkout that refuses the commit (e.g. not marker-managed) is one
        // task's failure, not the whole run's: record it and move on.
        const detail = error instanceof Error ? error.message : String(error)
        failed.push({ taskId: task.id, detail })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.failed',
          payload: { taskId: task.id, detail },
        })
        continue
      }

      const files = await manager.changedFiles(ws.path, ws.baseCommit)
      const matches = files.filter((f) => protectedPatterns.some((p) => matchProtectedPath(p, f)))
      if (matches.length > 0 && !hasApprovedApply(store, runRecord.id, task.id)) {
        // Uniform approval expiry: same TTL rule as the tool handlers
        // (runtime.approval_timeout_minutes, 0 = never).
        const ttlMinutes = ctx.loaded.config.runtime.approval_timeout_minutes
        const approval = store.createApproval({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          requestedByMuseId: null,
          action: 'integration.apply',
          reason: `task ${task.id} (${task.title}) changes protected paths: ${matches.join(', ')}`,
          scope: { taskId: task.id, runId: runRecord.id, files: matches },
          expiresAt: ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null,
        })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.blocked',
          payload: { taskId: task.id, approvalId: approval.id, files: matches },
        })
        blockedProtected.push({ taskId: task.id, files: matches, approvalId: approval.id })
        continue
      }

      const result = await manager.integrateBranch({
        checkoutPath: checkout.path,
        sourcePath: ws.path,
        sourceBranch: ws.branch,
        message: `pluton: merge ${task.id} — ${task.title}`,
      })

      if (result.status === 'merged' || result.status === 'already_integrated') {
        integrated.push({ taskId: task.id, title: task.title, status: result.status, commit: result.commit })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: result.status === 'merged' ? 'integration.task_merged' : 'integration.already_integrated',
          payload: { taskId: task.id, commit: result.commit },
        })
      } else if (result.status === 'conflict') {
        conflicts.push({ taskId: task.id, files: result.conflicts })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.conflict',
          payload: { taskId: task.id, files: result.conflicts },
        })
        stoppedAfterConflict = true
        for (const skipped of candidates.slice(index + 1)) notAttempted.push({ taskId: skipped.id })
        break
      } else {
        const detail = result.detail ?? 'unknown merge failure'
        failed.push({ taskId: task.id, detail })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.failed',
          payload: { taskId: task.id, detail },
        })
      }
    }

    // Post-merge phase only when there is a reviewable branch state: at least
    // one real merge happened and no conflict froze the checkout mid-merge.
    const checks: IntegrateReport['checks'] = []
    let artifactPath: string | null = null
    const anyMerged = integrated.some((i) => i.status === 'merged')
    if (anyMerged && conflicts.length === 0) {
      const status = await manager.status(checkout.path)
      store.updateWorkspace(checkout.id, { headCommit: status.headCommit })

      for (const check of ctx.loaded.config.project.verification) {
        const res = await run(check.command, {
          cwd: checkout.path,
          timeoutMs: CHECK_TIMEOUT_MS,
          maxOutputBytes: CHECK_MAX_OUTPUT_BYTES,
        })
        const combined = res.stderr.length > 0 ? `${res.stdout}\n${res.stderr}` : res.stdout
        checks.push({
          name: check.name,
          status: res.exitCode === 0 ? 'passed' : 'failed',
          exitCode: res.exitCode,
          outputTail: combined.length > 0 ? combined.slice(-OUTPUT_TAIL_CHARS) : null,
        })
      }
      store.appendEvent({
        projectId,
        runId: runRecord.id,
        type: 'integration.checks',
        payload: {
          checkoutId: checkout.id,
          branch: checkout.branch,
          checks: checks.map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
        },
      })

      const artifactsDir = join(stateDir(ctx.rootDir), 'artifacts')
      mkdirSync(artifactsDir, { recursive: true })
      artifactPath = join(artifactsDir, `integration-${runRecord.id}.json`)
    }

    const report: IntegrateReport = {
      runId: runRecord.id,
      checkout: { id: checkout.id, path: checkout.path, branch: checkout.branch },
      integrated,
      committed,
      conflicts,
      blockedProtected,
      failed,
      notAttempted,
      stoppedAfterConflict,
      checks,
      artifactPath,
    }
    if (artifactPath !== null) writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally {
    store.close()
  }
}
