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
 *   verified work actually lands on the task branch before any merge. All
 *   candidates prep before any merge, so `committed` can include a candidate
 *   the merge loop later reports as `blockedOverlap`;
 * - before any merge the candidates' changed files are mapped file→tasks: a
 *   file claimed by two or more tasks blocks EVERY claimant (`blockedOverlap`
 *   + `integration.overlap_detected`), never first-come-first-served. Overlap
 *   is checked before the protected gate, so an overlap-blocked task files no
 *   `integration.apply` approval. Explicit `--task <id>` selection scopes the
 *   candidate set and is the operator's deliberate per-task path (one candidate
 *   is never an overlap group), so an overlap group stays reported on every
 *   later full run even after a manual per-task merge: the pair never
 *   auto-merges in a batch, and manual reconciliation keeps today's
 *   conflict-preservation semantics;
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
 *
 * Reading a task's changed files is deliberately NOT caught per task: a git
 * failure there aborts the whole run before anything is merged — stricter than
 * a `failed` entry, and safer, because an unreadable diff must never silently
 * auto-merge.
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
  /** Tasks sharing a changed file with another candidate: never auto-merged. */
  blockedOverlap: { taskId: string; files: string[] }[]
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
/** Count cap for the `integration.overlap_detected` payload (see {@link boundedOverlapFiles}). */
const OVERLAP_EVENT_FILE_LIMIT = 100
/**
 * Accumulated JSON-escaped-character budget for the included file paths — the
 * binding half of the bound. The store measures `canonicalJson(payload)`, where
 * `\`, `"` and control characters expand 2–6×, so counting raw path lengths
 * could still overshoot the 8 000-char event cap; {@link boundedOverlapFiles}
 * therefore counts `JSON.stringify(file).length` (quotes included, a faithful
 * stand-in for canonical string escaping) and stops on whichever cap hits
 * first, keeping the serialized payload comfortably under the cap.
 */
const OVERLAP_EVENT_PATH_CHAR_BUDGET = 4_000

/**
 * Bound the `integration.overlap_detected` event payload: the store rejects
 * event payloads over `DEFAULT_MAX_EVENT_CHARS` (8 000) by throwing
 * `ValidationError`, and an unbounded shared-file set must never abort the
 * whole integrate command mid-report. Keeps files in order while both the
 * count cap and the accumulated JSON-escaped-character budget hold; anything
 * dropped sets `filesTruncated`. The report's `blockedOverlap` keeps the full
 * list — only the durable event is bounded.
 */
export function boundedOverlapFiles(files: string[]): { files: string[]; filesTruncated: boolean } {
  const kept: string[] = []
  let escapedChars = 0
  for (const file of files) {
    if (kept.length >= OVERLAP_EVENT_FILE_LIMIT) break
    // The store measures the serialized payload, not the raw path: count what
    // JSON escaping will actually add.
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

/**
 * An approved, gate-authored `integration.apply` covering every currently
 * protected file unblocks the gate. Deliberately strict: the row must carry
 * the gate's own provenance (no requesting muse — rows filed through
 * `approval.request` are muse-stamped) and the file-list disclosure it
 * recorded at block time must cover today's matches, so neither a row a Muse
 * could forge nor an approval that predates new protected edits authorizes
 * the merge.
 */
function hasApprovedApply(store: Store, runId: string, taskId: string, matches: string[]): boolean {
  return store.listApprovals(runId).some((a) => {
    if (a.action !== 'integration.apply' || a.status !== 'approved') return false
    if (a.taskId !== taskId || a.requestedByMuseId !== null) return false
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
    const blockedOverlap: IntegrateReport['blockedOverlap'] = []
    const failed: IntegrateReport['failed'] = []
    const notAttempted: IntegrateReport['notAttempted'] = []
    let stoppedAfterConflict = false

    // Phase 1 — prep each distinct candidate: resolve its workspace, commit a
    // dirty checkout (ADR-0009) and read its changed files. Duplicate refs prep
    // once; the merge loop below still visits every candidate entry.
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
        prepFailed.add(task.id)
        continue
      }

      const files = await manager.changedFiles(ws.path, ws.baseCommit)
      prepByTask.set(task.id, files)
    }

    // Phase 2 — overlap map: a file claimed by two or more distinct prepped
    // candidates blocks EVERY claimant (never first-come-first-served). It is
    // built after all preps and before any merge, so an overlap-blocked task
    // never reaches the protected gate below and files no approval.
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

    // Phase 3 — merge loop: candidate order. Prep-failed and overlap-blocked
    // tasks were already recorded above and are only skipped here.
    for (const [index, task] of candidates.entries()) {
      if (prepFailed.has(task.id)) continue // recorded during prep
      if (overlapBlocked.has(task.id)) continue // recorded in the overlap pass
      const ws = store.getWorkspaceByTask(task.id)
      const files = prepByTask.get(task.id)
      if (ws === null || files === undefined) {
        // unreachable — every other candidate was prepped above — but record
        // rather than silently drop the candidate if that ever changes.
        failed.push({ taskId: task.id, detail: 'internal: candidate was not prepped' })
        continue
      }
      const matches = files.filter((f) => protectedPatterns.some((p) => matchProtectedPath(p, f)))
      if (matches.length > 0 && !hasApprovedApply(store, runRecord.id, task.id, matches)) {
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
      blockedOverlap,
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
