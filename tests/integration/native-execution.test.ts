import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runRun } from '../../src/cli/commands/run.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { PolicyDeniedError } from '../../src/domain/errors.ts'
import { createNativeExecutionProvider } from '../../src/execution/factory.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'

const FAKE_QWEN_BIN = fileURLToPath(new URL('../helpers/fake-qwen-cli.mjs', import.meta.url))

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

const NATIVE_PROJECT_CONFIG = `version: 1
project:
  name: native-integration-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode: workspace-write
    session_timeout_minutes: 5
    env_allowlist:
      - CUSTOM_ALLOWED_TEST_VAR
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 10
  default_task_minutes: 5
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
    engine: qwen
    model: test/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    network_policy: open
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
    engine: qwen
    model: test/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    network_policy: open
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
`

function makeProject(yaml: string): { dir: string; ctx: ProjectContext } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-native-it-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), yaml)
  writeFileSync(join(dir, 'README.md'), '# native-it project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=PlutonNative', '-c', 'user.email=native@pluton', 'commit', '-m', 'seed'])

  const loaded = loadConfig(dir)
  const ctx: ProjectContext = { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
  return { dir, ctx }
}

function openSecondStore(dir: string): Store {
  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  return new Store(db)
}

describe('Native execution integration: manager & worker across isolated Git checkouts', () => {
  it('executes manager at project root and worker in an isolated Git checkout without Docker', async () => {
    const { dir, ctx } = makeProject(NATIVE_PROJECT_CONFIG)

    const origQwenBin = process.env.PLUTON_QWEN_BIN
    const origAllowed = process.env.CUSTOM_ALLOWED_TEST_VAR
    const origSecret = process.env.UNSAFE_HOST_SECRET

    process.env.PLUTON_QWEN_BIN = FAKE_QWEN_BIN
    process.env.CUSTOM_ALLOWED_TEST_VAR = 'native-test-allowed-value'
    process.env.UNSAFE_HOST_SECRET = 'super-secret-host-credential'

    try {
      const summary = await runRun(ctx, {
        goal: 'demonstrate native multi-agent orchestration across checkouts',
        acceptance: ['evidence recorded'],
      })

      expect(summary.state).toBe('completed')
      expect(summary.outcome).toBe('success')
      expect(summary.taskCounts).toEqual({ completed: 1 })
      expect(summary.unfinishedTasks).toEqual([])

      const store = openSecondStore(dir)
      const project = store.getProjectByRoot(ctx.rootDir)
      expect(project).not.toBeNull()
      const projectId = (project as { id: string }).id

      // 1. Docker isolation is not used: no sandboxes exist in the store
      const sandboxes = store.listSandboxes(projectId)
      expect(sandboxes).toHaveLength(0)

      // 2. Manager worked at the project root; worker worked in an isolated task checkout
      const tasks = store.listTasks(summary.runId)
      expect(tasks).toHaveLength(1)
      const task = tasks[0]
      expect(task?.state).toBe('completed')
      expect(task?.workspaceId).not.toBeNull()

      const ws = store.getWorkspace(task?.workspaceId as string)
      expect(ws).not.toBeNull()
      const workspaceDir = ws!.path
      expect(existsSync(workspaceDir)).toBe(true)

      // Worker evidence was written to the worker's checkout
      const workerEvidencePath = join(workspaceDir, 'worker-evidence.txt')
      expect(existsSync(workerEvidencePath)).toBe(true)

      // Manager's project root remains untouched (checkout isolation verified)
      const rootEvidencePath = join(dir, 'worker-evidence.txt')
      expect(existsSync(rootEvidencePath)).toBe(false)

      // Worker environment evidence verifies filtering
      const workerEnvPath = join(workspaceDir, 'worker-env.json')
      expect(existsSync(workerEnvPath)).toBe(true)
      const workerEnv = JSON.parse(readFileSync(workerEnvPath, 'utf8')) as Record<string, string>
      expect(workerEnv['CUSTOM_ALLOWED_TEST_VAR']).toBe('native-test-allowed-value')
      expect(workerEnv['UNSAFE_HOST_SECRET']).toBeUndefined()

      // 3. Durable execution events were persisted to the store
      const events = store.listEvents(summary.runId, { limit: 100 })
      const execEvents = events.filter((e) => e.type.startsWith('execution.'))
      expect(execEvents.length).toBeGreaterThanOrEqual(4)

      const preparedEvents = execEvents.filter((e) => e.type === 'execution.session_prepared')
      expect(preparedEvents.length).toBeGreaterThanOrEqual(2)

      // Manager session: read-only policy
      const managerPrep = preparedEvents.find((e) => e.museId === 'manager')
      expect(managerPrep).toBeDefined()
      expect(managerPrep?.payload).toMatchObject({ provider: 'native' })

      // Worker session: workspace-write policy in isolated checkout
      const workerPrep = preparedEvents.find((e) => e.museId === 'worker-a')
      expect(workerPrep).toBeDefined()
      expect(workerPrep?.payload).toMatchObject({ provider: 'native' })

      // Process spawned events include real OS pids
      const startedEvents = execEvents.filter((e) => e.type === 'execution.session_started')
      expect(startedEvents.length).toBeGreaterThanOrEqual(2)
      for (const ev of startedEvents) {
        const payload = ev.payload as Record<string, unknown>
        expect(typeof payload.pid).toBe('number')
        expect((payload.pid as number) > 0).toBe(true)
      }

      // Process exited events recorded clean zero exits
      const exitedEvents = execEvents.filter((e) => e.type === 'execution.session_exited')
      expect(exitedEvents.length).toBeGreaterThanOrEqual(2)
      for (const ev of exitedEvents) {
        const payload = ev.payload as Record<string, unknown>
        expect(payload.code).toBe(0)
      }
    } finally {
      if (origQwenBin !== undefined) process.env.PLUTON_QWEN_BIN = origQwenBin
      else delete process.env.PLUTON_QWEN_BIN

      if (origAllowed !== undefined) process.env.CUSTOM_ALLOWED_TEST_VAR = origAllowed
      else delete process.env.CUSTOM_ALLOWED_TEST_VAR

      if (origSecret !== undefined) process.env.UNSAFE_HOST_SECRET = origSecret
      else delete process.env.UNSAFE_HOST_SECRET
    }
  })

  it('rejects execution when working directory is outside allowed roots fail-closed', async () => {
    const { dir, ctx } = makeProject(NATIVE_PROJECT_CONFIG)
    const provider = createNativeExecutionProvider({
      config: ctx.loaded.config,
      rootDir: dir,
    })

    try {
      const outsideDir = mkdtempSync(join(tmpdir(), 'pluton-outside-'))
      tmpDirs.push(outsideDir)

      await expect(
        provider.prepare({
          projectId: 'proj-1',
          museId: 'worker-a',
          engineKind: 'qwen',
          hostWorkdir: outsideDir,
          hostEngineHome: join(dir, '.pluton', 'engine-homes', 'worker-a'),
          allowedRoots: [dir, join(dir, '.pluton', 'workspaces')],
          mode: 'workspace-write',
          network: 'open',
          env: {},
          limits: { cpus: 1, memoryMb: 1024, pids: 64 },
        }),
      ).rejects.toThrow(PolicyDeniedError)
    } finally {
      await provider.close()
    }
  })

  it('probes honestly: partial enforcement without Docker claims', async () => {
    const { dir, ctx } = makeProject(NATIVE_PROJECT_CONFIG)
    const provider = createNativeExecutionProvider({
      config: ctx.loaded.config,
      rootDir: dir,
    })

    try {
      const probe = await provider.probe()
      expect(probe.available).toBe(true)
      expect(probe.provider).toBe('native')
      expect(probe.backend).toBe('process-policy')
      expect(probe.enforcement).toBe('partial')
      expect(probe.capabilities.processTreeKill).toBe(true)
      expect(probe.capabilities.filesystemConfinement).toBe(false)
      expect(probe.capabilities.networkConfinement).toBe(false)
    } finally {
      await provider.close()
    }
  })
})
