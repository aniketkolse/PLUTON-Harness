import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VerificationCheckConfig } from '../config/schema.ts'
import { ValidationError } from '../domain/errors.ts'
import type { JsonValue, VerificationCheckRecord } from '../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import { captureWorkspaceEvidence, type WorkspaceEvidence } from './evidence.ts'
import {
  createVerificationExecutor,
  createVerificationSnapshot,
  type VerificationExecutor,
} from './executor.ts'
import { IndependentVerifier } from './independent.ts'

/**
 * Verification gates (Phase 7; ADR-0006 durability, ADR-0007 policy): the only
 * path from `verifying` to `completed`. Checks are configured as argv arrays
 * (never shell strings), executed through the shared bounded process runner,
 * and recorded as durable evidence rows plus `verification.run` events before
 * any verdict is applied. Every configured check is required: a failed,
 * errored, denied or never-run check can never produce a green task.
 */

const DEFAULT_CHECK_TIMEOUT_MS = 300_000
const DEFAULT_CHECK_MAX_OUTPUT_BYTES = 100_000

/**
 * argv[0] basenames that are never acceptable verification commands: shells
 * would smuggle shell strings past the argv-array rule, and the destructive
 * tools have no place in a verification gate. The project config itself is the
 * allow list — only configured checks ever run.
 */
const DENIED_COMMANDS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'mkfs',
  'fdisk',
  'diskpart',
  'dd',
  'sudo',
  'su',
  'shutdown',
  'reg',
  'reg.exe',
  'diskutil',
  'chmod',
  'chown',
])

/** Returns a refusal reason when the command is on the deny list, else null. */
export function deniedCommandReason(command: string[]): string | null {
  const first = command[0]
  if (first === undefined || first.length === 0) return 'empty command'
  const base = basename(first).toLowerCase()
  if (DENIED_COMMANDS.has(base)) {
    return `command '${base}' is on the verification deny list (argv arrays only: no shells, no destructive tools)`
  }
  return null
}

export interface VerificationRunOptions {
  store: Store
  projectId: string
  runId: string
  taskId: string | null
  checks: VerificationCheckConfig[]
  /** Where the checks execute: the task's checkout, or the project root. */
  cwd: string
  workspaceId: string | null
  /** Directory for bounded stdout/stderr artifacts (created if missing). */
  artifactsDir: string
  maxOutputBytes?: number
  timeoutMs?: number
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number
  /** Test seam: replaces the platform verification executor. */
  executor?: VerificationExecutor
}

export interface VerificationCheckResult {
  checkId: string
  name: string
  /** `passed` only on a real exit 0; anything else (denied, timeout, spawn error) is `failed`. */
  status: 'passed' | 'failed'
  exitCode: number | null
  durationMs: number
  /** Human reason when the check did not pass. */
  note: string | null
  /** Confinement mechanism that actually ran (or refused) the check. */
  executor: string
}

export interface VerificationRunReport {
  runId: string
  taskId: string | null
  /** Task attempt this evidence belongs to (0 for run-level checks). */
  attempt: number
  results: VerificationCheckResult[]
  allPassed: boolean
  /** Git evidence: the state checks were run against, and the post-check state. */
  evidence: {
    kind: WorkspaceEvidence['kind']
    available: boolean
    revision: string | null
    worktreeDirty: boolean | null
    worktreeFingerprint: string | null
    postKind: WorkspaceEvidence['kind']
    postRevision: string | null
    postWorktreeDirty: boolean | null
    postWorktreeFingerprint: string | null
  }
}

const NO_EVIDENCE: WorkspaceEvidence = {
  kind: 'capture-failed',
  available: false,
  reason: 'no verification evidence was captured',
  revision: null,
  worktreeDirty: null,
  worktreeFingerprint: null,
}

/**
 * Run every configured check in order, record each outcome durably (evidence
 * row first, then event), and report. Never throws for a failing check — a
 * failing check is data for the verdict, not an infrastructure error.
 */
