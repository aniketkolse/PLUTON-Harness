import { describe, expect, it } from 'vitest'
import { FileLeaseManager } from '../../src/orchestrator/lease-manager.ts'
import { CircuitBreaker } from '../../src/orchestrator/circuit-breaker.ts'
import { UsageLedger } from '../../src/orchestrator/usage-ledger.ts'
import { IndependentVerifier, type VerificationEvidence } from '../../src/verify/independent.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { openDatabase } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import { applyTaskVerificationVerdict } from '../../src/verify/runner.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import { loadConfig } from '../../src/config/load.ts'
import { writeFileSync } from 'node:fs'

const TEST_CONFIG = `version: 1
project:
  name: rel-test
  repository: .
  default_branch: main
  verification: []
runtime:
  max_concurrent_workers: 2
  max_tasks_per_run: 10
  max_delegation_depth: 3
  max_run_minutes: 30
  default_task_minutes: 10
  approval_timeout_minutes: 60
  max_child_tasks_per_task: 5
  max_team_size: 5
  max_prompt_chars: 10000
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock-1
    approval_mode: autonomous-bounded
    workspace_policy: coordinator-read-only
    permissions:
      - task.create
      - task.delegate
      - scope.declare
      - scope.release
  coder:
    display_name: Coder
    role: coder
    engine: mock
    model: mock-1
    approval_mode: autonomous-bounded
    workspace_policy: isolated-task-checkout
    permissions:
      - project.read
      - project.write
      - scope.declare
      - scope.release
      - diff.inspect
  tester:
    display_name: Tester
    role: tester
    engine: mock
    model: mock-1
    approval_mode: autonomous-bounded
    workspace_policy: isolated-task-checkout
    permissions:
      - project.read
      - tests.run
      - scope.declare
      - scope.release
`

function createTestContext() {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-rel-'))
  writeFileSync(join(dir, 'pluton.yaml'), TEST_CONFIG)
  const loaded = loadConfig(dir)
  const { store, projectId } = bootstrapStore(loaded)
  return { dir, store, projectId }
}

