import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, validateConfig } from '../../src/config/load.ts'
import { plutonConfigSchema } from '../../src/config/schema.ts'
import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import {
  assertNativeSandboxConfig,
  assertNativeSandboxKind,
  createNativeExecutionProvider,
  nativeSpecForMuse,
} from '../../src/execution/factory.ts'
import type { NativeCapabilities } from '../../src/execution/policy.ts'

const tmpDirs: string[] = []

/**
 * Explicit capability fixtures keep these config-gate tests independent of the
 * host kernel and of whether the checked-out helper happens to be executable.
 * Actual detection is covered by native-capabilities.test.ts.
 */
const linuxCapabilities: NativeCapabilities = {
  platform: 'linux',
  arch: 'x64',
  kernelRelease: '6.8.0-test',
  landlockAbi: 6,
  userNamespaces: true,
  mountNamespaces: true,
  networkNamespaces: true,
  pidNamespaces: true,
  cgroupV2: true,
  helper: { available: true, version: '0.1.0', sha256: 'a'.repeat(64) },
  runtimeRoots: [],
}

const linuxWithoutHelper: NativeCapabilities = {
  ...linuxCapabilities,
  landlockAbi: null,
  helper: { available: false, version: null, sha256: null, detail: 'native helper is missing' },
}

const linuxWithoutNetworkNamespaces: NativeCapabilities = {
  ...linuxCapabilities,
  networkNamespaces: false,
}

const linuxWithoutNamespaces: NativeCapabilities = {
  ...linuxCapabilities,
  mountNamespaces: false,
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function nativeConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: {
      name: 'native-demo',
      repository: '.',
      default_branch: 'main',
      verification: [],
    },
    runtime: {
      network_policy: 'open',
    },
    sandbox: {
      kind: 'native',
      native: {
        mode: 'workspace-write',
        acknowledge_partial_enforcement: true,
        acknowledge_host_network: true,
        env_allowlist: ['PLUTON_NATIVE_TOKEN'],
      },
    },
    muses: {
      manager: {
        display_name: 'Manager',
        role: 'supervisor',
        engine: 'mock',
        model: 'mock/model',
        workspace_policy: 'coordinator-read-only',
      },
      coder: {
        display_name: 'Coder',
        role: 'coder',
        engine: 'mock',
        model: 'mock/model',
        workspace_policy: 'isolated-task-checkout',
      },
    },
    ...overrides,
  }
}

function root(): string {
  // Canonicalize so allowed-root comparisons use the same identity the
  // execution layer derives on macOS (/var vs /private/var) and Windows
  // runners (8.3 RUNNER~1 vs the long profile name).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-native-config-')))
  tmpDirs.push(dir)
  return dir
}

