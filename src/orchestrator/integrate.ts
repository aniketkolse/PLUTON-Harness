import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrapStore } from '../bootstrap.ts'
import { stateDir, workspaceDir } from '../config/load.ts'
import { ValidationError } from '../domain/errors.ts'
import type { JsonValue, TaskRecord, WorkspaceRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import { captureWorkspaceEvidence } from '../verify/evidence.ts'
import {
  createVerificationExecutor,
  createVerificationSnapshot,
  type VerificationExecutor,
} from '../verify/executor.ts'
import { deniedCommandReason, verificationEvidenceProblem } from '../verify/runner.ts'
import { GitWorkspaceManager } from '../workspace/manager.ts'
import { matchProtectedPath } from '../workspace/protected-paths.ts'
import type { ProjectContext } from './service.ts'
import { runByRef, taskById } from './service.ts'

export interface IntegrateCommandOptions {
  runRef: string
  /** Integrate only these tasks (full id or unique suffix); each must be completed. */
  taskRefs?: string[]
}

export interface IntegrateDeps {
  /** Test seam: replaces the GitWorkspaceManager built from the project root. */
  workspaceManager?: GitWorkspaceManager
  /** Test seam: replaces the platform verification executor. */
  verificationExecutor?: VerificationExecutor
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
  /** Tasks sharing a changed file with another candidate: never auto-merged. */
  blockedOverlap: { taskId: string; files: string[] }[]
  failed: { taskId: string; detail: string }[]
  /** Completed tasks the loop never reached because an earlier merge conflicted. */
  notAttempted: { taskId: string }[]
  /** Tasks whose checkout no longer matches the state verification attested. */
  blockedDrift: {
    taskId: string
    reason: string
    expectedRevision: string | null
    expectedFingerprint: string | null
    actualRevision: string | null
    actualFingerprint: string | null
  }[]
  stoppedAfterConflict: boolean
  checks: {
    name: string
    status: 'passed' | 'failed'
    exitCode: number | null
    outputTail: string | null
    /** Why the check did not pass (isolation refusal, denial, timeout, exit). */
    note: string | null
    /** Confinement mechanism that actually ran (or refused) the check. */
    executor: string
  }[]
  artifactPath: string | null
}

const CHECK_TIMEOUT_MS = 600_000
const CHECK_MAX_OUTPUT_BYTES = 200_000
const OUTPUT_TAIL_CHARS = 2_000
const OVERLAP_EVENT_FILE_LIMIT = 100
const OVERLAP_EVENT_PATH_CHAR_BUDGET = 4_000

export function boundedOverlapFiles(files: string[]): { files: string[]; filesTruncated: boolean } {
  const kept: string[] = []
  let escapedChars = 0
  for (const file of files) {
    if (kept.length >= OVERLAP_EVENT_FILE_LIMIT) break
    const escaped = JSON.stringify(file).length
    if (escapedChars + escaped > OVERLAP_EVENT_PATH_CHAR_BUDGET) break
    kept.push(file)
    escapedChars += escaped
  }
  return { files: kept, filesTruncated: kept.length < files.length }
}

export function approvalScopeTaskId(scope: JsonValue): string | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return null
  const value = (scope as Record<string, JsonValue>)['taskId']
  return typeof value === 'string' ? value : null
}

