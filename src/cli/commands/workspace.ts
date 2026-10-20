import { existsSync } from 'node:fs'
import { bootstrapStore } from '../../bootstrap.ts'
import { workspaceDir } from '../../config/load.ts'
import { ValidationError, WorkspaceError } from '../../domain/errors.ts'
import type { RunRecord } from '../../domain/models.ts'
import { SESSION_BACKED_TASK_STATES, isTerminalRunState, type TaskState } from '../../domain/state.ts'
import type { Store } from '../../store/store.ts'
import { GitWorkspaceManager } from '../../workspace/manager.ts'
import type { ProjectContext } from '../context.ts'
import { runByRef } from './status.ts'

/**
 * `pluton workspace clean [--run <id> | --all-runs]` — the operator-invoked
 * cleanup of Pluton workspace checkouts under `.pluton/workspaces/`:
 *
 * - exactly one selector: `--run <id>` cleans one run, `--all-runs` sweeps
 *   every terminal run of the project and reports the runs still in flight;
 * - fail-closed refusal: a non-terminal run, or a run with any task in an
 *   in-flight state — the canonical session-backed five
 *   (`SESSION_BACKED_TASK_STATES`) plus `verifying`, whose subprocess runs
 *   inside the checkout — is never cleaned.
 *   `--run` throws a `ValidationError` naming the run and the offending
 *   tasks; `--all-runs` records a `refusedRuns` entry for it and skips;
 * - removal is marker-guarded through `GitWorkspaceManager.removeCheckout`:
 *   only Pluton-created checkouts (ownership marker in their `.git/`) inside
 *   the workspaces root can be deleted. Removing a checkout DELETES its branch
 *   objects with it — for work never merged (`pluton integrate`) or pushed,
 *   that checkout held the only copy — so merge before cleaning when the work
 *   is needed. A refused removal (no marker, or a busy path on Windows)
 *   becomes that one workspace's `skipped` entry and its row stays `active`;
 *   a stale row whose directory is already gone is skipped with its own "path
 *   is missing" reason;
 * - after a successful removal the workspace row flips to `state='removed'`
 *   (the row itself stays — it is the durable record) and a
 *   `workspace.removed` event is appended. Destructive namespace operations
 *   must be auditable, like `integration.*`;
 * - only `active` rows are candidates, so re-runs are idempotent, and rows
 *   with `runId === null` are never touched (this command is run-scoped);
 * - evidence is preserved: nothing else on disk is touched — verification and
 *   integration artifacts live under `.pluton/state/artifacts` and archived
 *   checkouts under `.pluton/workspaces-attic`, both outside the removal root.
 */

export interface WorkspaceCleanOptions {
  runRef?: string
  allRuns?: boolean
}

export interface WorkspaceCleanDeps {
  /** Test seam: replaces the GitWorkspaceManager built from the project root. */
  workspaceManager?: GitWorkspaceManager
}

export interface WorkspaceCleanReport {
  removed: { workspaceId: string; runId: string; taskId: string | null; kind: string; path: string }[]
  skipped: { workspaceId: string; path: string; reason: string }[]
  refusedRuns: { runId: string; reason: string }[]
}

/**
 * The in-flight task states: the canonical session-backed five
 * (`SESSION_BACKED_TASK_STATES` — an engine session may still be live there)
 * plus `verifying`, because verification runs a subprocess inside the task's
 * checkout. `verifying` is deliberately NOT part of the canonical five: it is
 * not session-backed. Cleaning a checkout out from under any of them is
 * fail-closed refused; `created`/`queued` tasks hold nothing live and do not
 * block.
 */
const IN_FLIGHT_TASK_STATES: ReadonlySet<TaskState> = new Set([...SESSION_BACKED_TASK_STATES, 'verifying'])

/** Bounded scan, the same idiom as `runByRef`/`taskById`. */
const ALL_RUNS_SCAN_LIMIT = 500

/**
 * Why this run's checkouts must not be cleaned, or null when they may be.
 * The reason always names the run and the offending states, so both the
 * thrown error (`--run`) and a skip entry (`--all-runs`) are actionable.
 */
function cleanRefusal(store: Store, run: RunRecord): string | null {
  if (!isTerminalRunState(run.state)) {
    return `run ${run.id} is '${run.state}' (not terminal); only terminal runs' workspaces may be cleaned`
  }
  const inUse = store.listTasks(run.id).filter((task) => IN_FLIGHT_TASK_STATES.has(task.state))
  if (inUse.length > 0) {
    const details = inUse.map((task) => `task ${task.id} is '${task.state}'`).join(', ')
    return `run ${run.id} is in use: ${details}`
  }
  return null
}

export async function workspaceClean(
  ctx: ProjectContext,
  opts: WorkspaceCleanOptions,
  deps: WorkspaceCleanDeps = {},
): Promise<WorkspaceCleanReport> {
  const hasRun = opts.runRef !== undefined
  const hasAll = opts.allRuns === true
  if (hasRun === hasAll) throw new ValidationError('pass exactly one of --run <id> or --all-runs')

  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const manager =
      deps.workspaceManager ?? new GitWorkspaceManager({ workspacesRoot: workspaceDir(ctx.rootDir) })
    const removed: WorkspaceCleanReport['removed'] = []
    const skipped: WorkspaceCleanReport['skipped'] = []
    const refusedRuns: WorkspaceCleanReport['refusedRuns'] = []

    const cleanRun = (runId: string): void => {
      // Only active rows are candidates (store order): an already removed or
      // archived row must never be deleted twice. Rows with a null run id are
      // not this command's business.
      const candidates = store.listWorkspaces(projectId, 'active').filter((ws) => ws.runId === runId)
      for (const ws of candidates) {
        if (!existsSync(ws.path)) {
          // A stale row whose directory is already gone: distinct, honest
          // reason — never the marker refusal, which would be misleading.
          skipped.push({
            workspaceId: ws.id,
            path: ws.path,
            reason: 'checkout path is missing; nothing to remove (row left active)',
          })
          continue
        }
        try {
          manager.removeCheckout(ws.path)
        } catch (error) {
          if (error instanceof WorkspaceError) {
            // A marker-less or busy checkout is one workspace's failure, not
            // the command's: report it and keep the row active.
            skipped.push({ workspaceId: ws.id, path: ws.path, reason: error.message })
            continue
          }
          throw error
        }
        store.updateWorkspace(ws.id, { state: 'removed' })
        store.appendEvent({
          projectId,
          runId,
          taskId: ws.taskId,
          type: 'workspace.removed',
          payload: { workspaceId: ws.id, path: ws.path, kind: ws.kind },
        })
        removed.push({ workspaceId: ws.id, runId, taskId: ws.taskId, kind: ws.kind, path: ws.path })
      }
    }

    if (opts.runRef !== undefined) {
      const run = runByRef(store, opts.runRef)
      const refusal = cleanRefusal(store, run)
      if (refusal !== null) throw new ValidationError(refusal)
      cleanRun(run.id)
    } else {
      for (const run of store.listRuns(ALL_RUNS_SCAN_LIMIT)) {
        if (run.projectId !== projectId) continue
        const refusal = cleanRefusal(store, run)
        if (refusal !== null) {
          refusedRuns.push({ runId: run.id, reason: refusal })
          continue
        }
        cleanRun(run.id)
      }
    }

    return { removed, skipped, refusedRuns }
  } finally {
    store.close()
  }
}