function muse(overrides: Partial<MuseRecord> = {}): MuseRecord {
  const dir = root()
  return {
    id: 'coder',
    projectId: 'project_native',
    slug: 'coder',
    displayName: 'Coder',
    role: 'coder',
    engineKind: 'mock',
    model: 'mock/model',
    instructionsFile: null,
    workspacePolicy: 'isolated-task-checkout',
    permissions: [],
    approvalMode: 'ask-for-sensitive-actions',
    engineHome: join(dir, '.pluton', 'engine-homes', 'coder'),
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('native execution config', () => {
  it('defaults native policy fields and defaults sandbox to native', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    expect(loaded.config.sandbox.kind).toBe('native')
    expect(loaded.config.sandbox.native.mode).toBe('workspace-write')
    expect(loaded.config.sandbox.native.env_allowlist).toEqual(['PLUTON_NATIVE_TOKEN'])

    const def = plutonConfigSchema.parse({
      version: 1,
      project: { name: 'default-demo' },
    })
    expect(def.sandbox.kind).toBe('native')
    expect(def.runtime.network_policy).toBe('open')

    const docker = plutonConfigSchema.parse({
      version: 1,
      project: { name: 'docker-demo' },
      sandbox: { kind: 'docker' },
    })
    expect(docker.sandbox.kind).toBe('docker')
  })

  it('does not gate on deprecated acknowledgement keys', () => {
    const dir = root()
    const loaded = loadConfig(
      (() => {
        const raw = nativeConfig()
        raw.sandbox.native.acknowledge_partial_enforcement = false
        raw.sandbox.native.acknowledge_host_network = false
        return writeConfig(dir, raw)
      })(),
    )
    // docs/MIGRATION.md: the deprecated keys still parse but grant/gate nothing.
    expect(() => assertNativeSandboxConfig(loaded.config, linuxCapabilities)).not.toThrow()
    expect(
      createNativeExecutionProvider({
        config: loaded.config,
        rootDir: dir,
        capabilities: linuxCapabilities,
      }),
    ).toBeDefined()
  })

  it('accepts a restricted network policy only when the host can enforce it', () => {
    const dir = root()
    const restricted = nativeConfig()
    restricted.runtime.network_policy = 'restricted'
    const loaded = validateConfig(restricted, dir, join(dir, 'pluton.yaml'))

    expect(() => assertNativeSandboxConfig(loaded.config, linuxCapabilities)).not.toThrow()
    expect(() => assertNativeSandboxConfig(loaded.config, linuxWithoutNetworkNamespaces)).toThrow(
      SandboxUnavailableError,
    )
    expect(() => assertNativeSandboxConfig(loaded.config, linuxWithoutNetworkNamespaces)).toThrow(
      /network_policy: open/,
    )
  })

  it('fails closed when the verified helper is unavailable', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    expect(() => assertNativeSandboxConfig(loaded.config, linuxWithoutHelper)).toThrow(
      SandboxUnavailableError,
    )
  })

  it('fails closed when the host cannot create the namespaces confinement requires', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    // A verified helper and Landlock without user/mount/PID namespaces cannot
    // confine a process; assertNativeSandboxConfig must refuse before a run
    // starts rather than letting prepare() fail later.
    expect(() => assertNativeSandboxConfig(loaded.config, linuxWithoutNamespaces)).toThrow(
      SandboxUnavailableError,
    )
    expect(() => assertNativeSandboxConfig(loaded.config, linuxWithoutNamespaces)).toThrow(
      /user, mount and PID namespaces/,
    )
  })

  it('tolerates unparsed native config with missing optional fields without NaN session timeouts', () => {
    const dir = root()
    const raw = nativeConfig({
      sandbox: {
        kind: 'native',
        native: {
          mode: 'workspace-write',
          mode_by_platform: { win32: 'unconfined', darwin: 'unconfined' },
          acknowledge_unconfined: true,
          acknowledge_partial_enforcement: true,
          acknowledge_host_network: true,
        },
      },
    })
    delete (raw.sandbox.native as Record<string, unknown>).session_timeout_minutes
    delete (raw.sandbox.native as Record<string, unknown>).terminate_grace_seconds
    delete (raw.sandbox.native as Record<string, unknown>).max_output_bytes
    const provider = createNativeExecutionProvider({
      config: raw as any,
      rootDir: dir,
      capabilities: linuxCapabilities,
    })
    expect(provider).toBeDefined()
    expect(provider['sessionTimeoutMs']).toBe(0)
    expect(provider['terminateGraceMs']).toBe(2000)
    expect(provider['maxOutputBytes']).toBe(1048576)
  })

  it('rejects legacy sandbox configs with explicit migration guidance', () => {
    const dir = root()
    const dockerCfg = validateConfig(nativeConfig({ sandbox: { kind: 'docker' } }), dir, join(dir, 'pluton.yaml'))
    expect(() => assertNativeSandboxConfig(dockerCfg.config)).toThrow(SandboxUnavailableError)
    const localCfg = validateConfig(nativeConfig({ sandbox: { kind: 'local-process' } }), dir, join(dir, 'pluton.yaml'))
    expect(() => assertNativeSandboxConfig(localCfg.config)).toThrow(SandboxUnavailableError)
  })

  it('derives read-only manager/chat sessions and workspace-write isolated workers', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    const manager = muse({
      id: 'manager',
      slug: 'manager',
      role: 'supervisor',
      workspacePolicy: 'coordinator-read-only',
      engineHome: join(dir, '.pluton', 'engine-homes', 'manager'),
    })
    const managerSpec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: manager,
      workdir: dir,
      engineHome: manager.engineHome,
      isolatedCheckout: false,
      sessionKind: 'run',
      hostEnv: { PLUTON_NATIVE_TOKEN: 'token-value' },
    })
    expect(managerSpec.mode).toBe('read-only')
    expect(managerSpec.network).toBe('open')
    expect(managerSpec.env).toEqual({ PLUTON_NATIVE_TOKEN: 'token-value' })
    expect(managerSpec.allowedRoots).toContain(join(dir, '.pluton', 'workspaces'))
    expect(managerSpec.allowedRoots).toContain(join(dir, '.pluton', 'engine-homes'))

    const chatSpec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: manager,
      workdir: dir,
      engineHome: manager.engineHome,
      isolatedCheckout: false,
      sessionKind: 'chat',
      hostEnv: {},
    })
    expect(chatSpec.mode).toBe('read-only')

    const worker = muse()
    const extraRoot = root()
    const workerWorkdir = join(dir, '.pluton', 'workspaces', 'task')
    const workerSpec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: worker,
      workdir: workerWorkdir,
      engineHome: worker.engineHome,
      isolatedCheckout: true,
      sessionKind: 'run',
      extraAllowedRoots: [extraRoot],
      hostEnv: {},
    })
    expect(workerSpec.mode).toBe('workspace-write')
    // An isolated worker gets only its checkout and its own engine home. The
    // project root, shared workspaces, the engine-homes parent and session
    // extra roots are not worker capabilities.
    expect(workerSpec.allowedRoots).toHaveLength(2)
    expect(workerSpec.allowedRoots).toContain(workerWorkdir)
    expect(workerSpec.allowedRoots).toContain(worker.engineHome)
    expect(workerSpec.allowedRoots).not.toContain(dir)
    expect(workerSpec.allowedRoots).not.toContain(join(dir, '.pluton', 'workspaces'))
    expect(workerSpec.allowedRoots).not.toContain(join(dir, '.pluton', 'engine-homes'))
    expect(workerSpec.allowedRoots).not.toContain(extraRoot)
  })

  it('accepts a checkout directory whose name starts with dots but stays inside workspaces', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    const coder = muse()
    const checkout = join(dir, '.pluton', 'workspaces', '..cache')
    mkdirSync(checkout, { recursive: true })

    const spec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: coder,
      workdir: checkout,
      engineHome: coder.engineHome,
      isolatedCheckout: true,
      sessionKind: 'run',
      hostEnv: {},
    })
    expect(spec.mode).toBe('workspace-write')
  })

  it('refuses a run session that reports no checkout for an isolated-policy muse', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    const coder = muse()
    const build = (): unknown =>
      nativeSpecForMuse({
        config: loaded.config,
        rootDir: dir,
        projectId: 'project_native',
        muse: coder,
        workdir: dir,
        engineHome: coder.engineHome,
        isolatedCheckout: false,
        sessionKind: 'run',
        hostEnv: {},
      })
    expect(build).toThrow(PolicyDeniedError)
    expect(build).toThrow(/isolated task checkout/)
  })

  it('refuses an isolated worker whose workdir is not inside .pluton/workspaces', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    const coder = muse()
    expect(() =>
      nativeSpecForMuse({
        config: loaded.config,
        rootDir: dir,
        projectId: 'project_native',
        muse: coder,
        workdir: dir,
        engineHome: coder.engineHome,
        isolatedCheckout: true,
        sessionKind: 'run',
        hostEnv: {},
      }),
    ).toThrow(PolicyDeniedError)
    expect(() =>
      nativeSpecForMuse({
        config: loaded.config,
        rootDir: dir,
        projectId: 'project_native',
        muse: coder,
        workdir: join(dir, '.pluton', 'engine-homes', 'coder'),
        engineHome: coder.engineHome,
        isolatedCheckout: true,
        sessionKind: 'run',
        hostEnv: {},
      }),
    ).toThrow(PolicyDeniedError)
  })

  it('refuses an isolated workspace symlink that resolves to the project root', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    const coder = muse()
    const workspaces = join(dir, '.pluton', 'workspaces')
    mkdirSync(workspaces, { recursive: true })
    const link = join(workspaces, 'task')
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() =>
      nativeSpecForMuse({
        config: loaded.config,
        rootDir: dir,
        projectId: 'project_native',
        muse: coder,
        workdir: link,
        engineHome: coder.engineHome,
        isolatedCheckout: true,
        sessionKind: 'run',
        hostEnv: {},
      }),
    ).toThrow(PolicyDeniedError)
  })

  it('honours a read-only native mode as a hard ceiling', () => {
    const dir = root()
    const raw = nativeConfig()
    raw.sandbox.native.mode = 'read-only'
    const loaded = validateConfig(raw, dir, join(dir, 'pluton.yaml'))
    const coder = muse()
    const spec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: coder,
      workdir: join(dir, '.pluton', 'workspaces', 'task'),
      engineHome: coder.engineHome,
      isolatedCheckout: true,
      sessionKind: 'run',
      hostEnv: {},
    })
    expect(spec.mode).toBe('read-only')
  })

  it('rejects unsafe environment allowlist names at config load', () => {
    const dir = root()
    const raw = nativeConfig()
    raw.sandbox.native.env_allowlist = ['NOT-A-NAME']
    expect(() => validateConfig(raw, dir, join(dir, 'pluton.yaml'))).toThrow(/env_allowlist/)
  })
})

function writeConfig(dir: string, raw: unknown): string {
  const path = join(dir, 'pluton.yaml')
  writeFileSync(path, JSON.stringify(raw, null, 2), 'utf8')
  return path
}
