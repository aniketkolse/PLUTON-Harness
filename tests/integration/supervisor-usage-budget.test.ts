import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeConfigSchema } from '../../src/config/schema.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import { MockEngineAdapter, type MockScriptStep } from '../../src/engines/mock/adapter.ts'
import { CircuitBreaker } from '../../src/orchestrator/circuit-breaker.ts'
import { supervisorSettingsFromRuntime, usageBudgetsFromRuntime } from '../../src/orchestrator/run-setup.ts'
import { RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { UsageLedger } from '../../src/orchestrator/usage-ledger.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { ToolBridgeLimits } from '../../src/tools/bridge.ts'

/**
 * PR-1 integration: usage budgets and retry limits flow from the runtime
 * config section through the `run-setup` mapping (exactly as
 * `createRunSupervisor` wires them) into a live supervisor driving a scripted
 * mock engine. Budget breaches interrupt the session and stay visible
 * (durable `run_usage` rows + a diagnostic), retry counts follow the
 * configured `max_retries_per_task` — never an implicit default.
 */

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 5,
  maxBriefChars: 10_000,
  maxTeamSize: 8,
  maxToolResultChars: 120_000,
  defaultWaitSeconds: 5,
  waitHeartbeatSeconds: 15,
  approvalTtlMinutes: 60,
  maxRevisionsPerTask: 1,
}

const WORKER_PERMISSIONS = ['task.delegate', 'task.inspect', 'result.collect', 'diff.inspect']

interface World {
  store: Store
  runId: string
  /** Task ids created by the manager through the bridge, in creation order. */
  created: string[]
  /** Lines the supervisor emitted through its diagnostic channel. */
  diagnostics: string[]
  supervisor: RunSupervisor
  settleTools: () => Promise<void>
}

function makeWorld(
  opts: {
    /** Overrides parsed by `runtimeConfigSchema` and mapped like production. */
    runtime?: Record<string, unknown>
    workerScript?: MockScriptStep[]
    /** Injected to isolate `max_retries_per_task` from the breaker's own bounds. */
    circuitBreaker?: CircuitBreaker
  } = {},
): World {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-budget-'))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# project\n')

  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'usage-budget-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'manager',
      slug: 'manager',
      displayName: 'Manager',
      role: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: [...PERMISSIONS],
      approvalMode: 'autonomous-bounded',
      engineHome: '.pluton/engine-homes/manager',
    },
    {
      id: 'worker-a',
      slug: 'worker-a',
      displayName: 'Worker A',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model-a',
      instructionsFile: null,
      workspacePolicy: 'coordinator-read-only',
      permissions: WORKER_PERMISSIONS,
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker-a',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: 'ship the bounded work',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: ['budgets are enforced from config'],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })

  // The production chain: YAML object → schema defaults/bounds → mapper →
  // supervisor options (mirrors `createRunSupervisor`, run.ts:261–306).
  const runtime = runtimeConfigSchema.parse(opts.runtime ?? {})
  const budgets = usageBudgetsFromRuntime(runtime)
  const settings = supervisorSettingsFromRuntime(runtime)

  const created: string[] = []
  const diagnostics: string[] = []
  const ref: { supervisor: RunSupervisor | null; toolsError: unknown } = { supervisor: null, toolsError: null }
  let toolsPromise: Promise<void> = Promise.resolve()
  const adapters = new Map<string, MockEngineAdapter>()
  adapters.set('worker-a', new MockEngineAdapter({ script: opts.workerScript ?? [{ delayMs: 5, outcome: 'success' }] }))
  adapters.set(
    'manager',
    new MockEngineAdapter({
      script: [{ delayMs: 150, text: 'plan', outcome: 'success' }],
      onPrompt: () => {
        const sup = ref.supervisor
        if (!sup || created.length > 0) return
        toolsPromise = (async () => {
          try {
            const res = await sup.managerBridge().call('task.create', {
              title: 'bounded work',
              brief: 'do the work within the configured budget',
              acceptanceCriteria: ['recorded'],
              assigneeMuseId: 'worker-a',
            })
            expect(res.ok).toBe(true)
            created.push((res.data as { task: { id: string } }).task.id)
          } catch (e) {
            ref.toolsError = e
          }
        })()
      },
    }),
  )

  const supervisor = new RunSupervisor({
    store,
    projectId: project.id,
    rootDir: dir,
    workspacesRoot: join(dir, '.pluton', 'workspaces'),
    runId: run.id,
    limits: LIMITS,
    maxConcurrentWorkers: settings.maxConcurrentWorkers,
    defaultTaskTimeoutMs: settings.defaultTaskTimeoutMs,
    runDeadlineMs: settings.runDeadlineMs,
    maxRetriesPerTask: settings.maxRetriesPerTask,
    ...(budgets !== undefined ? { usageLedger: new UsageLedger(run.id, budgets, store) } : {}),
    ...(opts.circuitBreaker !== undefined ? { circuitBreaker: opts.circuitBreaker } : {}),
    verificationConfigured: false,
    loopPollMs: 20,
    adapterFor: (muse: MuseRecord) => {
      const adapter = adapters.get(muse.id)
      if (!adapter) throw new Error(`no mock adapter for muse ${muse.id}`)
      return adapter
    },
    diagnostic: (line) => diagnostics.push(line),
  })
  ref.supervisor = supervisor

  return {
    store,
    runId: run.id,
    created,
    diagnostics,
    supervisor,
    settleTools: async () => {
      await toolsPromise
      if (ref.toolsError !== null) throw ref.toolsError
    },
  }
}

