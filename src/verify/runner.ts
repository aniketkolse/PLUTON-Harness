import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VerificationCheckConfig } from '../config/schema.ts'
import { ValidationError } from '../domain/errors.ts'
import type { JsonValue } from '../domain/models.ts'
import { TERMINAL_TASK_STATES, type RunState } from '../domain/state.ts'
import type { Store } from '../store/store.ts'
import { run } from '../util/exec.ts'
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
}

export interface VerificationRunReport {
  runId: string
  taskId: string | null
  results: VerificationCheckResult[]
  allPassed: boolean
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
  const results: VerificationCheckResult[] = []
  mkdirSync(opts.artifactsDir, { recursive: true })

  for (const check of opts.checks) {
    const row = opts.store.createVerificationCheck({
      projectId: opts.projectId,
      runId: opts.runId,
      taskId: opts.taskId,
      name: check.name,
      command: check.command,
      cwd: opts.cwd,
      workspaceId: opts.workspaceId,
    })
    const started = now()
    let status: 'passed' | 'failed' = 'failed'
    let exitCode: number | null = null
    let note: string | null = null
    let stdout = ''
    let stderr = ''

    const denied = deniedCommandReason(check.command)
    if (denied !== null) {
      note = denied
      stderr = denied
    } else {
      const res = await run(check.command, { cwd: opts.cwd, timeoutMs, maxOutputBytes })
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
    }

    const durationMs = now() - started
    const artifacts = writeCheckArtifacts(opts.artifactsDir, row.id, stdout, stderr)
    opts.store.setVerificationCheckResult(row.id, {
      status,
      exitCode,
      stdoutArtifact: artifacts.stdout,
      stderrArtifact: artifacts.stderr,
      durationMs,
    })
    const payload: JsonValue = {
      checkId: row.id,
      name: check.name,
      status,
      exitCode,
      durationMs,
      ...(note !== null ? { note } : {}),
    }
    opts.store.appendEvent({
      projectId: opts.projectId,
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'verification.run',
      payload,
    })
    results.push({ checkId: row.id, name: check.name, status, exitCode, durationMs, note })
  }

  return {
    runId: opts.runId,
    taskId: opts.taskId,
    results,
    allPassed: results.every((r) => r.status === 'passed'),
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
  const checks = store.listVerificationChecksByTask(taskId)
  if (checks.length === 0) {
    throw new ValidationError(
      `no verification checks were recorded for task ${taskId}; refusing to complete it (no evidence, no green)`,
    )
  }
  const run = store.getRun(task.runId)
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
    store.setTaskState(taskId, 'completed', {
      result: { ...prior, verifiedBy: checks.map((c) => c.id), verificationSummary: report.summary },
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
  const state: RunState = allCompleted ? 'completed' : 'failed'
  store.setRunState(runId, state, {
    finalSummary: allCompleted
      ? `${String(tasks.length)}/${String(tasks.length)} tasks verified`
      : 'verification failed',
  })
  store.appendEvent({
    projectId: run.projectId,
    runId,
    type: 'run.finished',
    payload: { outcome: allCompleted ? 'success' : 'failure', via: 'verification', tasks: tasks.length },
  })
  return { runId, state, outcome: allCompleted ? 'success' : 'failure' }
}