export async function runVerificationChecks(opts: VerificationRunOptions): Promise<VerificationRunReport> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_CHECK_MAX_OUTPUT_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const run = opts.store.getRun(opts.runId)
  if (run.projectId !== opts.projectId) {
    throw new ValidationError(
      `run ${opts.runId} belongs to project ${run.projectId}, not ${opts.projectId}; refusing to record verification evidence`,
    )
  }
  let taskId: string | null = null
  let attempt = 0
  if (opts.taskId !== null) {
    const task = opts.store.getTask(opts.taskId)
    if (task.runId !== opts.runId) {
      throw new ValidationError(
        `task ${opts.taskId} belongs to run ${task.runId}, not ${opts.runId}; refusing to record verification evidence`,
      )
    }
    if (task.state !== 'verifying') {
      throw new ValidationError(
        `task ${opts.taskId} is '${task.state}'; only a task in 'verifying' can be verified`,
      )
    }
    taskId = task.id
    attempt = task.attempt
    // A previous attempt of this same verification may have been interrupted
    // (crash, Ctrl-C, engine death). Retire its rows so a fresh run is a clean,
    // complete evidence set; do not delete history and do not bump the task
    // attempt just to make the gate pass.
    opts.store.supersedeVerificationChecks(task.id, attempt)
  }
  const results: VerificationCheckResult[] = []
  let firstBefore: WorkspaceEvidence | null = null
  let lastAfter: WorkspaceEvidence | null = null
  mkdirSync(opts.artifactsDir, { recursive: true })

  const executor = opts.executor ?? createVerificationExecutor()
  const availability = executor.availability ?? { available: true, reason: null }
  let snapshot: string | null = null
  let snapshotError: string | null = null
  if (availability.available) {
    try {
      snapshot = createVerificationSnapshot(opts.cwd)
    } catch (error) {
      // A failed snapshot is an infrastructure refusal: every check fails
      // closed and nothing is executed on the host.
      snapshotError = error instanceof Error ? error.message : String(error)
    }
  }
  const refusal = !availability.available
    ? availability.reason ?? 'verification isolation is unavailable'
    : snapshotError

  try {
    for (const check of opts.checks) {
      // Capture evidence per check: a check that moves HEAD (or rewrites the
      // worktree) must not be able to lend its result to a different revision.
      const before = await captureWorkspaceEvidence(opts.cwd)
      const row = opts.store.createVerificationCheck({
        projectId: opts.projectId,
        runId: opts.runId,
        taskId,
        attempt,
        name: check.name,
        command: check.command,
        cwd: opts.cwd,
        workspaceId: opts.workspaceId,
        evidenceKind: before.kind,
        revision: before.revision,
        worktreeDirty: before.worktreeDirty,
        worktreeFingerprint: before.worktreeFingerprint,
      })
      const started = now()
      let status: 'passed' | 'failed' = 'failed'
      let exitCode: number | null = null
      let note: string | null = null
      let stdout = ''
      let stderr = ''
      let executorId = executor.id

      const denied = deniedCommandReason(check.command)
      if (denied !== null) {
        note = denied
        stderr = denied
      } else if (refusal !== null || snapshot === null) {
        note = `verification isolation is unavailable: ${refusal ?? 'no disposable snapshot'}`
        stderr = note
      } else {
        try {
          const res = await executor.run({
            command: check.command,
            cwd: snapshot,
            workspaceRoot: snapshot,
            env: {},
            timeoutMs,
            maxOutputBytes,
            network: 'none',
          })
          executorId = res.executor
          exitCode = res.exitCode
          stdout = res.stdout
          stderr = res.stderr
          if (res.timedOut) {
            note = `check timed out after ${String(timeoutMs)}ms`
          } else if (res.exitCode === 0) {
            status = 'passed'
          } else if (res.exitCode === null) {
            note = 'check failed to start'
          } else {
            note = `exit code ${String(res.exitCode)}`
          }
        } catch (error) {
          note = `verification isolation is unavailable: ${error instanceof Error ? error.message : String(error)}`
          stderr = note
        }
      }

      const durationMs = now() - started
      const artifacts = writeCheckArtifacts(opts.artifactsDir, row.id, stdout, stderr)
      opts.store.setVerificationCheckResult(row.id, {
        status,
        exitCode,
        stdoutArtifact: artifacts.stdout,
        stderrArtifact: artifacts.stderr,
        durationMs,
        executor: executorId,
      })
      const after = await captureWorkspaceEvidence(opts.cwd)
      opts.store.setVerificationCheckPostEvidence(row.id, {
        postEvidenceKind: after.kind,
        postRevision: after.revision,
        postWorktreeDirty: after.worktreeDirty,
        postWorktreeFingerprint: after.worktreeFingerprint,
      })
      if (firstBefore === null) firstBefore = before
      lastAfter = after
      const payload: JsonValue = {
        checkId: row.id,
        name: check.name,
        status,
        exitCode,
        durationMs,
        executor: executorId,
        ...(note !== null ? { note } : {}),
        attempt,
        ...(before.revision !== null ? { revision: before.revision } : {}),
        ...(after.revision !== null ? { postRevision: after.revision } : {}),
      }
      opts.store.appendEvent({
        projectId: opts.projectId,
        runId: opts.runId,
        taskId,
        type: 'verification.run',
        payload,
      })
      results.push({ checkId: row.id, name: check.name, status, exitCode, durationMs, note, executor: executorId })
    }
  } finally {
    if (snapshot !== null) rmSync(snapshot, { recursive: true, force: true })
  }

  const before = firstBefore ?? NO_EVIDENCE
  const after = lastAfter ?? NO_EVIDENCE
  return {
    runId: opts.runId,
    taskId,
    attempt,
    results,
    allPassed: results.every((r) => r.status === 'passed'),
    evidence: {
      kind: before.kind,
      available: before.available,
      revision: before.revision,
      worktreeDirty: before.worktreeDirty,
      worktreeFingerprint: before.worktreeFingerprint,
      postKind: after.kind,
      postRevision: after.revision,
      postWorktreeDirty: after.worktreeDirty,
      postWorktreeFingerprint: after.worktreeFingerprint,
    },
  }
}