describe('Milestone 3: Multi-Agent Reliability & Verified Completion', () => {
  it('detects write conflicts, enforces lockfile safety, and safely releases leases', () => {
    const leases = new FileLeaseManager()

    // Coder acquires write scope on auth files
    const r1 = leases.declareScope('run-1', 'task-1', 'coder', ['src/auth/login.ts', 'src/auth/token.ts'])
    expect(r1.conflicts).toHaveLength(0)
    expect(r1.acquired).toEqual(['src/auth/login.ts', 'src/auth/token.ts'])

    // Another task tries to touch the same file -> rejected with actionable explanation
    const r2 = leases.declareScope('run-1', 'task-2', 'tester', ['src/auth/login.ts', 'src/util.ts'])
    expect(r2.conflicts).toHaveLength(1)
    expect(r2.conflicts[0]?.heldByTaskId).toBe('task-1')
    expect(r2.conflicts[0]?.reason).toContain("held by task task-1 (coder)")
    expect(r2.acquired).toHaveLength(0)

    // Dependency files cannot be modified concurrently
    leases.declareScope('run-1', 'task-3', 'coder', ['package.json'])
    const rDep = leases.declareScope('run-1', 'task-4', 'tester', ['package-lock.json'])
    expect(rDep.conflicts).toHaveLength(1)
    expect(rDep.conflicts[0]?.reason).toContain('concurrent dependency-file modification rejected')

    // Release task-1 leases
    const released = leases.releaseScope('task-1')
    expect(released).toContain('src/auth/login.ts')
    expect(released).toContain('src/auth/token.ts')

    // Now task-2 can acquire it
    const r3 = leases.declareScope('run-1', 'task-2', 'tester', ['src/auth/login.ts'])
    expect(r3.conflicts).toHaveLength(0)
  })

  it('detects test tampering and sensitive file exposure in independent verification', () => {
    const verifier = new IndependentVerifier()

    // 1. Test tampering: added .skip to bypass failure
    const tamperedDiff = `
diff --git a/tests/auth.test.ts b/tests/auth.test.ts
@@ -5,3 +5,3 @@
-test('validates password', () => {
+test.skip('validates password', () => {
`
    const tamperEvidence: VerificationEvidence = {
      changedFiles: ['tests/auth.test.ts'],
      gitDiff: tamperedDiff,
      checkResults: [{ name: 'vitest', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
      workerClaims: { outcome: 'success', summary: 'all tests green' },
    }
    const report1 = verifier.verifyCriteria('Auth security', ['Password validated'], tamperEvidence)
    expect(report1.verdict).toBe('failed')
    expect(report1.tamperDetected).toBe(true)
    expect(report1.tamperReasons[0]).toContain("Disabled/skipped test added in 'tests/auth.test.ts'")

    // 2. Sensitive exposure: .env file modified
    const secretEvidence: VerificationEvidence = {
      changedFiles: ['.env', 'src/app.ts'],
      gitDiff: '+API_KEY=secret_123',
      checkResults: [{ name: 'vitest', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
    }
    const report2 = verifier.verifyCriteria('App setup', ['App configured'], secretEvidence)
    expect(report2.verdict).toBe('failed')
    expect(report2.sensitiveExposure).toContain('.env')

    // 3. Legitimate clean completion
    const cleanEvidence: VerificationEvidence = {
      changedFiles: ['src/math.ts', 'tests/math.test.ts'],
      gitDiff: '+export const multiply = (a, b) => a * b\n+test("multiply", () => expect(multiply(2, 3)).toBe(6))',
      checkResults: [{ name: 'vitest', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
    }
    const report3 = verifier.verifyCriteria('Math module', ['multiply is tested'], cleanEvidence)
    expect(report3.verdict).toBe('verified')
    expect(report3.tamperDetected).toBe(false)
  })

  it('supports bounded repair cycles during task verification failure', () => {
    const { store, projectId, dir } = createTestContext()
    const run = store.createRun({
      projectId,
      goal: 'repair cycle goal',
      origin: 'cli',
      requestedBy: 'test',
      acceptanceCriteria: ['Feature works'],
      managerMuseId: 'manager',
      budget: { maxConcurrentWorkers: 2, maxTasks: 5, maxDelegationDepth: 1, maxRunMinutes: 10, defaultTaskMinutes: 5 },
    })

    const task = admitTask(
      store,
      {
        runId: run.id,
        parentTaskId: null,
        title: 'Fix issue',
        brief: 'fix bug',
        acceptanceCriteria: ['Feature works'],
        assigneeMuseId: 'coder',
      },
      { maxChildrenPerTask: 2 },
    )
    store.setRunState(run.id, 'active')
    store.setRunState(run.id, 'verifying')
    store.setTaskState(task.id, 'admitted')
    store.setTaskState(task.id, 'running')
    store.setTaskState(task.id, 'verifying')

    // Record a failed check
    const check = store.createVerificationCheck({
      projectId,
      runId: run.id,
      taskId: task.id,
      name: 'npm test',
      command: ['npm', 'test'],
      cwd: dir,
      workspaceId: null,
    })
    store.setVerificationCheckResult(check.id, {
      status: 'failed',
      exitCode: 1,
    })

    // Attempt 0 < maxRepairAttempts (2) -> schedules repair and queues task
    const v1 = applyTaskVerificationVerdict(store, task.id, { maxRepairAttempts: 2 })
    expect(v1.passed).toBe(false)
    expect(v1.summary).toContain('repair attempt 1 of 2 scheduled')

    const tAfter1 = store.getTask(task.id)
    expect(tAfter1.state).toBe('queued')
    expect(tAfter1.attempt).toBe(1)

    // Second cycle runs and fails again
    store.setTaskState(task.id, 'admitted')
    store.setTaskState(task.id, 'running')
    store.setTaskState(task.id, 'verifying')
    const v2 = applyTaskVerificationVerdict(store, task.id, { maxRepairAttempts: 2 })
    expect(v2.passed).toBe(false)
    expect(v2.summary).toContain('repair attempt 2 of 2 scheduled')

    // Third cycle reaches maxRepairs (2) -> marks task failed permanently
    store.setTaskState(task.id, 'admitted')
    store.setTaskState(task.id, 'running')
    store.setTaskState(task.id, 'verifying')
    const v3 = applyTaskVerificationVerdict(store, task.id, { maxRepairAttempts: 2 })
    expect(v3.passed).toBe(false)
    const tFinal = store.getTask(task.id)
    expect(tFinal.state).toBe('failed')
  })

  it('trips circuit breaker upon repeated identical failures and stops unproductive retries', () => {
    const cb = new CircuitBreaker({ maxRetriesPerTask: 5, consecutiveIdenticalFailuresThreshold: 2 })
    const err = { code: 'E_SYNTAX', message: 'Unexpected token at line 12' }

    const r1 = cb.recordFailure('task-x', err)
    expect(r1.shouldRetry).toBe(true)
    expect(cb.isTripped()).toBe(false)

    // Consecutive identical error
    const r2 = cb.recordFailure('task-x', err)
    expect(r2.shouldRetry).toBe(false)
    expect(cb.isTripped()).toBe(true)
    expect(cb.getTripReason()).toContain('consecutive identical failures')
  })

  it('tracks shared token and cost budget across muses in run ledger', () => {
    const ledger = new UsageLedger('run-ledger', { maxRunCostUsd: 0.05 })

    ledger.record({
      museId: 'coder',
      taskId: 't1',
      inputTokens: 1000,
      outputTokens: 400,
      cachedTokens: 100,
      costUsd: 0.02,
    })

    const mid = ledger.getSummary()
    expect(mid.totalInputTokens).toBe(1000)
    expect(mid.totalOutputTokens).toBe(400)
    expect(mid.hardLimitExceeded).toBe(false)

    const over = ledger.record({
      museId: 'tester',
      taskId: 't2',
      inputTokens: 2000,
      outputTokens: 800,
      cachedTokens: 200,
      costUsd: 0.04,
    })

    expect(over.withinBudget).toBe(false)
    expect(over.limitExceededReason).toContain('Run total cost ($0.060) exceeded limit ($0.050)')
  })

  it('recovers interrupted run leases without duplicating completed side effects', () => {
    const leases = new FileLeaseManager()
    leases.declareScope('run-rec', 'task-done', 'coder', ['src/done.ts'])
    leases.declareScope('run-rec', 'task-orphaned', 'coder', ['src/orphaned.ts'])
    leases.declareScope('run-rec', 'task-active', 'coder', ['src/active.ts'])

    // Only task-active is still running
    leases.recoverLeases(new Set(['task-active']))

    const active = leases.listActiveLeases('run-rec')
    expect(active).toHaveLength(1)
    expect(active[0]?.taskId).toBe('task-active')
    expect(active[0]?.path).toBe('src/active.ts')
  })
})
