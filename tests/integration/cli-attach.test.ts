import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { attachMuse } from '../../src/cli/commands/attach.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { NotFoundError, TerminalUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import type { SandboxExecOptions } from '../../src/sandbox/types.ts'
import { sandboxContainerName } from '../../src/sandbox/types.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { Store } from '../../src/store/store.ts'
import { tmuxSessionName } from '../../src/terminal/names.ts'
import type { RunResult } from '../../src/util/exec.ts'
import { failResult, FakeSandbox, okResult } from '../helpers/fake-sandbox.ts'

/**
 * Integration: `pluton attach` command flow against the real terminal manager
 * and a fake container. tmux inside the container is emulated per argv, so
 * plan mode (session ensured, argv built, nothing spawned), the interactive
 * spawn leg (captured argv + child exit code), container-missing, disabled and
 * unknown muses are all exercised without Docker.
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

const CONFIG_DOCKER = `version: 1
project:
  name: cli-attach-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: docker
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
const CONFIG_DOCKER_WITHOUT_MANAGER = CONFIG_DOCKER.replace('  manager:\n', '  overseer:\n')

const CONFIG_LOCAL_PROCESS = CONFIG_DOCKER.replace('kind: docker', 'kind: local-process\n  local_process_acknowledged: true')

/**
 * Answers tmux argv like a live container: no server at first (`has-session`
 * fails with the real tmux "no server running" line), sessions/windows created
 * on demand, server options accepted. `containerMissing` flips every answer to
 * the docker daemon's "No such container" error.
 */
class TmuxScriptedSandbox extends FakeSandbox {
  containerMissing = false
  private windows: string[] = ['shell']

  override exec(containerName: string, argv: string[], options: SandboxExecOptions = {}): Promise<RunResult> {
    this.calls.push({ method: 'exec', args: [containerName, argv, options] })
    this.execCalls.push({ containerName, argv, options })
    return Promise.resolve(this.reply(containerName, argv))
  }

  private reply(containerName: string, argv: string[]): RunResult {
    if (this.containerMissing) {
      return failResult(argv, `Error response from daemon: No such container: ${containerName}`)
    }
    const sub = argv[1]
    if (sub === 'has-session') return failResult(argv, 'no server running on /tmp/tmux-10001/default')
    if (sub === 'new-session') {
      this.windows = ['shell']
      return okResult(argv)
    }
    if (sub === 'new-window') {
      const nameIndex = argv.indexOf('-n')
      const name = nameIndex >= 0 ? (argv[nameIndex + 1] ?? '') : ''
      this.windows = [...this.windows, name]
      return okResult(argv, `@${String(this.windows.length)}`)
    }
    if (sub === 'list-windows') {
      const format = argv.at(-1)
      if (format === '#{window_id}:#{window_name}') {
        const lines = this.windows.map((w, i) => `@${String(i + 1)}:${w}`).join('\n')
        return okResult(argv, `${lines}\n`)
      }
      return okResult(argv, `${this.windows.join('\n')}\n`)
    }
    return okResult(argv)
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
  it('resolves the container/session, ensures the session through the manager and never spawns', async () => {
    const { dir, ctx } = makeProject(CONFIG_DOCKER)
    const sandbox = new TmuxScriptedSandbox()

    const result = await attachMuse(ctx, { museRef: 'manager' }, { sandboxManager: sandbox })

    const store = openSecondStore(dir)
    const project = store.getProjectByRoot(ctx.rootDir)
    expect(project).not.toBeNull()
    const projectId = (project as { id: string }).id
    const containerName = sandboxContainerName(projectId, 'manager')
    const sessionName = tmuxSessionName('cli-attach-it', 'manager')

    expect(result).toEqual({
      museId: 'manager',
      containerName,
      sessionName,
      windowName: null,
      sessionCreated: true,
      argv: ['docker', 'exec', '-it', containerName, 'tmux', 'attach-session', '-t', `=${sessionName}`],
      attached: false,
      exitCode: null,
    })
    // The REAL TmuxTerminalManager ran: the session was created in the container.
    expect(sandbox.execCalls.some((c) => c.argv[1] === 'new-session')).toBe(true)
    const terminal = store.getTerminalForMuse(projectId, 'manager')
    expect(terminal?.tmuxSessionName).toBe(sessionName)
    expect(terminal?.state).toBe('present')
  })

  it('creates and targets a named window on request', async () => {
    const { ctx } = makeProject(CONFIG_DOCKER)
    const sandbox = new TmuxScriptedSandbox()

    const result = await attachMuse(ctx, { museRef: 'manager', windowName: 'ui' }, { sandboxManager: sandbox })

    expect(result.windowName).toBe('ui')
    expect(result.argv.at(-1)).toBe(`=${result.sessionName}:=ui`)
    expect(result.exitCode).toBeNull()
    expect(sandbox.execCalls.some((c) => c.argv[1] === 'new-window' && c.argv.includes('ui'))).toBe(true)
  })
})

