import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { installRunCancelSignals, requestRunCancel, runRun, type RunDeps } from '../../src/cli/commands/run.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { ConflictError, SandboxUnavailableError } from '../../src/domain/errors.ts'
import type { McpServerSpec } from '../../src/engines/contract/types.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'

/**
 * Integration: `pluton run` wiring — the manager Muse reaches the restricted
 * tool bridge over the real loopback HTTP transport (bearer token per session),
 * delegates to a worker, and the run finalizes from durable records. Also:
 * `--request-id` idempotency, the no-supervisor-muse CLI error path, and
 * native execution without Docker.
 */

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

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

const CONFIG_WITH_MANAGER = `version: 1
project:
  name: cli-run-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  network_policy: open
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
  heartbeat_seconds: 30
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.read
      - task.create
      - task.delegate
      - task.inspect
      - task.cancel
      - result.collect
      - diff.inspect
      - muse.propose_create
      - approval.request
      - run.stop
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
`

const CONFIG_WORKER_ONLY = `version: 1
project:
  name: cli-run-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
muses:
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
`

const CONFIG_CONTAINER = `version: 1
project:
  name: cli-run-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: docker
runtime:
  max_concurrent_workers: 2
  max_delegation_depth: 3
  max_tasks_per_run: 10
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: opencode
    model: test/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.read
      - task.create
      - task.delegate
      - task.inspect
      - task.cancel
      - result.collect
      - diff.inspect
      - muse.propose_create
      - approval.request
      - run.stop
  worker-a:
    display_name: Worker A
    role: coder
    engine: opencode
    model: test/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
  researcher:
    display_name: Researcher
    role: researcher
    engine: opencode
    model: test/model-a
    workspace_policy: read-only
    approval_mode: ask-always
    permissions:
      - project.read
      - diff.inspect
`

interface Fixture {
  dir: string
  ctx: ProjectContext
}

function makeProjectDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-cli-run-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), yaml)
  writeFileSync(join(dir, 'README.md'), '# cli-run project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  return dir
}

function projectContext(dir: string): ProjectContext {
  const loaded = loadConfig(dir)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

function makeProject(withManager: boolean): Fixture {
  const dir = makeProjectDir(withManager ? CONFIG_WITH_MANAGER : CONFIG_WORKER_ONLY)
  return { dir, ctx: projectContext(dir) }
}

function openSecondStore(dir: string): Store {
  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  return new Store(db)
}

interface AdapterWorld {
  deps: RunDeps
  spec: { value: McpServerSpec | null }
  settle: () => Promise<void>
  promptCounts: { manager: number; worker: number }
  createdTaskIds: string[]
}

/** Manager mock drives the HTTP bridge for real; worker mock just succeeds. */
function makeAdapters(): AdapterWorld {
  const spec: { value: McpServerSpec | null } = { value: null }
  const toolError: { value: unknown } = { value: null }
  const promptCounts = { manager: 0, worker: 0 }
  const createdTaskIds: string[] = []
  let toolsPromise: Promise<void> = Promise.resolve()

  const manager = new MockEngineAdapter({
    script: [{ delayMs: 700, text: 'planned and delegated', outcome: 'success' }],
    onStartSession: (req) => {
      spec.value = req.mcpServers?.[0] ?? null
    },
    onPrompt: () => {
      promptCounts.manager += 1
      const s = spec.value
      if (!s || s.kind !== 'http') return
      toolsPromise = (async () => {
        try {
          await driveBridge(s, createdTaskIds)
        } catch (e) {
          toolError.value = e
        }
      })()
    },
  })
  const worker = new MockEngineAdapter({
    script: [{ delayMs: 10, outcome: 'success' }],
    onPrompt: () => {
      promptCounts.worker += 1
    },
  })
  const adapters = new Map<string, MockEngineAdapter>([
    ['manager', manager],
    ['worker-a', worker],
  ])
  return {
    deps: {
      adapterFor: (muse) => {
        const adapter = adapters.get(muse.id)
        if (!adapter) throw new Error(`no mock adapter for muse ${muse.id}`)
        return adapter
      },
    },
    spec,
    promptCounts,
    createdTaskIds,
    settle: async () => {
      await toolsPromise
      if (toolError.value !== null) throw toolError.value
    },
  }
}

/** Speak MCP (minimal Streamable HTTP subset) to the Pluton tool bridge. */
async function driveBridge(
  spec: Extract<McpServerSpec, { kind: 'http' }>,
  createdTaskIds: string[],
): Promise<void> {
  let nextId = 1
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: spec.headers?.['Authorization'] ?? '',
  }
  const rpc = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined ? { params } : {}) }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cli-run-test', version: '0.0.0' },
  })
  expect(init['error']).toBeUndefined()

  const notified = await fetch(spec.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  expect(notified.status).toBe(202)

  const list = (await rpc('tools/list'))['result'] as { tools: { name: string }[] }
  expect(list.tools.some((t) => t.name === 'task.create')).toBe(true)

  const created = (await rpc('tools/call', {
    name: 'task.create',
    arguments: {
      title: 'T1',
      brief: 'do it well',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'worker-a',
    },
  }))['result'] as { isError: boolean; content: { type: string; text: string }[] }
  expect(created.isError).toBe(false)
  const task = JSON.parse(created.content[0]?.text ?? '{}') as { task: { id: string; state: string } }
  expect(task.task.state).toBe('queued')
  createdTaskIds.push(task.task.id)

  const waited = (await rpc('tools/call', {
    name: 'task.wait',
    arguments: { taskIds: [task.task.id], timeoutSeconds: 20 },
  }))['result'] as { isError: boolean; content: { type: string; text: string }[] }
  expect(waited.isError).toBe(false)
  const waitData = JSON.parse(waited.content[0]?.text ?? '{}') as { tasks: { state: string }[] }
  expect(waitData.tasks[0]?.state).toBe('completed')
}

