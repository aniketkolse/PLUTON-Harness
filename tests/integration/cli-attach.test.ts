import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { attachMuse } from '../../src/cli/commands/attach.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { NotFoundError, SandboxUnavailableError, TerminalUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { NativeTerminalManager } from '../../src/terminal/native.ts'
import { tmuxSessionName } from '../../src/terminal/names.ts'
import type { RunResult } from '../../src/util/exec.ts'

/**
 * Integration: `pluton attach` command flow against the real native terminal manager.
 * tmux on host is emulated per argv, so plan mode (session ensured, argv built, nothing spawned),
 * the interactive spawn leg (captured argv + child exit code), disabled and
 * unknown muses are all exercised natively without Docker.
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

const CONFIG_NATIVE = `version: 1
project:
  name: cli-attach-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
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
    permissions:
      - project.read
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
`

/** Same shape, but the `manager` Muse is gone from config (store row disabled). */
const CONFIG_NATIVE_WITHOUT_MANAGER = CONFIG_NATIVE.replace('  manager:\n', '  overseer:\n')

const CONFIG_DOCKER = CONFIG_NATIVE.replace(
  `kind: native\n  native:\n    acknowledge_partial_enforcement: true\n    acknowledge_host_network: true`,
  'kind: docker',
)

const CONFIG_LOCAL_PROCESS = CONFIG_NATIVE.replace(
  `kind: native\n  native:\n    acknowledge_partial_enforcement: true\n    acknowledge_host_network: true`,
  'kind: local-process\n  local_process_acknowledged: true',
)

function okResult(argv: string[], stdout = ''): RunResult {
  return { argv, exitCode: 0, timedOut: false, stdout, stderr: '', truncated: false, durationMs: 5 }
}

function failResult(argv: string[], stderr: string, exitCode = 1): RunResult {
  return { argv, exitCode, timedOut: false, stdout: '', stderr, truncated: false, durationMs: 5 }
}

class TmuxScriptedHostRunner {
  executed: string[][] = []
  private windows: string[] = ['shell']

  run(argv: string[]): Promise<RunResult> {
    this.executed.push(argv)
    const sub = argv[1]
    if (sub === 'has-session') return Promise.resolve(failResult(argv, 'no server running'))
    if (sub === 'new-session') {
      this.windows = ['shell']
      return Promise.resolve(okResult(argv))
    }
    if (sub === 'new-window') {
      const nameIndex = argv.indexOf('-n')
      const name = nameIndex >= 0 ? (argv[nameIndex + 1] ?? '') : ''
      this.windows = [...this.windows, name]
      return Promise.resolve(okResult(argv, `@${String(this.windows.length)}`))
    }
    if (sub === 'list-windows') {
      const format = argv.at(-1)
      if (format === '#{window_id}:#{window_name}') {
        const lines = this.windows.map((w, i) => `@${String(i + 1)}:${w}`).join('\n')
        return Promise.resolve(okResult(argv, `${lines}\n`))
      }
      return Promise.resolve(okResult(argv, `${this.windows.join('\n')}\n`))
    }
    return Promise.resolve(okResult(argv))
  }
}

interface Fixture {
  dir: string
  ctx: ProjectContext
}

function projectContext(dir: string): ProjectContext {
  const loaded = loadConfig(dir)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

function makeProject(yaml: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-cli-attach-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), yaml)
  writeFileSync(join(dir, 'README.md'), '# cli-attach project\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 30_000 })
  }
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  return { dir, ctx: projectContext(dir) }
}

function openSecondStore(dir: string): Store {
  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  return new Store(db)
}

