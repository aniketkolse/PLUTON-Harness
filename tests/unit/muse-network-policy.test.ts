import { describe, expect, it } from 'vitest'
import { DockerSandboxManager } from '../../src/sandbox/docker.ts'
import type { SandboxSpec } from '../../src/sandbox/types.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import { plutonConfigSchema } from '../../src/config/schema.ts'

const baseSpec: SandboxSpec = {
  projectId: 'proj_1',
  museId: 'muse_1',
  image: 'pluton-worker:dev',
  containerName: 'pluton-test-c1',
  containerUser: '10001:10001',
  limits: { cpus: 1, memoryMb: 512, pids: 64 },
  mounts: [],
  env: {},
  network: 'restricted',
}

describe('PR-4: Structured Network Policy (per-Muse override and custom internal network)', () => {
  it('DockerSandboxManager.buildCreateArgs uses customNetwork for restricted policy when configured', () => {
    const argv = DockerSandboxManager.buildCreateArgs({
      ...baseSpec,
      network: 'restricted',
      customNetwork: 'pluton-isolated-net',
    })
    const netIdx = argv.indexOf('--network')
    expect(netIdx).toBeGreaterThan(-1)
    expect(argv[netIdx + 1]).toBe('pluton-isolated-net')
  })

  it('DockerSandboxManager.buildCreateArgs honors network: none even if customNetwork is set', () => {
    const argv = DockerSandboxManager.buildCreateArgs({
      ...baseSpec,
      network: 'none',
      customNetwork: 'pluton-isolated-net',
    })
    const netIdx = argv.indexOf('--network')
    expect(netIdx).toBeGreaterThan(-1)
    expect(argv[netIdx + 1]).toBe('none')
  })

  it('DockerSandboxManager.buildCreateArgs validates customNetwork identifier', () => {
    expect(() =>
      DockerSandboxManager.buildCreateArgs({
        ...baseSpec,
        customNetwork: 'bad network name with spaces',
      }),
    ).toThrowError(ValidationError)

    expect(() =>
      DockerSandboxManager.buildCreateArgs({
        ...baseSpec,
        customNetwork: ';rm -rf /',
      }),
    ).toThrowError(ValidationError)
  })

  it('validates config schema with per-Muse network_policy and runtime internal_network_name', () => {
    const raw = {
      version: 1,
      project: { name: 'net-test', repository: '.', default_branch: 'main', verification: [] },
      runtime: {
        network_policy: 'restricted',
        internal_network_name: 'pluton_internal_sandbox',
      },
      muses: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'coordinator-read-only',
        },
        'offline-reviewer': {
          display_name: 'Offline Reviewer',
          role: 'reviewer',
          engine: 'mock',
          model: 'mock/model',
          network_policy: 'none',
        },
        'web-searcher': {
          display_name: 'Web Searcher',
          role: 'researcher',
          engine: 'mock',
          model: 'mock/model',
          network_policy: 'open',
        },
      },
    }

    const parsed = plutonConfigSchema.parse(raw)
    expect(parsed.runtime.network_policy).toBe('restricted')
    expect(parsed.runtime.internal_network_name).toBe('pluton_internal_sandbox')
    expect(parsed.muses['offline-reviewer']?.network_policy).toBe('none')
    expect(parsed.muses['web-searcher']?.network_policy).toBe('open')
    expect(parsed.muses['manager']?.network_policy).toBeUndefined()
  })

  it('rejects invalid internal_network_name in runtime config', () => {
    const raw = {
      version: 1,
      project: { name: 'net-test', repository: '.', default_branch: 'main', verification: [] },
      runtime: {
        internal_network_name: 'invalid network!name',
      },
      muses: {
        manager: {
          display_name: 'Manager',
          role: 'supervisor',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'coordinator-read-only',
        },
      },
    }

    expect(() => plutonConfigSchema.parse(raw)).toThrow()
  })
})
