import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { attachMuse } from '../../src/cli/commands/attach.ts'
import { runDoctor } from '../../src/cli/commands/doctor.ts'
import { runInit } from '../../src/cli/commands/init.ts'
import { runRun } from '../../src/cli/commands/run.ts'
import { sandboxProbe } from '../../src/cli/commands/sandbox.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import type { DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { attachToMuseTerminal } from '../../src/terminal/attach.ts'
import { NativeTerminalManager } from '../../src/terminal/native.ts'
import { run } from '../../src/util/exec.ts'

interface DockerCallRecord {
  method: string
  command: string
  args: unknown[]
}

const { dockerCalls, guardCheck } = vi.hoisted(() => {
  const dockerCalls: DockerCallRecord[] = []

  function isDockerInvocation(command: unknown, args?: unknown): boolean {
    const isDockerBin = (val: unknown): boolean => {
      if (typeof val !== 'string') return false
      const base = val.split(/[/\\]/).pop()?.toLowerCase().replace(/\.exe$/, '')
      return base === 'docker'
    }
    if (isDockerBin(command)) return true
    if (Array.isArray(args)) {
      for (const a of args) {
        if (isDockerBin(a)) return true
      }
    }
    return false
  }

  function guardCheck(method: string, command: unknown, args?: unknown): void {
    if (isDockerInvocation(command, args)) {
      const record: DockerCallRecord = {
        method,
        command: String(command),
        args: Array.isArray(args) ? [...args] : [],
      }
      dockerCalls.push(record)
      throw new Error(
        `[DockerGuard] Forbidden Docker invocation detected in native runtime: ${method}('${String(command)}')`,
      )
    }
  }

  return { dockerCalls, guardCheck }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()

  const spawnWrapper = ((command: any, ...rest: any[]) => {
    guardCheck('spawn', command, rest[0])
    return actual.spawn(command, ...rest)
  }) as typeof actual.spawn

  const spawnSyncWrapper = ((command: any, ...rest: any[]) => {
    guardCheck('spawnSync', command, rest[0])
    return actual.spawnSync(command, ...rest)
  }) as typeof actual.spawnSync

  const execFileWrapper = ((file: any, ...rest: any[]) => {
    guardCheck('execFile', file, rest[0])
    return (actual.execFile as any)(file, ...rest)
  }) as typeof actual.execFile

  const execFileSyncWrapper = ((file: any, ...rest: any[]) => {
    guardCheck('execFileSync', file, rest[0])
    return (actual.execFileSync as any)(file, ...rest)
  }) as typeof actual.execFileSync

  const execWrapper = ((command: any, ...rest: any[]) => {
    const firstWord = typeof command === 'string' ? command.trim().split(/\s+/)[0] : command
    guardCheck('exec', firstWord)
    return (actual.exec as any)(command, ...rest)
  }) as typeof actual.exec

  const execSyncWrapper = ((command: any, ...rest: any[]) => {
    const firstWord = typeof command === 'string' ? command.trim().split(/\s+/)[0] : command
    guardCheck('execSync', firstWord)
    return (actual.execSync as any)(command, ...rest)
  }) as typeof actual.execSync

  return {
    ...actual,
    spawn: spawnWrapper,
    spawnSync: spawnSyncWrapper,
    execFile: execFileWrapper,
    execFileSync: execFileSyncWrapper,
    exec: execWrapper,
    execSync: execSyncWrapper,
    default: {
      ...(((actual as Record<string, unknown>).default as object | undefined) ?? actual),
      spawn: spawnWrapper,
      spawnSync: spawnSyncWrapper,
      execFile: execFileWrapper,
      execFileSync: execFileSyncWrapper,
      exec: execWrapper,
      execSync: execSyncWrapper,
    },
  }
})

const FAKE_QWEN_BIN = fileURLToPath(new URL('../helpers/fake-qwen-cli.mjs', import.meta.url))

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

beforeEach(() => {
  dockerCalls.length = 0
})

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(dockerCalls).toEqual([])
})

const NATIVE_PROJECT_CONFIG = `version: 1
project:
  name: docker-free-runtime-it
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

function makeProject(yaml: string): { dir: string; ctx: ProjectContext; store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-docker-free-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), yaml)
  writeFileSync(join(dir, 'README.md'), '# docker-free project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=PlutonNative', '-c', 'user.email=native@pluton', 'commit', '-m', 'seed'])

  const loaded = loadConfig(dir)
  const ctx: ProjectContext = { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
  const { store, projectId } = bootstrapStore(loaded)
  openDbs.push(store.db)
  return { dir, ctx, store, projectId }
}

describe('Runtime Guard: Zero Docker Invocations across Native Runtime Lifecycle', () => {
  it('guard interceptor correctly detects and blocks docker invocations', async () => {
    expect(() => spawn('docker', ['ps'])).toThrow(/Forbidden Docker invocation detected in native runtime/)
    expect(dockerCalls).toHaveLength(1)
    expect(dockerCalls[0]?.command).toBe('docker')
    expect(dockerCalls[0]?.method).toBe('spawn')
    dockerCalls.length = 0

    await expect(run(['docker', 'ps'])).rejects.toThrow(/Forbidden Docker invocation/)
    expect(dockerCalls).toHaveLength(1)
    expect(dockerCalls[0]?.command).toBe('docker')
    expect(dockerCalls[0]?.method).toBe('spawn')
    dockerCalls.length = 0
  })

  it('a. pluton init initializes a new project with native defaults and 0 Docker invocations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-init-guard-'))
    tmpDirs.push(dir)
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
    }
    git(['init', '-b', 'main'])

    const result = await runInit({ cwd: dir, team: 'full-stack' })

    expect(result.createdFiles).toContain('pluton.yaml')
    expect(existsSync(join(dir, 'pluton.yaml'))).toBe(true)

    const loaded = loadConfig(dir)
    expect(loaded.config.sandbox.kind).toBe('native')
    expect(loaded.config.sandbox.native.mode).toBe('workspace-write')
    expect(loaded.config.sandbox.native.acknowledge_partial_enforcement).toBe(true)
    expect(loaded.config.sandbox.native.acknowledge_host_network).toBe(true)

    expect(dockerCalls).toHaveLength(0)
  })

  it('b. pluton sandbox probe probes native provider with 0 calls to Docker CLI or daemon', async () => {
    const { ctx } = makeProject(NATIVE_PROJECT_CONFIG)

    const report = await sandboxProbe(ctx)

    expect(report.sandbox.kind).toBe('native')
    expect(report.sandbox.available).toBe(true)
    expect(report.image).toBeNull()
    expect(report.dispatchReady).toBe(true)
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('native execution runs engine processes directly on the host'),
      ]),
    )

    expect(dockerCalls).toHaveLength(0)
  })

  it('c. pluton doctor verifies diagnostics without spawning Docker in native mode', async () => {
    const { dir } = makeProject(`version: 1