describe('runRun — supervisor wired to the HTTP tool bridge', () => {
  it('drives the manager over the real HTTP bridge and completes the run', async () => {
    const { dir, ctx } = makeProject(true)
    const world = makeAdapters()

    const summary = await runRun(ctx, { goal: 'ship it', acceptance: ['recorded'] }, world.deps)
    await world.settle()

    expect(summary.state).toBe('completed')
    expect(summary.outcome).toBe('success')
    expect(summary.taskCounts).toEqual({ completed: 1 })
    expect(summary.unfinishedTasks).toEqual([])
    expect(summary.verificationPending).toBe(false)

    // The spec the manager received was the HTTP variant with a bearer token.
    expect(world.spec.value?.kind).toBe('http')
    const spec = world.spec.value as Extract<McpServerSpec, { kind: 'http' }>
    expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(spec.headers?.['Authorization']).toMatch(/^Bearer .+$/)

    // Durable truth: one run, one completed worker task, bridge calls audited.
    const store = openSecondStore(dir)
    const runs = store.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toBe('completed')
    const tasks = store.listTasks(summary.runId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe('completed')
    expect(tasks[0]?.assigneeMuseId).toBe('worker-a')
    const toolCalls = store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'tool.call'")
      .get(summary.runId) as { n: number }
    expect(toolCalls.n).toBeGreaterThanOrEqual(2) // task.create + task.wait through HTTP
  })

  it('re-running with the same --request-id returns the same run without re-driving it', async () => {
    const { dir, ctx } = makeProject(true)
    const world = makeAdapters()

    const first = await runRun(ctx, { goal: 'ship it', acceptance: [], requestId: 'req-1' }, world.deps)
    await world.settle()
    const second = await runRun(ctx, { goal: 'ship it', acceptance: [], requestId: 'req-1' }, world.deps)

    expect(second.runId).toBe(first.runId)
    expect(second.state).toBe('completed')
    expect(second.outcome).toBe('success')
    expect(world.promptCounts.manager).toBe(1) // the duplicate never started a second supervisor

    const store = openSecondStore(dir)
    expect(store.listRuns()).toHaveLength(1)
    const duplicates = store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.duplicate_request'")
      .get(first.runId) as { n: number }
    expect(duplicates.n).toBe(1)

    await expect(
      runRun(ctx, { goal: 'a different goal', acceptance: [], requestId: 'req-1' }, world.deps),
    ).rejects.toThrowError(ConflictError)
  })

  it('fails cleanly with --json when the config has no supervisor Muse', () => {
    const dir = makeProjectDir(CONFIG_WORKER_ONLY)
    const res = spawnSync(process.execPath, [BIN, 'run', '--goal', 'x', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(res.status).toBe(1)
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error?: { code: string; message: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error?.code).toBe('config_invalid')
    expect(parsed.error?.message).toContain('supervisor')
  })
})

describe('runRun — rejects legacy container / local-process configs', () => {
  it('fails closed when legacy docker sandbox is configured', async () => {
    registerBuiltinEngines()
    const dir = makeProjectDir(CONFIG_CONTAINER)
    const ctx = projectContext(dir)

    await expect(
      runRun(ctx, { goal: 'never starts', acceptance: ['x'] }),
    ).rejects.toThrowError(SandboxUnavailableError)

    const store = openSecondStore(dir)
    expect(store.listRuns()).toHaveLength(0)
  })

  it('fails closed when legacy local-process sandbox is configured', async () => {
    registerBuiltinEngines()
    const dir = makeProjectDir(`version: 1
project:
  name: cli-run-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
runtime:
  max_concurrent_workers: 2
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
`)
    const ctx = projectContext(dir)

    await expect(
      runRun(ctx, { goal: 'never starts', acceptance: ['x'] }),
    ).rejects.toThrowError(SandboxUnavailableError)

    const store = openSecondStore(dir)
    expect(store.listRuns()).toHaveLength(0)
  })
})

/**
 * Operator cancel path (CS-9): SIGINT/SIGTERM resolve to the SAME durable cancel
 * the manager tool uses — a run-state flip plus a `run.cancel_requested` event —
 * and the supervisor loop's next control tick turns that into real engine
 * interrupts. Both functions are pure wiring over the store, so they are tested
 * directly (deterministically — real signals are never emitted).
 */
function cancelWorld(): { store: Store; runId: string } {
  const { ctx } = makeProject(true)
  const { store, projectId } = bootstrapStore(ctx.loaded)
  openDbs.push(store.db)
  const run = store.createRun({
    projectId,
    goal: 'cancel me',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 1,
      maxTasks: 5,
      maxDelegationDepth: 1,
      maxRunMinutes: 10,
      defaultTaskMinutes: 5,
    },
  })
  return { store, runId: run.id }
}

describe('runRun — operator cancel path (CS-9)', () => {
  it('requestRunCancel flips a non-terminal run to cancelled exactly once, then acks idempotently', () => {
    const { store, runId } = cancelWorld()
    const cancelEvents = (): { payload_json: string }[] =>
      store.db
        .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.cancel_requested'")
        .all(runId) as { payload_json: string }[]

    expect(requestRunCancel(store, runId, 'signal:SIGINT')).toBe(true)
    expect(store.getRun(runId).state).toBe('cancelled')
    expect(cancelEvents()).toHaveLength(1)
    expect(JSON.parse(cancelEvents()[0]?.payload_json as string)).toEqual({
      reason: 'signal:SIGINT',
      requestedBy: 'operator:signal',
    })

    // Idempotent: the run is terminal now — no second flip, no second event.
    expect(requestRunCancel(store, runId, 'signal:SIGTERM')).toBe(false)
    expect(store.getRun(runId).state).toBe('cancelled')
    expect(cancelEvents()).toHaveLength(1)
  })

  it('installRunCancelSignals registers both signals; the disposer restores the counts exactly', () => {
    const { store, runId } = cancelWorld()
    const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') }

    const dispose = installRunCancelSignals(store, runId)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1)

    dispose()
    dispose() // idempotent disposer
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    // Installing/removing handlers alone never flips the run.
    expect(store.getRun(runId).state).toBe('created')
  })
})