/** A single usage event worth `usage`, then a delay the interrupt can cut short. */
function usageStep(
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
  delayMs = 50,
): MockScriptStep {
  return { events: [{ kind: 'usage', ...usage }], delayMs, outcome: 'success' }
}

function eventCount(store: Store, runId: string, type: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?').get(runId, type) as {
    n: number
  }
  return row.n
}

describe('RunSupervisor — configured usage budgets', () => {
  it('interrupts the session and records the breach when the run input-token budget is exceeded', async () => {
    const world = makeWorld({
      runtime: { max_run_input_tokens: 5_000 },
      workerScript: [usageStep({ inputTokens: 10_000, outputTokens: 250, costUsd: 0.5 })],
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(world.created).toHaveLength(1)
    const task = world.store.getTask(world.created[0] as string)
    // The over-budget usage event interrupted the turn: the scripted success
    // never landed, the honest outcome is `cancelled`.
    expect(task.state).toBe('cancelled')
    expect(out.taskCounts).toMatchObject({ cancelled: 1 })
    expect(out.taskCounts.completed ?? 0).toBe(0)

    // The breach is durable: the usage row is persisted for the run.
    const usage = world.store.getRunUsage(world.runId)
    expect(usage.totalInputTokens).toBe(10_000)
    expect(usage.perMuse['worker-a']?.inputTokens).toBe(10_000)
    expect(usage.perMuse['worker-a']?.costUsd).toBeCloseTo(0.5)

    // And it is visible, never silent.
    expect(
      world.diagnostics.some((line) => line.includes('usage budget exceeded') && line.includes('10000')),
    ).toBe(true)
  })

  it('lets the task complete when recorded usage stays within the configured budget', async () => {
    const world = makeWorld({
      runtime: { max_run_input_tokens: 10_000 },
      workerScript: [usageStep({ inputTokens: 10_000, outputTokens: 250, costUsd: 0.5 })],
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    const task = world.store.getTask(world.created[0] as string)
    expect(task.state).toBe('completed')
    expect(out.state).toBe('completed')
    expect(world.store.getRunUsage(world.runId).totalInputTokens).toBe(10_000)
    expect(world.diagnostics.some((line) => line.includes('usage budget exceeded'))).toBe(false)
  })

  it('enforces a per-Muse cost budget and names the Muse in the reason', async () => {
    const world = makeWorld({
      runtime: { max_muse_cost_usd: 0.1 },
      workerScript: [usageStep({ inputTokens: 100, outputTokens: 20, costUsd: 0.25 })],
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(world.store.getTask(world.created[0] as string).state).toBe('cancelled')
    expect(out.taskCounts).toMatchObject({ cancelled: 1 })
    expect(
      world.diagnostics.some((line) => line.includes('usage budget exceeded') && line.includes("Muse 'worker-a'")),
    ).toBe(true)
  })
})

describe('RunSupervisor — configured retry limits', () => {
  /** The breaker's own bounds must not mask the configured retry count under test. */
  const looseBreaker = (): CircuitBreaker =>
    new CircuitBreaker({ maxRetriesPerTask: 10, consecutiveIdenticalFailuresThreshold: 10 })

  it('honors max_retries_per_task: 0 — exactly one engine attempt, no retry event', async () => {
    const world = makeWorld({
      runtime: { max_retries_per_task: 0 },
      workerScript: [{ delayMs: 5, outcome: 'failure', text: 'boom' }],
      circuitBreaker: looseBreaker(),
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(eventCount(world.store, world.runId, 'task.started')).toBe(1)
    expect(eventCount(world.store, world.runId, 'task.retry_scheduled')).toBe(0)
    const task = world.store.getTask(world.created[0] as string)
    expect(task.state).toBe('failed')
    expect(task.attempt).toBe(0)
    expect(out.state).toBe('failed')
  })

  it('honors max_retries_per_task: 2 — two retries, then it stops trying', async () => {
    const world = makeWorld({
      runtime: { max_retries_per_task: 2 },
      workerScript: [{ delayMs: 5, outcome: 'failure', text: 'boom' }],
      circuitBreaker: looseBreaker(),
    })

    const out = await world.supervisor.runToCompletion()
    await world.settleTools()

    expect(eventCount(world.store, world.runId, 'task.started')).toBe(3)
    expect(eventCount(world.store, world.runId, 'task.retry_scheduled')).toBe(2)
    const task = world.store.getTask(world.created[0] as string)
    expect(task.state).toBe('failed')
    expect(task.attempt).toBe(2)
    expect(out.state).toBe('failed')
  })
})