project:
  name: doctor-demo
  repository: .
  default_branch: main
  verification: []
runtime:
  network_policy: open
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
muses: {}
`)

    const report = await runDoctor({ cwd: dir })

    expect(report.exitCode).toBe(0)

    const dockerCli = report.checks.find((c) => c.id === 'docker-cli')
    expect(dockerCli).toBeDefined()
    expect(dockerCli?.status).toBe('info')
    expect(dockerCli?.message).toContain('not probed — native mode does not use Docker')

    const dockerDaemon = report.checks.find((c) => c.id === 'docker-daemon')
    expect(dockerDaemon).toBeUndefined()

    const sandboxCheck = report.checks.find((c) => c.id === 'sandbox')
    expect(sandboxCheck).toBeDefined()
    expect(sandboxCheck?.status).toBe('pass')

    expect(dockerCalls).toHaveLength(0)
  })

  it('d. pluton run executes a multi-agent run with manager and worker checkouts with 0 Docker spawns', async () => {
    const { ctx, store, projectId } = makeProject(NATIVE_PROJECT_CONFIG)

    const origQwenBin = process.env.PLUTON_QWEN_BIN
    process.env.PLUTON_QWEN_BIN = FAKE_QWEN_BIN

    try {
      const summary = await runRun(ctx, {
        goal: 'demonstrate zero docker spawns in native multi-agent orchestration',
        acceptance: ['evidence recorded'],
      })

      expect(summary.state).toBe('completed')
      expect(summary.outcome).toBe('success')
      expect(summary.taskCounts).toEqual({ completed: 1 })
      expect(summary.unfinishedTasks).toEqual([])

      // 0 sandboxes were created in the store
      const sandboxes = store.listSandboxes(projectId)
      expect(sandboxes).toHaveLength(0)

      // Manager stayed at project root; worker worked in isolated checkout
      const tasks = store.listTasks(summary.runId)
      expect(tasks).toHaveLength(1)
      const task = tasks[0]
      expect(task?.state).toBe('completed')
      expect(task?.workspaceId).not.toBeNull()

      const ws = store.getWorkspace(task?.workspaceId as string)
      expect(ws).not.toBeNull()
      expect(existsSync(ws!.path)).toBe(true)
      expect(existsSync(join(ws!.path, 'worker-evidence.txt'))).toBe(true)
      expect(existsSync(join(ctx.rootDir, 'worker-evidence.txt'))).toBe(false)

      // All execution events used native provider
      const events = store.listEvents(summary.runId, { limit: 50 })
      const preparedEvents = events.filter((e) => e.type === 'execution.session_prepared')
      expect(preparedEvents.length).toBeGreaterThanOrEqual(2)
      for (const ev of preparedEvents) {
        expect(ev.payload).toMatchObject({ provider: 'native' })
      }

      // Assert ZERO Docker invocations across the whole multi-agent run
      expect(dockerCalls).toHaveLength(0)
    } finally {
      if (origQwenBin !== undefined) process.env.PLUTON_QWEN_BIN = origQwenBin
      else delete process.env.PLUTON_QWEN_BIN
    }
  })

  it('e. pluton attach plan mode resolves native host target without Docker', async () => {
    const { ctx } = makeProject(NATIVE_PROJECT_CONFIG)

    // 1. Direct attachToMuseTerminal in plan mode
    const terminalManager = new NativeTerminalManager({
      runFn: async () => ({
        argv: ['tmux'],
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 1,
      }),
    })

    const directOutcome = await attachToMuseTerminal({
      sandboxKind: 'native',
      manager: terminalManager,
      target: { containerName: 'host', sessionName: 'pluton_guard_session' },
    })

    expect(directOutcome).toMatchObject({
      containerName: 'host',
      sessionName: 'pluton_guard_session',
      windowName: null,
      exitCode: null,
    })

    // 2. CLI attachMuse command in plan mode
    const attachReport = await attachMuse(
      ctx,
      { museRef: 'manager' },
      { terminalManager },
    )

    expect(attachReport.containerName).toBe('host')
    expect(attachReport.attached).toBe(false)
    expect(attachReport.sessionName).toBe('pluton_docker-free-runtime-it_manager')
    expect(attachReport.argv).toEqual([
      'tmux',
      'attach-session',
      '-t',
      '=pluton_docker-free-runtime-it_manager',
    ])
    expect(attachReport.argv[0]).toBe('tmux')

    // Zero calls to Docker
    expect(dockerCalls).toHaveLength(0)
  })
})