function hasApprovedApply(store: Store, runId: string, taskId: string, matches: string[]): boolean {
  return store.listApprovals(runId).some((a) => {
    if (a.action !== 'integration.apply' || a.status !== 'approved') return false
    if (a.taskId !== taskId || a.requestedByShipId !== null) return false
    if (approvalScopeTaskId(a.scope) !== taskId) return false
    const scope = a.scope
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return false
    const files = (scope as Record<string, JsonValue>)['files']
    if (!Array.isArray(files)) return false
    const approved = files.filter((f): f is string => typeof f === 'string')
    return matches.every((m) => approved.includes(m))
  })
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

function hasIntegrationCommit(store: Store, runId: string, taskId: string): boolean {
  const row = store.db
    .prepare("SELECT 1 AS present FROM events WHERE run_id = ? AND task_id = ? AND type = 'integration.task_committed' LIMIT 1")
    .get(runId, taskId) as { present: number } | undefined
  return row !== undefined
}

/**
 * True only when every post-integration check actually passed. Consumers must
 * use this for exit status/report outcome: running checks and printing their
 * statuses without gating on the result is not verification.
 */
export function integrationChecksPassed(checks: IntegrateReport['checks']): boolean {
  return checks.every((c) => c.status === 'passed')
}

interface DriftAssessment {
  problem: IntegrateReport['blockedDrift'][number] | null
  /**
   * Set only when the checkout still matches the verified post-check
   * fingerprint exactly. The commit is then bound to that fingerprint, so a
   * mutation between the drift check and the commit is refused.
   */
  expectedFingerprintForCommit: string | null
}

/**
 * Refuse to commit/merge work that no longer matches the state verification
 * attested. The post-check fingerprint is the authority: HEAD movement,
 * further edits, or untracked files after the check are all drift. A checkout
 * committed by an earlier integration run is already covered by that commit,
 * so its idempotent re-run is allowed.
 *
 * A Git-backed task with no current-attempt evidence is blocked; "verification
 * was never configured" is not a license to integrate untested work.
 */
async function verificationDrift(
  store: Store,
  runId: string,
  task: TaskRecord,
  ws: WorkspaceRecord,
): Promise<DriftAssessment> {
  const blocked = (
    reason: string,
    expectedRevision: string | null,
    expectedFingerprint: string | null,
    actualRevision: string | null = null,
    actualFingerprint: string | null = null,
  ): DriftAssessment => ({
    problem: {
      taskId: task.id,
      reason,
      expectedRevision,
      expectedFingerprint,
      actualRevision,
      actualFingerprint,
    },
    expectedFingerprintForCommit: null,
  })

  const checks = store.listCurrentVerificationChecksByTaskAttempt(task.id, task.attempt)
  if (checks.length === 0) {
    return blocked(`no verification evidence for attempt ${String(task.attempt)}`, null, null)
  }
  const evidenceProblem = verificationEvidenceProblem(checks, { requireGit: true })
  const latest = checks[checks.length - 1] as (typeof checks)[number]
  const expectedRevision = latest.postRevision
  const expectedFingerprint = latest.postWorktreeFingerprint
  if (evidenceProblem !== null) {
    return blocked(
      `verification evidence is incomplete or inconsistent: ${evidenceProblem}`,
      expectedRevision,
      expectedFingerprint,
    )
  }
  if (expectedRevision === null || expectedFingerprint === null) {
    return blocked('verified revision has no post-check worktree fingerprint', expectedRevision, expectedFingerprint)
  }

  const current = await captureWorkspaceEvidence(ws.path)
  if (current.kind !== 'git' || !current.available) {
    return blocked(
      current.kind === 'capture-failed'
        ? `current workspace evidence could not be captured: ${current.reason ?? 'unknown capture failure'}`
        : 'current workspace is not a Git checkout; integration requires Git evidence',
      expectedRevision,
      expectedFingerprint,
      current.revision,
      current.worktreeFingerprint,
    )
  }
  if (
    hasIntegrationCommit(store, runId, task.id) &&
    current.revision === ws.headCommit &&
    current.worktreeDirty === false
  ) {
    return { problem: null, expectedFingerprintForCommit: null }
  }
  if (current.revision !== expectedRevision) {
    return blocked(
      'task checkout HEAD changed after verification',
      expectedRevision,
      expectedFingerprint,
      current.revision,
      current.worktreeFingerprint,
    )
  }
  if (current.worktreeFingerprint !== expectedFingerprint) {
    return blocked(
      'task checkout changed after verification',
      expectedRevision,
      expectedFingerprint,
      current.revision,
      current.worktreeFingerprint,
    )
  }
  return { problem: null, expectedFingerprintForCommit: expectedFingerprint }
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
    const blockedOverlap: IntegrateReport['blockedOverlap'] = []
    const blockedDrift: IntegrateReport['blockedDrift'] = []
    const failed: IntegrateReport['failed'] = []
    const notAttempted: IntegrateReport['notAttempted'] = []
    let stoppedAfterConflict = false

    const prepByTask = new Map<string, string[]>()
    const prepFailed = new Set<string>()
    for (const task of candidates) {
      if (prepByTask.has(task.id) || prepFailed.has(task.id)) continue
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
        prepFailed.add(task.id)
        continue
      }

      try {
        const driftAssessment = await verificationDrift(store, runRecord.id, task, ws)
        const drift = driftAssessment.problem
        if (drift !== null) {
          blockedDrift.push(drift)
          store.appendEvent({
            projectId,
            runId: runRecord.id,
            taskId: task.id,
            type: 'integration.drift_detected',
            payload: {
              taskId: task.id,
              reason: drift.reason,
              expectedRevision: drift.expectedRevision,
              expectedFingerprint: drift.expectedFingerprint,
              actualRevision: drift.actualRevision,
              actualFingerprint: drift.actualFingerprint,
            },
          })
          prepFailed.add(task.id)
          continue
        }
        const { commit } = await manager.commitAll(
          ws.path,
          `pluton: task ${task.id} — ${task.title} (committed at integration)`,
          driftAssessment.expectedFingerprintForCommit !== null
            ? { expectedFingerprint: driftAssessment.expectedFingerprintForCommit }
            : {},
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
        const detail = error instanceof Error ? error.message : String(error)
        failed.push({ taskId: task.id, detail })
        store.appendEvent({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          type: 'integration.failed',
          payload: { taskId: task.id, detail },
        })
        prepFailed.add(task.id)
        continue
      }

      const files = await manager.changedFiles(ws.path, ws.baseCommit)
      prepByTask.set(task.id, files)
    }

    const claimingTasks = new Map<string, Set<string>>()
    for (const [taskId, files] of prepByTask) {
      for (const file of files) {
        const claiming = claimingTasks.get(file)
        if (claiming === undefined) claimingTasks.set(file, new Set([taskId]))
        else claiming.add(taskId)
      }
    }
    const overlapBlocked = new Set<string>()
    for (const [taskId, files] of prepByTask) {
      const shared = [...new Set(files.filter((f) => (claimingTasks.get(f)?.size ?? 0) > 1))].sort()
      if (shared.length === 0) continue
      blockedOverlap.push({ taskId, files: shared })
      const eventFiles = boundedOverlapFiles(shared)
      store.appendEvent({
        projectId,
        runId: runRecord.id,
        taskId,
        type: 'integration.overlap_detected',
        payload: {
          taskId,
          files: eventFiles.files,
          ...(eventFiles.filesTruncated ? { filesTruncated: true } : {}),
        },
      })
      overlapBlocked.add(taskId)
    }

    for (const [index, task] of candidates.entries()) {
      if (prepFailed.has(task.id)) continue
      if (overlapBlocked.has(task.id)) continue
      const ws = store.getWorkspaceByTask(task.id)
      const files = prepByTask.get(task.id)
      if (ws === null || files === undefined) {
        failed.push({ taskId: task.id, detail: 'internal: candidate was not prepped' })
        continue
      }
      const matches = files.filter((f) => protectedPatterns.some((p) => matchProtectedPath(p, f)))
      if (matches.length > 0 && !hasApprovedApply(store, runRecord.id, task.id, matches)) {
        const ttlMinutes = ctx.loaded.config.runtime.approval_timeout_minutes
        const approval = store.createApproval({
          projectId,
          runId: runRecord.id,
          taskId: task.id,
          requestedByShipId: null,
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

    const checks: IntegrateReport['checks'] = []
    let artifactPath: string | null = null
    const anyMerged = integrated.some((i) => i.status === 'merged')
    if (anyMerged && conflicts.length === 0) {
      const status = await manager.status(checkout.path)
      store.updateWorkspace(checkout.id, { headCommit: status.headCommit })

      // Integration checks run over merged worker content, so they use the
      // same disposable-snapshot + confinement boundary as task verification.
      // A host without proven confinement refuses every check; it never runs
      // project code directly on the host.
      const executor = deps.verificationExecutor ?? createVerificationExecutor()
      const availability = executor.availability ?? { available: true, reason: null }
      let snapshot: string | null = null
      let refusal: string | null = availability.available
        ? null
        : availability.reason ?? 'verification isolation is unavailable'
      if (availability.available) {
        try {
          snapshot = createVerificationSnapshot(checkout.path)
        } catch (error) {
          refusal = `verification snapshot failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      try {
        for (const check of ctx.loaded.config.project.verification) {
          const denied = deniedCommandReason(check.command)
          let exitCode: number | null = null
          let combined = ''
          let note: string | null = null
          let executorId = executor.id
          if (denied !== null) {
            note = denied
            combined = denied
          } else if (snapshot === null) {
            note = `verification isolation is unavailable: ${refusal ?? 'no disposable snapshot'}`
            combined = note
          } else {
            try {
              const res = await executor.run({
                command: check.command,
                cwd: snapshot,
                workspaceRoot: snapshot,
                env: {},
                timeoutMs: CHECK_TIMEOUT_MS,
                maxOutputBytes: CHECK_MAX_OUTPUT_BYTES,
                network: 'none',
              })
              executorId = res.executor
              exitCode = res.exitCode
              combined = res.stderr.length > 0 ? `${res.stdout}\n${res.stderr}` : res.stdout
              if (res.timedOut) note = `check timed out after ${String(CHECK_TIMEOUT_MS)}ms`
              else if (res.exitCode !== 0) note = `exit code ${String(res.exitCode)}`
            } catch (error) {
              note = `verification isolation is unavailable: ${error instanceof Error ? error.message : String(error)}`
              combined = note
            }
          }
          checks.push({
            name: check.name,
            status: exitCode === 0 && note === null ? 'passed' : 'failed',
            exitCode,
            outputTail: combined.length > 0 ? combined.slice(-OUTPUT_TAIL_CHARS) : null,
            note,
            executor: executorId,
          })
        }
      } finally {
        if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true })
      }
      store.appendEvent({
        projectId,
        runId: runRecord.id,
        type: 'integration.checks',
        payload: {
          checkoutId: checkout.id,
          branch: checkout.branch,
          checks: checks.map((c) => ({
            name: c.name,
            status: c.status,
            exitCode: c.exitCode,
            note: c.note,
            executor: c.executor,
          })),
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
      blockedOverlap,
      blockedDrift,
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
