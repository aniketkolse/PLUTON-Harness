import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import { sandboxContainerName, type SandboxSpec } from '../../src/sandbox/types.ts'
import { resolveContainerUser } from '../../src/sandbox/user-mapping.ts'
import { TmuxTerminalManager } from '../../src/terminal/manager.ts'
import { taskWindowName, tmuxSessionName } from '../../src/terminal/names.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Opt-in E2E for the Docker sandbox + tmux terminal layers (ADR-0004/0005).
 * Run with:  PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts
 *
 * Requires a reachable Docker engine and a worker image carrying git, node and
 * tmux. Default image `pluton-worker:local` (override with PLUTON_E2E_IMAGE);
 * build it first with `pluton sandbox build-image`. Without the flag the whole
 * suite is skipped, so this file is collected but never runs silently.
 */

const enabled = process.env['PLUTON_E2E_DOCKER'] === '1'
const describeE2e = enabled ? describe : describe.skip

const IMAGE = process.env['PLUTON_E2E_IMAGE'] ?? 'pluton-worker:local'
const CONTAINER = sandboxContainerName('pluton-e2e', 'e2e-muse')
const SESSION = tmuxSessionName('pluton-e2e', 'e2e-muse')
const WINDOW = taskWindowName('task_00000000abc123')
const MARKER = 'PLUTON_TMUX_E2E_OK'
const EXEC_TIMEOUT_MS = 30_000
const CAPTURE_LINES = 80
const POLL_TRIES = 15
const POLL_INTERVAL_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describeE2e('docker sandbox + tmux E2E (opt-in)', () => {
  const sandbox = new DockerSandboxManager()
  const tmux = new TmuxTerminalManager(sandbox)
  let tmpDir = ''
  let containerId = ''

  beforeAll(async () => {
    const probe = await sandbox.probe()
    expect(probe.available, probe.detail).toBe(true)

    const image = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 20_000 })
    if (image.exitCode !== 0) {
      throw new Error(
        `E2E image '${IMAGE}' is not available locally (exit ${String(image.exitCode)}); ` +
          'build it with `pluton sandbox build-image`, or point PLUTON_E2E_IMAGE at an equivalent image ' +
          `(git/node/tmux required). docker said: ${image.stderr.trim().slice(0, 300)}`,
      )
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-e2e-'))
    const spec: SandboxSpec = {
      projectId: 'e2e-project',
      museId: 'e2e-muse',
      image: IMAGE,
      containerName: CONTAINER,
      // Match production: host-detected uid:gid on native POSIX hosts,
      // 10001:10001 on Windows. The hardcoded 10001 value only worked because
      // Docker Desktop's mounts are permissive.
      containerUser: resolveContainerUser().containerUser,
      limits: { cpus: 1, memoryMb: 256, pids: 128 },
      mounts: [{ hostPath: tmpDir, containerPath: '/work' }],
      env: {},
      network: 'none',
    }
    const created = await sandbox.create(spec)
    containerId = created.containerId
    await sandbox.start(CONTAINER)
  })

  afterAll(async () => {
    // Cleanup runs even when a test failed: never leave a container behind.
    try {
      await sandbox.stop(CONTAINER)
    } catch {
      // `remove --force` below is the authoritative cleanup
    }
    try {
      await sandbox.remove(CONTAINER)
    } catch {
      // cleanup must not mask the test result
    }
    if (tmpDir !== '') rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates and starts a running container from the worker image', async () => {
    expect(containerId).not.toBe('')
    await expect(sandbox.status(CONTAINER)).resolves.toBe('running')
  })

  it('execs bounded argv tools inside the sandbox', async () => {
    const echo = await sandbox.exec(CONTAINER, ['echo', 'e2e-ok'], { timeoutMs: EXEC_TIMEOUT_MS })
    expect(echo.timedOut).toBe(false)
    expect(echo.exitCode, echo.stderr).toBe(0)
    expect(echo.stdout).toContain('e2e-ok')

    for (const argv of [['git', '--version'], ['node', '--version'], ['tmux', '-V']]) {
      const r = await sandbox.exec(CONTAINER, argv, { timeoutMs: EXEC_TIMEOUT_MS })
      expect(r.timedOut, `${argv[0] ?? 'exec'} timed out: ${r.stderr}`).toBe(false)
      expect(r.exitCode, `${argv.join(' ')} failed: ${r.stderr}`).toBe(0)
    }
  })

  it('creates the tmux session and task window idempotently', async () => {
    await expect(tmux.ensureSession(CONTAINER, SESSION, { cwd: '/work' })).resolves.toEqual({ created: true })
    await expect(tmux.ensureSession(CONTAINER, SESSION, { cwd: '/work' })).resolves.toEqual({ created: false })
    await expect(tmux.ensureWindow(CONTAINER, SESSION, WINDOW, { cwd: '/work' })).resolves.toEqual({ created: true })
    await expect(tmux.ensureWindow(CONTAINER, SESSION, WINDOW, { cwd: '/work' })).resolves.toEqual({ created: false })

    const windows = await tmux.listWindows(CONTAINER, SESSION)
    expect(windows).toContain('shell')
    expect(windows).toContain(WINDOW)
  })

  it('roundtrips a typed marker through the real tmux pane', async () => {
    const send = await sandbox.exec(
      CONTAINER,
      ['tmux', 'send-keys', '-t', `=${SESSION}:=${WINDOW}`, `echo ${MARKER}`, 'Enter'],
      { timeoutMs: 15_000 },
    )
    expect(send.exitCode, send.stderr).toBe(0)

    let captured = ''
    for (let attempt = 0; attempt < POLL_TRIES && !captured.includes(MARKER); attempt += 1) {
      captured = await tmux.capturePane(CONTAINER, SESSION, WINDOW, { lines: CAPTURE_LINES })
      if (!captured.includes(MARKER)) await sleep(POLL_INTERVAL_MS)
    }
    expect(captured).toContain(MARKER)
  })

  it('kills the task window and reports it absent afterwards', async () => {
    await expect(tmux.killWindow(CONTAINER, SESSION, WINDOW)).resolves.toBe('killed')
    await expect(tmux.killWindow(CONTAINER, SESSION, WINDOW)).resolves.toBe('absent')
  })
})
