import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, validateConfig } from '../../src/config/load.ts'
import { plutonConfigSchema } from '../../src/config/schema.ts'
import { SandboxUnavailableError, ValidationError } from '../../src/domain/errors.ts'
import type { MuseRecord } from '../../src/domain/models.ts'
import {
  assertNativeSandboxConfig,
  createNativeExecutionProvider,
  nativeSpecForMuse,
} from '../../src/execution/factory.ts'
import { createSandboxManager } from '../../src/sandbox/factory.ts'

const tmpDirs: string[] = []

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
  const dir = mkdtempSync(join(tmpdir(), 'pluton-native-config-'))
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

  it('refuses native without explicit partial-enforcement acknowledgement', () => {
    const dir = root()
    const loaded = loadConfig(
      (() => {
        const raw = nativeConfig()
        raw.sandbox.native.acknowledge_partial_enforcement = false
        return writeConfig(dir, raw)
      })(),
    )
    expect(() => assertNativeSandboxConfig(loaded.config)).toThrow(SandboxUnavailableError)
    expect(() =>
      createNativeExecutionProvider({ config: loaded.config, rootDir: dir }),
    ).toThrow(SandboxUnavailableError)
  })

  it('refuses native network policies it cannot enforce', () => {
    const dir = root()
    const restricted = nativeConfig()
    restricted.runtime.network_policy = 'restricted'
    const loaded = validateConfig(restricted, dir, join(dir, 'pluton.yaml'))
    expect(() => assertNativeSandboxConfig(loaded.config)).toThrow(SandboxUnavailableError)
    expect(() => assertNativeSandboxConfig(loaded.config)).toThrow(/network_policy: open/)
  })

  it('refuses an unacknowledged host-network mapping', () => {
    const dir = root()
    const raw = nativeConfig()
    raw.sandbox.native.acknowledge_host_network = false
    const loaded = validateConfig(raw, dir, join(dir, 'pluton.yaml'))
    expect(() => assertNativeSandboxConfig(loaded.config)).toThrow(SandboxUnavailableError)
  })

  it('does not select native through the Docker SandboxManager factory', () => {
    const dir = root()
    const loaded = validateConfig(nativeConfig(), dir, join(dir, 'pluton.yaml'))
    expect(() => createSandboxManager(loaded.config)).toThrow(ValidationError)
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
    const workerSpec = nativeSpecForMuse({
      config: loaded.config,
      rootDir: dir,
      projectId: 'project_native',
      muse: worker,
      workdir: join(dir, '.pluton', 'workspaces', 'task'),
      engineHome: worker.engineHome,
      isolatedCheckout: true,
      sessionKind: 'run',
      hostEnv: {},
    })
    expect(workerSpec.mode).toBe('workspace-write')
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
