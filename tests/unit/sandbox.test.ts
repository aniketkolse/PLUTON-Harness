import { describe, expect, it } from 'vitest'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import { LocalProcessSandbox, LOCAL_PROCESS_WARNING } from '../../src/sandbox/local-process.ts'
import { createSandboxManager } from '../../src/sandbox/factory.ts'
import { sandboxContainerName, type SandboxSpec } from '../../src/sandbox/types.ts'
import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import { plutonConfigSchema } from '../../src/config/schema.ts'
import type { RunResult } from '../../src/util/exec.ts'

/**
 * Sandbox conformance tests — no Docker required. They prove the exact argv
 * hardening on `docker create`, fail-closed behavior when the daemon is down,
 * label revalidation before stop/remove, and the gated dev-only local sandbox.
 */

function ok(argv: string[], stdout = ''): RunResult {
  return { argv, exitCode: 0, timedOut: false, stdout, stderr: '', truncated: false, durationMs: 1 }
}
function fail(argv: string[], stderr = 'boom', exitCode = 1): RunResult {
  return { argv, exitCode, timedOut: false, stdout: '', stderr, truncated: false, durationMs: 1 }
}

const spec: SandboxSpec = {
  projectId: 'project_abc123',
  museId: 'worker-a',
  image: 'pluton-worker:dev',
  containerName: 'pluton-demo-worker-a',
  containerUser: '10001:10001',
  limits: { cpus: 2, memoryMb: 4096, pids: 512 },
  mounts: [
    { hostPath: 'C:\\work\\checkout', containerPath: '/work' },
    { hostPath: 'C:\\home\\worker-a', containerPath: '/home/pluton', readOnly: false },
  ],
  env: { TERM: 'xterm-256color', LANG: 'C.UTF-8' },
  network: 'restricted',
}

describe('sandboxContainerName', () => {
  it('sanitizes project and muse into a docker-safe name', () => {
    expect(sandboxContainerName('My Project!', 'worker-a')).toBe('pluton-my-project-worker-a')
    const long = sandboxContainerName('x'.repeat(200), 'y'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(63)
    expect(long).toMatch(/^pluton-/)
  })
})

describe('DockerSandboxManager.create (argv conformance)', () => {
  it('probes the daemon first, then runs the hardened docker create argv', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        if (argv.includes('info')) return ok(argv, '29.7.2\n')
        if (argv.includes('create')) return ok(argv, 'deadbeefcafe\n')
        return fail(argv, 'unexpected')
      },
    })
    const created = await manager.create(spec)
    expect(created).toEqual({ containerId: 'deadbeefcafe', containerName: 'pluton-demo-worker-a' })
    expect(calls[0]).toEqual(['docker', 'info', '--format', '{{.ServerVersion}}'])
    expect(calls[1]?.slice(0, 2)).toEqual(['docker', 'create'])

    const argv = calls[1] as string[]
    for (const flag of [
      '--name',
      'pluton-demo-worker-a',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '512',
      '--memory',
      '4096m',
      '--cpus',
      '2',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--network',
      'bridge',
    ]) {
      expect(argv).toContain(flag)
    }
    expect(argv).toContain('--user')
    expect(argv[argv.indexOf('--user') + 1]).toBe('10001:10001')
    expect(argv).toContain('io.pluton.managed=true')
    expect(argv).toContain('io.pluton.project=project_abc123')
    expect(argv).toContain('io.pluton.muse=worker-a')
    expect(argv).toContain('type=bind,src=C:\\work\\checkout,dst=/work')
    expect(argv).toContain('type=bind,src=C:\\home\\worker-a,dst=/home/pluton')
    expect(argv).toContain('TERM=xterm-256color')
    expect(argv).toContain('LANG=C.UTF-8')
    expect(argv.slice(-3)).toEqual(['pluton-worker:dev', 'sleep', 'infinity'])
  })

  it('uses network none when requested and marks read-only mounts', () => {
    const argv = DockerSandboxManager.buildCreateArgs({
      ...spec,
      network: 'none',
      mounts: [{ hostPath: 'C:\\x', containerPath: '/x', readOnly: true }],
    })
    const netIdx = argv.indexOf('--network')
    expect(argv[netIdx + 1]).toBe('none')
    expect(argv).toContain('type=bind,src=C:\\x,dst=/x,readonly')
  })

  it('fails closed with the exact fix when the daemon is not reachable', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return fail(argv, 'error during connect: daemon is not running')
      },
    })
    const err = await manager.create(spec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toMatch(/daemon not reachable|maintenance/i)
    expect((err as SandboxUnavailableError).message).toMatch(/Docker Desktop/)
    expect(calls.some((argv) => argv.includes('create'))).toBe(false)
  })
})