describe('attachMuse — interactive spawn mode', () => {
  it('spawns the exact docker exec argv and returns the child exit code', async () => {
    const { ctx } = makeProject(CONFIG_DOCKER)
    const sandbox = new TmuxScriptedSandbox()
    const spawned: string[][] = []

    const result = await attachMuse(
      ctx,
      { museRef: 'manager' },
      {
        sandboxManager: sandbox,
        spawnAttach: (argv) => {
          spawned.push(argv)
          return Promise.resolve(7)
        },
      },
    )

    expect(result.attached).toBe(true)
    expect(result.exitCode).toBe(7)
    expect(spawned).toEqual([result.argv])
    expect(result.argv).toEqual([
      'docker',
      'exec',
      '-it',
      result.containerName,
      'tmux',
      'attach-session',
      '-t',
      `=${result.sessionName}`,
    ])
  })
})

describe('attachMuse — refusals', () => {
  it('refuses local-process configs naming sandbox.kind: docker, before any tmux call', async () => {
    const { ctx } = makeProject(CONFIG_LOCAL_PROCESS)
    const sandbox = new TmuxScriptedSandbox()

    const err = await attachMuse(ctx, { museRef: 'manager' }, { sandboxManager: sandbox }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).message).toContain('sandbox.kind: docker')
    expect(sandbox.calls).toEqual([])
  })

  it('refuses a Muse row left behind as disabled after it left pluton.yaml', async () => {
    const { dir, ctx } = makeProject(CONFIG_DOCKER)
    bootstrapStore(ctx.loaded).store.close() // materialize rows with the muse enabled
    writeFileSync(join(dir, 'pluton.yaml'), CONFIG_DOCKER_WITHOUT_MANAGER)
    const ctx2 = projectContext(dir)
    const sandbox = new TmuxScriptedSandbox()

    const err = await attachMuse(ctx2, { museRef: 'manager' }, { sandboxManager: sandbox }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).message).toContain('disabled')
    expect(sandbox.calls).toEqual([])
  })

  it('reports an unknown muse reference as not_found', async () => {
    const { ctx } = makeProject(CONFIG_DOCKER)
    const sandbox = new TmuxScriptedSandbox()

    const err = await attachMuse(ctx, { museRef: 'nope' }, { sandboxManager: sandbox }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(NotFoundError)
    expect(sandbox.calls).toEqual([])
  })

  it('maps a missing container to a terminal_unavailable with an attach fix and no terminal row', async () => {
    const { dir, ctx } = makeProject(CONFIG_DOCKER)
    const sandbox = new TmuxScriptedSandbox()
    sandbox.containerMissing = true

    const err = await attachMuse(ctx, { museRef: 'manager' }, { sandboxManager: sandbox }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(TerminalUnavailableError)
    expect((err as TerminalUnavailableError).details).toMatchObject({ reason: 'container_missing' })
    expect((err as Error).message).toContain('start a run first')
    const store = openSecondStore(dir)
    const project = store.getProjectByRoot(ctx.rootDir)
    expect(project).not.toBeNull()
    expect(store.getTerminalForMuse((project as { id: string }).id, 'manager')).toBeNull()
  })
})
