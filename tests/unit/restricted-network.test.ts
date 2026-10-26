import { describe, expect, it } from 'vitest'
import { plutonConfigSchema } from '../../src/config/schema.ts'
import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import { createSandboxManager } from '../../src/sandbox/factory.ts'
import { LocalProcessSandbox } from '../../src/sandbox/local-process.ts'
import {
  EGRESS_PROBE_BLOCKED,
  EGRESS_PROBE_HOST,
  EGRESS_PROBE_OPEN,
  EGRESS_PROBE_PORT,
  expectedContainerNetworks,
  planShipNetwork,
  restrictedNetworkName,
  verifyRestrictedEgress,
} from '../../src/sandbox/network.ts'
import type { SandboxSpec } from '../../src/sandbox/types.ts'
import type { RunResult } from '../../src/util/exec.ts'
import { FakeSandbox, failResult, okResult } from '../helpers/fake-sandbox.ts'

/**
 * P6 restricted-network contract. `restricted` is only honest when the
 * container has no route off its own Docker network: these tests pin the
 * fail-closed argv, the internal-network provisioning, and the runtime egress
 * probe that refuses to start a run when enforcement is not demonstrably in
 * place. No Docker daemon is required.
 */

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    projectId: 'proj_1',
    shipId: 'worker-a',
    image: 'pluton-worker:dev',
    containerName: 'pluton-demo-worker-a',
    containerUser: '10001:10001',
    limits: { cpus: 1, memoryMb: 512, pids: 64 },
    mounts: [],
    env: {},
    network: 'restricted',
    ...overrides,
  }
}

function configWith(overrides: Record<string, unknown> = {}) {
  return plutonConfigSchema.parse({
    version: 1,
    project: { name: 'demo' },
    sandbox: { kind: 'docker', image: 'pluton-worker:dev' },
    ...overrides,
  })
}

describe('restricted network plan', () => {
  it('derives a per-project internal network name when none is configured', () => {
    expect(restrictedNetworkName(undefined, 'proj_1')).toBe('pluton-restricted-proj_1')
    expect(restrictedNetworkName('fleet-net', 'proj_1')).toBe('fleet-net')
  })

  it('refuses an invalid configured or derived network name', () => {
    expect(() => restrictedNetworkName('bad network!', 'proj_1')).toThrowError(ValidationError)
    expect(() => restrictedNetworkName(undefined, 'bad project!')).toThrowError(ValidationError)
  })

  it('maps each policy to exactly one Docker network', () => {
    expect(expectedContainerNetworks({ network: 'none', customNetwork: 'ignored' })).toEqual(['none'])
    expect(expectedContainerNetworks({ network: 'open' })).toEqual(['bridge'])
    expect(expectedContainerNetworks({ network: 'open', customNetwork: 'net-open' })).toEqual(['net-open'])
    expect(expectedContainerNetworks({ network: 'restricted', customNetwork: 'net-internal' })).toEqual(['net-internal'])
  })

  it('fails closed instead of falling back to bridge when restricted has no internal network', () => {
    expect(() => expectedContainerNetworks({ network: 'restricted' })).toThrowError(ValidationError)
    expect(() => expectedContainerNetworks({ network: 'restricted', customNetwork: 'bridge' })).toThrowError(
      ValidationError,
    )
    expect(() => expectedContainerNetworks({ network: 'restricted', customNetwork: 'host' })).toThrowError(
      ValidationError,
    )
    expect(() => DockerSandboxManager.buildCreateArgs(spec())).toThrowError(ValidationError)
  })

  it('wires restricted to the internal network and open to bridge', () => {
    const restricted = DockerSandboxManager.buildCreateArgs(spec({ customNetwork: 'net-internal' }))
    const restrictedIdx = restricted.indexOf('--network')
    expect(restricted[restrictedIdx + 1]).toBe('net-internal')

    const open = DockerSandboxManager.buildCreateArgs(spec({ network: 'open' }))
    expect(open[open.indexOf('--network') + 1]).toBe('bridge')

    const none = DockerSandboxManager.buildCreateArgs(spec({ network: 'none' }))
    expect(none[none.indexOf('--network') + 1]).toBe('none')
  })
})