describe('DockerSandboxManager lifecycle safety', () => {
  it('execs with -i only when stdin is provided, and passes cwd/env through', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return ok(argv, 'done')
      },
    })
    await manager.exec('pluton-demo-worker-a', ['tmux', 'list-sessions'], { cwd: '/work', env: { TERM: 'xterm' } })
    expect(calls[0]).toEqual([
      'docker',
      'exec',
      '-w',
      '/work',
      '-e',
      'TERM=xterm',
      'pluton-demo-worker-a',
      'tmux',
      'list-sessions',
    ])
    await manager.exec('pluton-demo-worker-a', ['node', 'server.mjs'], { input: '{"ping":1}\n' })
    expect(calls[1]?.slice(0, 3)).toEqual(['docker', 'exec', '-i'])
  })

  it('maps inspect states and missing containers honestly', async () => {
    const rawStates = new Map([
      ['running', 'running'],
      ['exited', 'exited'],
      ['paused', 'paused'],
      ['weird', 'weird'],
    ])
    const manager = new DockerSandboxManager({
      runFn: async (argv) => ok(argv, `${rawStates.get(argv[argv.length - 1] as string) ?? 'weird'}\n`),
    })
    expect(await manager.status('running')).toBe('running')
    expect(await manager.status('exited')).toBe('stopped')
    expect(await manager.status('paused')).toBe('stopped')
    expect(await manager.status('weird')).toBe('unknown')

    const missing = new DockerSandboxManager({
      runFn: async (argv) => fail(argv, 'Error: No such object: pluton-x'),
    })
    expect(await missing.status('pluton-x')).toBe('missing')
  })

  it('refuses to stop or remove a container without the Pluton managed label', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        if (argv.includes('inspect')) return ok(argv, 'false\n')
        return ok(argv, '')
      },
    })
    await expect(manager.stop('some-container')).rejects.toThrowError(PolicyDeniedError)
    await expect(manager.remove('some-container')).rejects.toThrowError(PolicyDeniedError)
    expect(calls.every((argv) => !argv.includes('stop') && !argv.includes('rm'))).toBe(true)
  })

  it('stops and removes managed containers with exact argv', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        if (argv.includes('inspect')) return ok(argv, 'true\n')
        return ok(argv, '')
      },
    })
    await manager.stop('pluton-demo-worker-a')
    await manager.remove('pluton-demo-worker-a')
    const stopCall = calls.find((argv) => argv.includes('stop'))
    expect(stopCall).toEqual(['docker', 'stop', '--time', '10', 'pluton-demo-worker-a'])
    const rmCall = calls.find((argv) => argv.includes('rm'))
    expect(rmCall).toEqual(['docker', 'rm', '--force', 'pluton-demo-worker-a'])
  })
})

describe('createSandboxManager (dev-only local sandbox gating)', () => {
  function configWith(sandbox: { kind: 'docker' | 'local-process'; local_process_acknowledged: boolean }) {
    return plutonConfigSchema.parse({ version: 1, project: { name: 'demo' }, sandbox })
  }

  it('refuses local-process without the explicit acknowledgement', () => {
    expect(() => createSandboxManager(configWith({ kind: 'local-process', local_process_acknowledged: false }))).toThrowError(
      ValidationError,
    )
  })

  it('hands out the labeled dev sandbox only when acknowledged', async () => {
    const manager = createSandboxManager(configWith({ kind: 'local-process', local_process_acknowledged: true }))
    expect(manager.kind).toBe('local-process')
    const probe = await manager.probe()
    expect(probe.detail).toBe(LOCAL_PROCESS_WARNING)
    expect(probe.detail).toMatch(/NOT isolation/)
  })

  it('defaults to the docker manager', () => {
    const manager = createSandboxManager(configWith({ kind: 'docker', local_process_acknowledged: false }))
    expect(manager).toBeInstanceOf(DockerSandboxManager)
  })

  it('local-process exec runs argv on the host through the injected runner', async () => {
    const calls: string[][] = []
    const sandbox = new LocalProcessSandbox({
      runFn: async (argv, options) => {
        calls.push([...(options?.cwd ? [options.cwd] : []), ...argv])
        return ok(argv, 'host-ok')
      },
    })
    const r = await sandbox.exec('anything', ['node', '-e', '1'], { cwd: '/somewhere' })
    expect(r.stdout).toBe('host-ok')
    expect(calls[0]).toEqual(['/somewhere', 'node', '-e', '1'])
  })
})
