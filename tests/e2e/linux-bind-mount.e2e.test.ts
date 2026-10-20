import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import { sandboxContainerName, type SandboxSpec } from '../../src/sandbox/types.ts'
import { resolveContainerUser } from '../../src/sandbox/user-mapping.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Opt-in validation of the Linux bind-mount ownership model (ADR-0004/0010,
 * SECURITY.md §8.9). Docker Desktop on Windows/macOS is NOT evidence: its
 * mounts are broadly writable regardless of uid, which masks the exact failure
 * this test is meant to catch.
 *
 * Run on a native Linux host, as a non-root user with Docker access:
 *
 *   PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/linux-bind-mount.e2e.test.ts
 *
 * Prerequisites: Docker daemon reachable; `pluton-worker:local` built with
 * `pluton sandbox build-image` (the base profile is enough). The file is
 * collected on every platform but skips unless the host is native Linux and
 * PLUTON_E2E_DOCKER=1. A skipped run is NOT TESTED, never a pass.
 */

const dockerEnabled = process.env['PLUTON_E2E_DOCKER'] === '1'
const hostUid = process.getuid?.() ?? -1
const hostGid = process.getgid?.() ?? -1
const canRun = dockerEnabled && process.platform === 'linux' && hostUid > 0 && hostGid >= 0
const describeLinux = canRun ? describe : describe.skip

const IMAGE = process.env['PLUTON_E2E_IMAGE'] ?? 'pluton-worker:local'
const PROJECT = `pluton-e2e-linux-${String(process.pid)}-${Date.now().toString(36)}`
const EXEC_TIMEOUT_MS = 30_000
const RW_MOUNT = '/work'
const RO_MOUNT = '/readonly'
const RESTRICTED_MOUNT = '/restricted'

async function containerExists(name: string): Promise<boolean> {
  const result = await run(['docker', 'inspect', name], { timeoutMs: 15_000 })
  return result.exitCode === 0
}