function writeCheckArtifacts(
  dir: string,
  checkId: string,
  stdout: string,
  stderr: string,
): { stdout: string | null; stderr: string | null } {
  const stdoutPath = stdout.length > 0 ? join(dir, `${checkId}.stdout.txt`) : null
  const stderrPath = stderr.length > 0 ? join(dir, `${checkId}.stderr.txt`) : null
  if (stdoutPath !== null) writeFileSync(stdoutPath, stdout)
  if (stderrPath !== null) writeFileSync(stderrPath, stderr)
  return { stdout: stdoutPath, stderr: stderrPath }
}

export interface TaskVerdict {
  taskId: string
  /** The outcome state: `completed` or `failed` — never anything else. */
  state: 'completed' | 'failed'
  passed: boolean
  summary: string
}

/**
 * Return why a set of same-attempt evidence rows cannot support a verdict, or
 * null when they are internally consistent.
 *
 * A verdict is only ever allowed on evidence that says exactly what was
 * checked and where:
 * - the evidence kind is explicit (NULL is a legacy row, not "non-Git");
 * - a Git snapshot has a complete revision, dirty state, fingerprint, post
 *   revision/fingerprint and executor identity;
 * - every check saw the same HEAD and the same byte-level worktree state, and
 *   no check moved either one;
 * - a capture failure is never downgraded to non-Git.
 *
 * `requireGit` is set for a task with a Pluton-managed (Git) checkout, and for
 * integration: a non-Git directory cannot attest a Git branch.
 */