describe('planShipNetwork', () => {
  it('ensures the internal network once and returns the Docker network name', async () => {
    const fake = new FakeSandbox()
    const ensured = new Set<string>()
    const config = configWith({ runtime: { network_policy: 'restricted' } })

    const first = await planShipNetwork({ manager: fake, config, shipId: 'worker-a', projectId: 'proj_1', ensured })
    const second = await planShipNetwork({ manager: fake, config, shipId: 'worker-a', projectId: 'proj_1', ensured })

    expect(first).toEqual({ policy: 'restricted', customNetwork: 'pluton-restricted-proj_1' })
    expect(second).toEqual(first)
    expect(fake.ensureNetworkCalls).toEqual(['pluton-restricted-proj_1'])
  })

  it('honours a per-Ship override and an explicitly configured network', async () => {
    const fake = new FakeSandbox()
    const config = configWith({
      runtime: { network_policy: 'open', internal_network_name: 'fleet-net' },
      ships: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'm',
          workspace_policy: 'coordinator-read-only',
        },
        'worker-a': { display_name: 'A', role: 'coder', engine: 'mock', model: 'm', network_policy: 'restricted' },
      },
    })
    const plan = await planShipNetwork({ manager: fake, config, shipId: 'worker-a', projectId: 'proj_1' })
    expect(plan).toEqual({ policy: 'restricted', customNetwork: 'fleet-net' })
    expect(fake.ensureNetworkCalls).toEqual(['fleet-net'])
  })

  it('leaves open and none policies untouched', async () => {
    const fake = new FakeSandbox()
    const open = configWith({ runtime: { network_policy: 'open' } })
    const none = configWith({ runtime: { network_policy: 'none' } })
    expect(await planShipNetwork({ manager: fake, config: open, shipId: 'worker-a', projectId: 'proj_1' })).toEqual({
      policy: 'open',
    })
    expect(await planShipNetwork({ manager: fake, config: none, shipId: 'worker-a', projectId: 'proj_1' })).toEqual({
      policy: 'none',
    })
    expect(fake.ensureNetworkCalls).toEqual([])
  })

  it('fails closed when the manager cannot provide an internal network', async () => {
    const fake = new FakeSandbox()
    fake.ensureInternalNetwork = undefined
    const config = configWith({ runtime: { network_policy: 'restricted' } })
    await expect(
      planShipNetwork({ manager: fake, config, shipId: 'worker-a', projectId: 'proj_1' }),
    ).rejects.toThrowError(SandboxUnavailableError)
  })
})

describe('DockerSandboxManager.ensureInternalNetwork', () => {
  it('accepts an existing internal network without creating it', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return okResult(argv, 'true\n')
      },
    })

    await expect(manager.ensureInternalNetwork('net-internal')).resolves.toBe('existing')
    expect(calls).toEqual([
      ['docker', 'network', 'inspect', '--format', '{{.Internal}}', 'net-internal'],
    ])
  })

  it('refuses an existing network that is not internal (would leave egress open)', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return okResult(argv, 'false\n')
      },
    })

    const err = await manager.ensureInternalNetwork('net-internal').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PolicyDeniedError)
    expect((err as PolicyDeniedError).message).toContain('not internal')
    expect(calls.some((argv) => argv.includes('create'))).toBe(false)
  })

  it('creates the network with --internal when it is missing', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        if (argv.includes('inspect')) return failResult(argv, 'Error: No such network: net-internal')
        return okResult(argv, 'created-id\n')
      },
    })

    await expect(manager.ensureInternalNetwork('net-internal')).resolves.toBe('created')
    expect(calls[1]).toEqual([
      'docker',
      'network',
      'create',
      '--driver',
      'bridge',
      '--internal',
      '--label',
      'io.pluton.managed=true',
      '--label',
      'io.pluton.network=restricted',
      'net-internal',
    ])
  })

  it('fails closed when the daemon cannot be asked (never creates blindly)', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return failResult(argv, 'Cannot connect to the Docker daemon at npipe:////./pipe/dockerDesktopLinuxEngine')
      },
    })

    await expect(manager.ensureInternalNetwork('net-internal')).rejects.toThrowError(SandboxUnavailableError)
    expect(calls).toHaveLength(1)
  })

  it('tolerates a create race when the winner created an internal network', async () => {
    const calls: string[][] = []
    let inspections = 0
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        if (argv.includes('inspect')) {
          inspections += 1
          return inspections === 1 ? failResult(argv, 'Error: No such network: net-internal') : okResult(argv, 'true\n')
        }
        return failResult(argv, 'Error response from daemon: network with name net-internal already exists')
      },
    })

    await expect(manager.ensureInternalNetwork('net-internal')).resolves.toBe('existing')
    expect(inspections).toBe(2)
  })

  it('rejects an invalid network name before any docker call', async () => {
    const calls: string[][] = []
    const manager = new DockerSandboxManager({
      runFn: async (argv) => {
        calls.push(argv)
        return okResult(argv, 'true\n')
      },
    })
    await expect(manager.ensureInternalNetwork('bad network!')).rejects.toThrowError(ValidationError)
    expect(calls).toEqual([])
  })
})