describeLinux('Linux bind-mount ownership (opt-in, native Linux only)', () => {
  const sandbox = new DockerSandboxManager()
  const createdContainers = new Set<string>()
  let tmpDir = ''
  let workDir = ''
  let roDir = ''
  let restrictedDir = ''
  let sentinel = ''
  let containerUser = ''

  function specFor(name: string, user: string, mounts: SandboxSpec['mounts']): SandboxSpec {
    return {
      projectId: PROJECT,
      museId: name,
      image: IMAGE,
      containerName: name,
      containerUser: user,
      limits: { cpus: 1, memoryMb: 256, pids: 128 },
      mounts,
      env: {},
      network: 'none',
    }
  }

  async function removeContainer(name: string): Promise<void> {
    try {
      await sandbox.stop(name)
    } catch {
      // `remove --force` below is the authoritative cleanup
    }
    try {
      await sandbox.remove(name)
    } catch {
      // cleanup must not mask the test result
    }
    createdContainers.delete(name)
  }

  beforeAll(async () => {
    const probe = await sandbox.probe()
    expect(probe.available, probe.detail).toBe(true)

    const image = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 20_000 })
    if (image.exitCode !== 0) {
      throw new Error(
        `E2E image '${IMAGE}' is not available locally (exit ${String(image.exitCode)}); ` +
          'build it with `pluton sandbox build-image` (use --engines for supervised runs). ' +
          `docker said: ${image.stderr.trim().slice(0, 300)}`,
      )
    }

    // The production resolver must map the host identity on native Linux; the
    // 10001 default is the Windows path and would not prove ownership alignment.
    // envUser is blanked so an operator override cannot silently change the case
    // under test (that override needs its own validation).
    const resolved = resolveContainerUser({ envUser: '' })
    expect(resolved.source).toBe('host-detected')
    expect(resolved.containerUser).toBe(`${String(hostUid)}:${String(hostGid)}`)
    containerUser = resolved.containerUser

    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-linux-ownership-'))
    workDir = join(tmpDir, 'work')
    roDir = join(tmpDir, 'readonly')
    restrictedDir = join(tmpDir, 'restricted')
    mkdirSync(workDir, { mode: 0o755 })
    mkdirSync(roDir, { mode: 0o755 })
    mkdirSync(restrictedDir, { mode: 0o700 })

    writeFileSync(join(workDir, 'host-owned.txt'), 'seed\n', { mode: 0o644 })
    writeFileSync(join(roDir, 'host-file.txt'), 'ro-seed\n', { mode: 0o644 })
    writeFileSync(join(restrictedDir, 'secret.txt'), 'top-secret\n', { mode: 0o600 })

    // A sibling of the disposable workspace: cleanup must not touch it.
    sentinel = join(tmpdir(), `pluton-e2e-unrelated-${String(process.pid)}-${Date.now().toString(36)}`)
    writeFileSync(sentinel, 'do-not-delete\n', { mode: 0o600 })
  })

  afterAll(async () => {
    for (const name of [...createdContainers]) await removeContainer(name)
    if (tmpDir !== '' && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    if (sentinel !== '' && existsSync(sentinel)) rmSync(sentinel, { force: true })
  })

  it('runs as the host uid and preserves host-side ownership across two lifecycles', async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      // Reset the file each cycle so the read/append assertions are exact.
      writeFileSync(join(workDir, 'host-owned.txt'), 'seed\n', { mode: 0o644 })

      const name = sandboxContainerName(PROJECT, `ownership-${String(cycle)}`)
      createdContainers.add(name)
      await sandbox.create(
        specFor(name, containerUser, [{ hostPath: workDir, containerPath: RW_MOUNT }]),
      )
      await sandbox.start(name)

      const identity = await sandbox.exec(name, ['id', '-u', '-g'], { timeoutMs: EXEC_TIMEOUT_MS })
      expect(identity.exitCode, identity.stderr).toBe(0)
      expect(identity.stdout.trim()).toBe(`${String(hostUid)} ${String(hostGid)}`)

      const read = await sandbox.exec(name, ['cat', `${RW_MOUNT}/host-owned.txt`], {
        timeoutMs: EXEC_TIMEOUT_MS,
      })
      expect(read.exitCode, read.stderr).toBe(0)
      expect(read.stdout).toBe('seed\n')

      const write = await sandbox.exec(
        name,
        ['sh', '-c', `printf "from-container\\n" > ${RW_MOUNT}/from-container.txt`],
        { timeoutMs: EXEC_TIMEOUT_MS },
      )
      expect(write.exitCode, write.stderr).toBe(0)

      const append = await sandbox.exec(
        name,
        ['sh', '-c', `printf "appended\\n" >> ${RW_MOUNT}/host-owned.txt`],
        { timeoutMs: EXEC_TIMEOUT_MS },
      )
      expect(append.exitCode, append.stderr).toBe(0)

      const created = statSync(join(workDir, 'from-container.txt'))
      expect(created.uid).toBe(hostUid)
      expect(created.gid).toBe(hostGid)

      const modified = statSync(join(workDir, 'host-owned.txt'))
      expect(modified.uid).toBe(hostUid)
      expect(modified.gid).toBe(hostGid)
      expect(modified.mode & 0o777).toBe(0o644)
      expect(readFileSync(join(workDir, 'host-owned.txt'), 'utf8')).toBe('seed\nappended\n')

      await removeContainer(name)
      expect(await containerExists(name)).toBe(false)
    }
  })

  it('rejects writes to a read-only bind mount and leaves the host directory unchanged', async () => {
    const name = sandboxContainerName(PROJECT, 'readonly')
    createdContainers.add(name)
    await sandbox.create(
      specFor(name, containerUser, [{ hostPath: roDir, containerPath: RO_MOUNT, readOnly: true }]),
    )
    await sandbox.start(name)

    const before = readdirSync(roDir).sort()
    const read = await sandbox.exec(name, ['cat', `${RO_MOUNT}/host-file.txt`], {
      timeoutMs: EXEC_TIMEOUT_MS,
    })
    expect(read.exitCode, read.stderr).toBe(0)
    expect(read.stdout).toBe('ro-seed\n')

    const write = await sandbox.exec(name, ['sh', '-c', `printf "nope\\n" > ${RO_MOUNT}/new.txt`], {
      timeoutMs: EXEC_TIMEOUT_MS,
    })
    expect(write.exitCode).not.toBe(0)
    expect(write.stderr).toMatch(/read-only file system/i)
    expect(readdirSync(roDir).sort()).toEqual(before)

    await removeContainer(name)
    expect(await containerExists(name)).toBe(false)
  })

  it.skipIf(hostUid === 10001)(
    'reports permission denied for a foreign uid on a 0700 directory',
    async () => {
      const name = sandboxContainerName(PROJECT, 'foreign-uid')
      createdContainers.add(name)
      await sandbox.create(
        specFor(name, '10001:10001', [
          { hostPath: restrictedDir, containerPath: RESTRICTED_MOUNT },
        ]),
      )
      await sandbox.start(name)

      const identity = await sandbox.exec(name, ['id', '-u', '-g'], { timeoutMs: EXEC_TIMEOUT_MS })
      expect(identity.exitCode, identity.stderr).toBe(0)
      expect(identity.stdout.trim()).toBe('10001 10001')

      const read = await sandbox.exec(name, ['cat', `${RESTRICTED_MOUNT}/secret.txt`], {
        timeoutMs: EXEC_TIMEOUT_MS,
      })
      expect(read.exitCode).not.toBe(0)
      expect(read.stderr).toMatch(/permission denied/i)

      const write = await sandbox.exec(
        name,
        ['sh', '-c', `printf "x\\n" > ${RESTRICTED_MOUNT}/secret.txt`],
        { timeoutMs: EXEC_TIMEOUT_MS },
      )
      expect(write.exitCode).not.toBe(0)
      expect(write.stderr).toMatch(/permission denied/i)

      await removeContainer(name)
      expect(await containerExists(name)).toBe(false)
    },
  )

  it('removes only its own containers and workspace, leaving unrelated host files intact', async () => {
    for (const name of [...createdContainers]) await removeContainer(name)
    expect(createdContainers.size).toBe(0)

    expect(existsSync(tmpDir)).toBe(true)
    rmSync(tmpDir, { recursive: true, force: true })
    expect(existsSync(tmpDir)).toBe(false)
    expect(existsSync(sentinel)).toBe(true)
  })
})