export interface VerificationEvidenceRules {
  requireGit?: boolean
}

export function verificationEvidenceProblem(
  checks: VerificationCheckRecord[],
  rules: VerificationEvidenceRules = {},
): string | null {
  if (checks.length === 0) return 'no verification checks were recorded for the current attempt'
  if (checks.some((c) => c.supersededAt !== null)) {
    return 'superseded verification evidence cannot authorize a verdict'
  }

  const first = checks[0] as VerificationCheckRecord
  if (first.evidenceKind === null) {
    return 'verification evidence has no recorded kind (legacy or incomplete row); re-run verification'
  }
  if (checks.some((c) => c.evidenceKind !== first.evidenceKind)) {
    return 'checks recorded different kinds of workspace evidence'
  }
  if (first.evidenceKind === 'capture-failed') {
    return 'workspace evidence capture failed; a failed capture cannot authorize a verdict'
  }
  if (rules.requireGit === true && first.evidenceKind !== 'git') {
    return 'a Git-backed task has non-Git verification evidence; refusing to accept it'
  }

  if (first.evidenceKind === 'git') {
    const revisions = new Set<string>()
    const fingerprints = new Set<string>()
    const postFingerprints = new Set<string>()
    for (const check of checks) {
      if (check.postEvidenceKind !== 'git') {
        return `check '${check.name}' has no complete post-check Git evidence`
      }
      if (
        check.revision === null ||
        check.postRevision === null ||
        check.worktreeDirty === null ||
        check.postWorktreeDirty === null ||
        check.worktreeFingerprint === null ||
        check.postWorktreeFingerprint === null
      ) {
        return `check '${check.name}' has incomplete Git evidence (revision, dirty state or fingerprint is missing)`
      }
      if (check.executor === null || check.executor.trim() === '') {
        return `check '${check.name}' has no recorded executor identity`
      }
      if (check.revision !== check.postRevision) {
        return `check '${check.name}' moved HEAD from ${check.revision} to ${check.postRevision}`
      }
      revisions.add(check.revision)
      fingerprints.add(check.worktreeFingerprint)
      postFingerprints.add(check.postWorktreeFingerprint)
    }
    if (revisions.size > 1) return 'checks were run against different HEAD revisions'
    if (fingerprints.size > 1) return 'checks were run against different worktree states'
    if (postFingerprints.size > 1) return 'checks left the worktree in different states'
    const pre = [...fingerprints][0] as string
    const post = [...postFingerprints][0] as string
    if (pre !== post) return 'a verification check changed the worktree after it was checked'
    return null
  }

  // Explicit non-Git evidence: the absence of a revision is only valid when
  // the capture actually proved there is no Git metadata.
  for (const check of checks) {
    if (check.postEvidenceKind !== 'non-git') {
      return `check '${check.name}' has no complete post-check non-Git evidence`
    }
    if (
      check.revision !== null ||
      check.worktreeDirty !== null ||
      check.worktreeFingerprint !== null ||
      check.postRevision !== null ||
      check.postWorktreeDirty !== null ||
      check.postWorktreeFingerprint !== null
    ) {
      return `check '${check.name}' mixes non-Git evidence with Git fields`
    }
    if (check.executor === null || check.executor.trim() === '') {
      return `check '${check.name}' has no recorded executor identity`
    }
  }
  return null
}

export interface ApplyVerificationOptions {
  diffText?: string
  changedFiles?: string[]
  maxRepairAttempts?: number
  verifier?: IndependentVerifier
}

/**
 * Apply the verification verdict for one task from its durable evidence rows.
 * Refuses when the task is not `verifying` or when no check was ever recorded
 * — no evidence, no verdict. `pending` checks count as unmet: an unrun check
 * can never be green.
 */