describe('verifyRestrictedEgress', () => {
  it('passes only when the in-container probe reports blocked egress', async () => {
    const fake = new FakeSandbox()
    fake.execQueue.push(okResult([], `${EGRESS_PROBE_BLOCKED}\n`))

    await expect(verifyRestrictedEgress(fake, 'pluton-demo-worker-a')).resolves.toBeUndefined()
    const call = fake.execCalls[0]
    expect(call?.containerName).toBe('pluton-demo-worker-a')
    expect(call?.argv[0]).toBe('node')
    expect(call?.argv[1]).toBe('-e')
    // The destination must never be interpolated into the script (or any argv).
    expect(call?.argv.join(' ')).not.toContain(EGRESS_PROBE_HOST)
    expect(call?.options.env).toMatchObject({
      PLUTON_EGRESS_PROBE_HOST: EGRESS_PROBE_HOST,
      PLUTON_EGRESS_PROBE_PORT: String(EGRESS_PROBE_PORT),
    })
  })

  it('refuses to proceed when the probe can reach the internet', async () => {
    const fake = new FakeSandbox()
    fake.execQueue.push(okResult([], `${EGRESS_PROBE_OPEN}\n`))

    const err = await verifyRestrictedEgress(fake, 'pluton-demo-worker-a').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain('restricted network enforcement is not in place')
    expect((err as SandboxUnavailableError).message).toContain('Fix:')
  })

  it('fails closed when the probe cannot run (no marker, missing node, outer timeout)', async () => {
    for (const result of [
      failResult([], 'node: not found', 127),
      { ...failResult([], '', 124), timedOut: true } satisfies RunResult,
      okResult([], ''),
    ]) {
      const fake = new FakeSandbox()
      fake.execQueue.push(result)
      await expect(verifyRestrictedEgress(fake, 'pluton-demo-worker-a')).rejects.toThrowError(SandboxUnavailableError)
    }
  })

  it('fails closed when docker exec itself throws', async () => {
    const fake = new FakeSandbox()
    fake.exec = () => Promise.reject(new Error('docker exec failed'))
    await expect(verifyRestrictedEgress(fake, 'pluton-demo-worker-a')).rejects.toThrowError(SandboxUnavailableError)
  })
})

describe('non-enforcing sandboxes refuse restricted/none', () => {
  it('local-process refuses any policy other than open at create time', async () => {
    const sandbox = new LocalProcessSandbox()
    for (const network of ['restricted', 'none'] as const) {
      const err = await sandbox.create(spec({ network })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(PolicyDeniedError)
      expect((err as PolicyDeniedError).message).toContain('cannot enforce')
    }
    await expect(sandbox.create(spec({ network: 'open' }))).resolves.toBeTruthy()
  })

  it('the sandbox factory refuses a local-process runtime that asks for restricted/none', () => {
    expect(() =>
      createSandboxManager(
        configWith({
          sandbox: { kind: 'local-process', local_process_acknowledged: true },
          runtime: { network_policy: 'restricted' },
        }),
      ),
    ).toThrowError(ValidationError)
  })

  it('the sandbox factory refuses a local-process Ship override even when the runtime default is open', () => {
    for (const policy of ['restricted', 'none'] as const) {
      expect(() =>
        createSandboxManager(
          configWith({
            sandbox: { kind: 'local-process', local_process_acknowledged: true },
            runtime: { network_policy: 'open' },
            ships: {
              manager: {
                display_name: 'Manager',
                role: 'supervisor',
                engine: 'mock',
                model: 'm',
                workspace_policy: 'coordinator-read-only',
              },
              'worker-a': {
                display_name: 'A',
                role: 'coder',
                engine: 'mock',
                model: 'm',
                network_policy: policy,
              },
            },
          }),
        ),
      ).toThrowError(new RegExp(`cannot enforce network_policy '${policy}' for ship 'worker-a'`))
    }
  })
})
