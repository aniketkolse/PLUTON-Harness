import { describe, expect, it } from 'vitest'
import { PolicyDeniedError, SandboxUnavailableError } from '../../src/domain/errors.ts'
import {
  PLATFORM_KEYS,
  assertOrchestratedNetworkPolicy,
  assertPolicySupported,
  enforcementFor,
  platformKey,
  resolveEffectiveMode,
  resolveEffectiveNetwork,
  type EffectiveExecutionPolicy,
  type NativeCapabilities,
} from '../../src/execution/policy.ts'

function capabilities(overrides: Partial<NativeCapabilities> = {}): NativeCapabilities {
  return {
    platform: 'linux',
    arch: 'x64',
    kernelRelease: '6.8.0',
    landlockAbi: 3,
    userNamespaces: true,
    mountNamespaces: true,
    networkNamespaces: true,
    pidNamespaces: true,
    cgroupV2: true,
    helper: { available: true, version: '1.0.0', sha256: 'a'.repeat(64) },
    runtimeRoots: ['/usr/bin'],
    ...overrides,
  }
}

function policy(overrides: Partial<EffectiveExecutionPolicy> = {}): EffectiveExecutionPolicy {
  return { platform: 'linux', mode: 'workspace-write', network: 'open', ...overrides }
}

describe('native policy vocabulary', () => {
  it('exposes the three supported platform keys', () => {
    expect(PLATFORM_KEYS).toEqual(['linux', 'darwin', 'win32'])
  })

  it('maps supported Node platforms and rejects everything else', () => {
    expect(platformKey('linux')).toBe('linux')
    expect(platformKey('darwin')).toBe('darwin')
    expect(platformKey('win32')).toBe('win32')
    expect(() => platformKey('freebsd' as NodeJS.Platform)).toThrow(SandboxUnavailableError)
    expect(() => platformKey('freebsd' as NodeJS.Platform)).toThrow(/unsupported native execution platform 'freebsd'/)
  })

  it('resolves a per-platform mode override before the shared default', () => {
    expect(
      resolveEffectiveMode({
        mode: 'workspace-write',
        modeByPlatform: { win32: 'unconfined', darwin: 'unconfined' },
        platform: 'win32',
      }),
    ).toBe('unconfined')
    expect(
      resolveEffectiveMode({
        mode: 'workspace-write',
        modeByPlatform: { win32: 'unconfined' },
        platform: 'linux',
      }),
    ).toBe('workspace-write')
    expect(resolveEffectiveMode({ mode: 'read-only', platform: 'linux' })).toBe('read-only')
  })

  it('lets a Ship network policy override the runtime policy', () => {
    expect(resolveEffectiveNetwork({ runtimePolicy: 'open' })).toBe('open')
    expect(resolveEffectiveNetwork({ runtimePolicy: 'open', shipPolicy: 'restricted' })).toBe('restricted')
    expect(resolveEffectiveNetwork({ runtimePolicy: 'restricted', shipPolicy: 'none' })).toBe('none')
  })
})