export function applyTaskVerificationVerdict(
  store: Store,
  taskId: string,
  opts?: ApplyVerificationOptions,
): TaskVerdict {
  const task = store.getTask(taskId)
  if (task.state !== 'verifying') {
    throw new ValidationError(
      `task ${taskId} is '${task.state}'; only a task in 'verifying' can receive a verification verdict`,
    )
  }
  const checks = store.listCurrentVerificationChecksByTaskAttempt(taskId, task.attempt)
  if (checks.length === 0) {
    throw new ValidationError(
      `no verification checks were recorded for task ${taskId} attempt ${String(task.attempt)}; refusing to complete it (no evidence, no green)`,
    )
  }
  for (const check of checks) {
    if (check.taskId !== taskId || check.runId !== task.runId || check.attempt !== task.attempt) {
      throw new ValidationError(
        `verification check ${check.id} is bound to ${check.taskId ?? '(no task)'}/${check.runId} attempt ${String(check.attempt)}, not task ${taskId} run ${task.runId} attempt ${String(task.attempt)}; refusing to apply a verdict`,
      )
    }
  }
  const run = store.getRun(task.runId)
  const workspace = store.getWorkspaceByTask(taskId)
  const unmet = checks.filter((c) => c.status !== 'passed')

  const verifier = opts?.verifier ?? new IndependentVerifier()
  const report = verifier.verifyCriteria(
    run.goal,
    task.acceptanceCriteria,
    {
      changedFiles: opts?.changedFiles ?? [],
      gitDiff: opts?.diffText ?? '',
      checkResults: checks.map((c) => ({
        name: c.name,
        command: c.command,
        status: c.status === 'passed' ? 'passed' : 'failed',
        exitCode: c.exitCode,
      })),
      workerClaims:
        typeof task.result === 'object' && task.result !== null
          ? (task.result as { outcome?: string; summary?: string })
          : undefined,
    },
  )

  if (unmet.length === 0 && report.verdict === 'verified') {
    const evidenceProblem = verificationEvidenceProblem(checks, { requireGit: workspace !== null })
    if (evidenceProblem !== null) {
      throw new ValidationError(
        `verification evidence for task ${taskId} attempt ${String(task.attempt)} is incomplete or inconsistent: ${evidenceProblem}; refusing to apply a verdict`,
      )
    }
  }

  store.recordVerification({
    runId: task.runId,
    taskId,
    verdict: report.verdict,
    criteria: report.criteria as unknown as JsonValue,
    tamper: { tampered: report.tamperDetected, reasons: report.tamperReasons } as JsonValue,
    evidence: { sensitiveExposure: report.sensitiveExposure, summary: report.summary } as JsonValue,
  })

  if (report.tamperDetected) {
    store.appendEvent({
      projectId: run.projectId,
      runId: task.runId,
      taskId,
      type: 'verification.tamper_detected',
      payload: { reasons: report.tamperReasons },
    })
    const failure: JsonValue = { code: 'tamper_detected', reasons: report.tamperReasons }
    store.setTaskState(taskId, 'failed', { failure })
    return {
      taskId,
      state: 'failed',
      passed: false,
      summary: 'Verification rejected: test tampering detected',
    }
  }

  if (report.sensitiveExposure.length > 0) {
    store.appendEvent({
      projectId: run.projectId,
      runId: task.runId,
      taskId,
      type: 'verification.sensitive_exposure',
      payload: { files: report.sensitiveExposure },
    })
    const failure: JsonValue = { code: 'sensitive_exposure', files: report.sensitiveExposure }
    store.setTaskState(taskId, 'failed', { failure })
    return {
      taskId,
      state: 'failed',
      passed: false,
      summary: 'Verification rejected: sensitive file exposure',
    }
  }

  if (unmet.length === 0 && report.verdict === 'verified') {
    const prior =
      task.result !== null && typeof task.result === 'object' && !Array.isArray(task.result)
        ? (task.result as Record<string, JsonValue>)
        : {}
    const latestPost = [...checks].reverse().find((c) => c.postWorktreeFingerprint !== null)
    store.setTaskState(taskId, 'completed', {
      result: {
        ...prior,
        verifiedBy: checks.map((c) => c.id),
        verificationSummary: report.summary,
        verificationEvidence: {
          attempt: task.attempt,
          revision: checks[0]?.revision ?? null,
          postRevision: checks[0]?.postRevision ?? null,
          worktreeFingerprint: checks[0]?.worktreeFingerprint ?? null,
          postWorktreeFingerprint: latestPost?.postWorktreeFingerprint ?? null,
          checks: checks.length,
        },
      },
    })
    store.appendEvent({
      projectId: run.projectId,
      runId: task.runId,
      taskId,
      type: 'task.completed',
      payload: { via: 'verification', checks: checks.length, summary: report.summary },
    })
    return {
      taskId,
      state: 'completed',
      passed: true,
      summary: `${String(checks.length)}/${String(checks.length)} checks passed (${report.summary})`,
    }
  }

  // Bounded repair cycle
  const maxRepairs = opts?.maxRepairAttempts ?? 0
  if (maxRepairs > 0 && task.attempt < maxRepairs) {
    const failure: JsonValue = {
      code: 'verification_failed',
      checks: unmet.map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
      unverifiedCriteria: report.criteria
        .filter((c) => c.status !== 'verified')
        .map((c) => ({ criterion: c.criterion, reason: c.evidence })),
    }
    store.setTaskState(taskId, 'queued', { attempt: task.attempt + 1, failure })
    store.appendEvent({
      projectId: run.projectId,
      runId: task.runId,
      taskId,
      type: 'verification.repair_scheduled',
      payload: { attempt: task.attempt + 1, maxRepairs, failedChecks: unmet.map((c) => c.name) },
    })
    return {
      taskId,
      state: 'failed',
      passed: false,
      summary: `Verification failed (${unmet.length} checks unmet); repair attempt ${task.attempt + 1} of ${maxRepairs} scheduled`,
    }
  }

  const failure: JsonValue = {
    code: 'verification_failed',
    checks: unmet.map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
  }
  store.setTaskState(taskId, 'failed', { failure })
  store.appendEvent({
    projectId: run.projectId,
    runId: task.runId,
    taskId,
    type: 'task.failed',
    payload: { code: 'verification_failed', failedChecks: unmet.map((c) => c.name) },
  })
  return {
    taskId,
    state: 'failed',
    passed: false,
    summary: `${String(unmet.length)} of ${String(checks.length)} checks not passed`,
  }
}