describe('attachMuse — plan mode (--json)', () => {
  it('supports native sandbox plan mode: ensures session on host without docker', async () => {
    const { dir, ctx } = makeProject(CONFIG_NATIVE)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const result = await attachMuse(ctx, { museRef: 'manager' }, { terminalManager })

    const store = openSecondStore(dir)
    const project = store.getProjectByRoot(ctx.rootDir)
    expect(project).not.toBeNull()
    const projectId = (project as { id: string }).id
    const sessionName = tmuxSessionName('cli-attach-it', 'manager')

    expect(result).toEqual({
      shipId: 'manager',
      museId: 'manager',
      containerName: 'host',
      sessionName,
      windowName: null,
      sessionCreated: true,
      argv: ['tmux', 'attach-session', '-t', `=${sessionName}`],
      attached: false,
      exitCode: null,
    })
    expect(runner.executed.some((c) => c[1] === 'new-session')).toBe(true)
    const terminal = store.getTerminalForMuse(projectId, 'manager')
    expect(terminal?.tmuxSessionName).toBe(sessionName)
    expect(terminal?.sandboxId).toBeNull()
    expect(terminal?.state).toBe('present')
  })

  it('creates and targets a named window on request', async () => {
    const { ctx } = makeProject(CONFIG_NATIVE)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const result = await attachMuse(ctx, { museRef: 'manager', windowName: 'ui' }, { terminalManager })

    expect(result.windowName).toBe('ui')
    expect(result.argv.at(-1)).toBe(`=${result.sessionName}:=ui`)
    expect(result.exitCode).toBeNull()
    expect(runner.executed.some((c) => c[1] === 'new-window' && c.includes('ui'))).toBe(true)
  })
})

describe('attachMuse — interactive spawn mode', () => {
  it('spawns the direct tmux attach argv for native sandbox and returns exit code', async () => {
    const { ctx } = makeProject(CONFIG_NATIVE)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })
    const spawned: string[][] = []

    const result = await attachMuse(
      ctx,
      { museRef: 'manager', windowName: 'worker' },
      {
        terminalManager,
        spawnAttach: (argv) => {
          spawned.push(argv)
          return Promise.resolve(0)
        },
      },
    )

    expect(result.attached).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(spawned).toEqual([result.argv])
    expect(result.argv).toEqual([
      'tmux',
      'attach-session',
      '-t',
      `=${result.sessionName}:=worker`,
    ])
  })
})

describe('attachMuse — refusals', () => {
  it('refuses legacy docker configs before any tmux call', async () => {
    const { ctx } = makeProject(CONFIG_DOCKER)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const err = await attachMuse(ctx, { museRef: 'manager' }, { terminalManager }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain("sandbox.kind 'docker' is no longer supported")
    expect(runner.executed).toEqual([])
  })

  it('refuses local-process configs before any tmux call', async () => {
    const { ctx } = makeProject(CONFIG_LOCAL_PROCESS)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const err = await attachMuse(ctx, { museRef: 'manager' }, { terminalManager }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain("sandbox.kind 'local-process' is no longer supported")
    expect(runner.executed).toEqual([])
  })

  it('refuses a Muse row left behind as disabled after it left pluton.yaml', async () => {
    const { dir, ctx } = makeProject(CONFIG_NATIVE)
    bootstrapStore(ctx.loaded).store.close() // materialize rows with the muse enabled
    writeFileSync(join(dir, 'pluton.yaml'), CONFIG_NATIVE_WITHOUT_MANAGER)
    const ctx2 = projectContext(dir)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const err = await attachMuse(ctx2, { museRef: 'manager' }, { terminalManager }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).message).toContain('disabled')
    expect(runner.executed).toEqual([])
  })

  it('reports an unknown muse reference as not_found', async () => {
    const { ctx } = makeProject(CONFIG_NATIVE)
    const runner = new TmuxScriptedHostRunner()
    const terminalManager = new NativeTerminalManager({ runFn: (argv) => runner.run(argv) })

    const err = await attachMuse(ctx, { museRef: 'nope' }, { terminalManager }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(NotFoundError)
    expect(runner.executed).toEqual([])
  })

  it('maps tmux missing failure to a terminal_unavailable with fix', async () => {
    const { ctx } = makeProject(CONFIG_NATIVE)
    const terminalManager = new NativeTerminalManager({
      runFn: (argv) => Promise.resolve({
        argv,
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: 'spawn tmux ENOENT',
        truncated: false,
        durationMs: 2,
      }),
    })

    const err = await attachMuse(ctx, { museRef: 'manager' }, { terminalManager }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'tmux_not_installed' })
  })
})