describe('native policy acceptance', () => {
  it('rejects a policy/capability platform mismatch', () => {
    expect(() =>
      assertPolicySupported(policy({ platform: 'darwin' }), capabilities({ platform: 'linux' })),
    ).toThrow(/does not match capability platform/)
  })

  it('accepts unconfined + open on macOS and Windows and rejects everything else', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(() =>
        assertPolicySupported(
          policy({ platform, mode: 'unconfined', network: 'open' }),
          capabilities({ platform }),
        ),
      ).not.toThrow()
    }

    for (const platform of ['darwin', 'win32'] as const) {
      expect(() =>
        assertPolicySupported(
          policy({ platform, mode: 'workspace-write', network: 'open' }),
          capabilities({ platform }),
        ),
      ).toThrow(/no verified filesystem or network confinement/)

      expect(() =>
        assertPolicySupported(
          policy({ platform, mode: 'unconfined', network: 'restricted' }),
          capabilities({ platform }),
        ),
      ).toThrow(/no verified filesystem or network confinement/)
    }
  })

  it('accepts Linux unconfined + open and rejects unconfined + confined networks', () => {
    expect(() =>
      assertPolicySupported(policy({ mode: 'unconfined', network: 'open' }), capabilities()),
    ).not.toThrow()

    for (const network of ['restricted', 'none'] as const) {
      expect(() =>
        assertPolicySupported(policy({ mode: 'unconfined', network }), capabilities()),
      ).toThrow(/an unconfined process shares the host network/)
    }
  })

  it('requires a verified helper for confined Linux modes', () => {
    expect(() =>
      assertPolicySupported(
        policy(),
        capabilities({ helper: { available: false, version: null, sha256: null, detail: 'helper missing' } }),
      ),
    ).toThrow(/helper missing/)

    expect(() =>
      assertPolicySupported(
        policy(),
        capabilities({ helper: { available: false, version: null, sha256: null } }),
      ),
    ).toThrow(/the verified native helper is unavailable/)
  })

  it('requires Landlock ABI 3 or newer for confined Linux modes', () => {
    for (const abi of [null, 1, 2]) {
      expect(() =>
        assertPolicySupported(policy(), capabilities({ landlockAbi: abi })),
      ).toThrow(/Landlock ABI 3 or newer is required/)
    }
    expect(() =>
      assertPolicySupported(policy(), capabilities({ landlockAbi: 4 })),
    ).not.toThrow()
  })

  it('requires both user and network namespaces for restricted/none networks', () => {
    for (const network of ['restricted', 'none'] as const) {
      expect(() =>
        assertPolicySupported(
          policy({ network }),
          capabilities({ userNamespaces: false }),
        ),
      ).toThrow(/unprivileged user and network namespaces are required/)

      expect(() =>
        assertPolicySupported(
          policy({ network }),
          capabilities({ networkNamespaces: false }),
        ),
      ).toThrow(/unprivileged user and network namespaces are required/)
    }

    expect(() =>
      assertPolicySupported(
        policy({ network: 'restricted' }),
        capabilities({ userNamespaces: false, networkNamespaces: false }),
      ),
    ).toThrow(/unprivileged user and network namespaces are required/)
  })

  it('does not require namespaces for an open network', () => {
    expect(() =>
      assertPolicySupported(
        policy({ network: 'open' }),
        capabilities({ userNamespaces: false, networkNamespaces: false }),
      ),
    ).not.toThrow()
  })
})

describe('native enforcement reporting', () => {
  it('reports no confinement for unconfined sessions', () => {
    const report = enforcementFor(
      policy({ mode: 'unconfined', network: 'open' }),
      capabilities({ landlockAbi: null, mountNamespaces: false, pidNamespaces: false }),
    )
    expect(report).toMatchObject({
      filesystem: 'none',
      network: 'host',
      mountNamespace: false,
      pidNamespace: false,
      privateTmp: false,
      processTreeKill: true,
      resourceLimits: false,
      osConfinement: false,
    })
    expect(report.limitations).toHaveLength(3)
  })

  it('reports Landlock and a private network namespace for confined restricted sessions', () => {
    const report = enforcementFor(policy({ network: 'restricted' }), capabilities())
    expect(report).toMatchObject({
      filesystem: 'landlock',
      network: 'netns',
      mountNamespace: true,
      pidNamespace: true,
      privateTmp: true,
      osConfinement: true,
    })
    expect(report.limitations).toContain(
      'no external network or DNS; the session tool bridge is the only reachable service',
    )
  })

  it('reports no network at all for the none policy', () => {
    const report = enforcementFor(policy({ network: 'none' }), capabilities())
    expect(report.network).toBe('none')
    expect(report.limitations).toContain('no network at all, including the tool bridge and loopback')
  })

  it('records missing mount and PID namespaces as limitations instead of claiming them', () => {
    const report = enforcementFor(
      policy({ network: 'open' }),
      capabilities({ mountNamespaces: false, pidNamespaces: false }),
    )
    expect(report.mountNamespace).toBe(false)
    expect(report.privateTmp).toBe(false)
    expect(report.pidNamespace).toBe(false)
    expect(report.limitations).toContain(
      'mount namespace unavailable: /tmp is not private; only the session tmp directory is writable',
    )
  })
})

describe('orchestrated network policy', () => {
  it('rejects none for every orchestrated command', () => {
    for (const command of ['run', 'chat', 'server'] as const) {
      expect(() => assertOrchestratedNetworkPolicy('none', command)).toThrow(PolicyDeniedError)
      expect(() => assertOrchestratedNetworkPolicy('none', command)).toThrow(
        new RegExp(`network_policy: none cannot be used with pluton ${command}`),
      )
    }
  })

  it('accepts open and restricted orchestrated sessions', () => {
    expect(() => assertOrchestratedNetworkPolicy('open', 'run')).not.toThrow()
    expect(() => assertOrchestratedNetworkPolicy('restricted', 'chat')).not.toThrow()
    expect(() => assertOrchestratedNetworkPolicy('open', 'server')).not.toThrow()
  })
})