export interface RunVerdict {
  runId: string
  state: RunState
  outcome: 'success' | 'failure' | 'redispatched'
  redispatchedTasks?: string[]
}

/**
 * Close a `verifying` run from durable records only:
 * - If downstream tasks are unblocked by verification, transitions run back to `active` for re-dispatch
 * - If open tasks are permanently blocked (e.g. dependency failed), transitions run to `failed`
 * - If all tasks terminal: `completed` when every task completed, `failed` when any did not
 * - When tasks are still actively verifying, leaves the run in `verifying` (returns null)
 */
export function finalizeRunVerdict(store: Store, runId: string): RunVerdict | null {
  const run = store.getRun(runId)
  if (run.state !== 'verifying') return null
  const tasks = store.listTasks(runId)
  if (tasks.length === 0) return null
  const open = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state))
  if (open.length > 0) {
    const ready = store.listReadyTasks(runId)
    if (ready.length > 0) {
      // Re-dispatch: downstream tasks have been unblocked by successful verification!
      store.setRunState(runId, 'active')
      const unblockedTaskIds = ready.map((t) => t.id)
      store.appendEvent({
        projectId: run.projectId,
        runId,
        type: 'run.redispatched',
        payload: {
          via: 'verification',
          unblockedTaskIds,
          count: unblockedTaskIds.length,
        },
      })
      return {
        runId,
        state: 'active',
        outcome: 'redispatched',
        redispatchedTasks: unblockedTaskIds,
      }
    }

    // If any tasks are still in verifying or another active state, remain in verifying
    const stillVerifying = open.some((t) => t.state === 'verifying')
    if (stillVerifying) return null

    // If all open tasks are permanently blocked (none ready, none verifying), fail the run
    const state: RunState = 'failed'
    store.setRunState(runId, state, {
      finalSummary: 'verification failed; downstream tasks blocked',
    })
    store.appendEvent({
      projectId: run.projectId,
      runId,
      type: 'run.finished',
      payload: { outcome: 'failure', via: 'verification_blocked', openTasks: open.length },
    })
    return { runId, state, outcome: 'failure' }
  }

  const allCompleted = tasks.every((t) => t.state === 'completed')
  const cancelledTaskIds = tasks.filter((t) => t.state === 'cancelled').map((t) => t.id)

  // Defense in depth: a task may be `completed` while its current attempt's
  // evidence is stale (e.g. passed on attempt 0, re-run on attempt 1 without a
  // verdict). A run must never close green on evidence that does not attest the
  // work currently in the checkout.
  const evidenceProblems: string[] = []
  if (allCompleted) {
    for (const task of tasks) {
      const workspace = store.getWorkspaceByTask(task.id)
      const current = store.listCurrentVerificationChecksByTaskAttempt(task.id, task.attempt)
      if (current.length === 0) {
        // A task with a Pluton-managed checkout is Git-backed and must have
        // current-attempt evidence. A task that was verified on an earlier
        // attempt must also not close green on a re-run with no evidence at
        // all: absence is only tolerated for a task where verification was
        // never configured and there is no checkout to attest.
        const everVerified = store.listVerificationChecksByTask(task.id).length > 0
        if (workspace !== null || everVerified) {
          evidenceProblems.push(`task ${task.id} attempt ${String(task.attempt)}: no verification evidence for the current attempt`)
        }
        continue
      }
      const problem = verificationEvidenceProblem(current, { requireGit: workspace !== null })
      if (problem !== null) {
        evidenceProblems.push(`task ${task.id} attempt ${String(task.attempt)}: ${problem}`)
        continue
      }
      const failed = current.filter((c) => c.status !== 'passed')
      if (failed.length > 0) {
        evidenceProblems.push(
          `task ${task.id} attempt ${String(task.attempt)}: ${String(failed.length)} check(s) not passed (${failed.map((c) => c.name).join(', ')})`,
        )
      }
    }
  }

  const state: RunState = allCompleted && evidenceProblems.length === 0 ? 'completed' : 'failed'
  store.setRunState(runId, state, {
    // The manager's answer (persisted when the run entered `verifying`) is the
    // run's final summary — the verification label only fills in when no
    // answer was ever produced.
    finalSummary:
      allCompleted && evidenceProblems.length === 0
        ? (run.finalSummary ?? `${String(tasks.length)}/${String(tasks.length)} tasks verified`)
        : evidenceProblems.length > 0
          ? 'verification evidence is missing or invalid; refusing to complete the run'
          : cancelledTaskIds.length > 0
            ? `verification failed; ${String(cancelledTaskIds.length)} task(s) were cancelled`
            : 'verification failed',
  })
  store.appendEvent({
    projectId: run.projectId,
    runId,
    type: 'run.finished',
    payload: {
      outcome: allCompleted && evidenceProblems.length === 0 ? 'success' : 'failure',
      via: evidenceProblems.length > 0 ? 'verification_evidence' : 'verification',
      tasks: tasks.length,
      ...(cancelledTaskIds.length > 0 ? { cancelledTasks: cancelledTaskIds.length } : {}),
      ...(evidenceProblems.length > 0 ? { evidenceProblems } : {}),
    },
  })
  return {
    runId,
    state,
    outcome: allCompleted && evidenceProblems.length === 0 ? 'success' : 'failure',
  }
}
