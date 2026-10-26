import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { prepareContainerMode } from '../../src/cli/commands/run.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { SandboxUnavailableError } from '../../src/domain/errors.ts'
import type { WorkerImageProbe } from '../../src/sandbox/image.ts'
import { FakeSandbox, failResult, okResult } from '../helpers/fake-sandbox.ts'

/**
 * Wiring-level evidence for the restricted-network contract: `prepareContainerMode`
 * must ensure the internal network, provision every Ship onto it, and refuse to
 * hand back any container whose egress could not be proven blocked. The fake
 * manager keeps this Docker-free; the real-container adversarial test lives in
 * tests/e2e (gated on a daemon).
 */

const tmpDirs: string[] = []
const stores: Array<{ close(): void }> = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CONFIG = `version: 1
project:
  name: restricted-wiring
  repository: .
  default_branch: main
sandbox:
  kind: docker
  image: pluton-worker:engines
runtime:
  network_policy: restricted
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model
    workspace_policy: coordinator-read-only
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model
`

function fixture(): { ctx: ProjectContext; store: ReturnType<typeof bootstrapStore>['store']; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-restricted-wiring-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG, 'utf8')
  const loaded = loadConfig(dir)
  const ctx: ProjectContext = { rootDir: dir, configPath: join(dir, 'pluton.yaml'), loaded }
  const { store, projectId } = bootstrapStore(loaded)
  stores.push(store)
  return { ctx, store, projectId }
}

const ENGINE_PROBE: WorkerImageProbe = {
  present: true,
  image: 'pluton-worker:engines',
  imageId: 'sha256:restricted-fixture',
  record: {
    image: 'pluton-worker:engines',
    imageId: 'sha256:restricted-fixture',
    profile: 'engines',
    tmuxVersion: 'tmux 3.3a',
    nodeVersion: 'v24.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  },
  matchesRecord: true,
  detail: 'fixture: engines profile present',
}

describe('prepareContainerMode — restricted network wiring', () => {
  it('provisions every Ship onto the internal network and probes each container', async () => {
    const { ctx, store, projectId } = fixture()
    const sandbox = new FakeSandbox()
    sandbox.statusResult = 'missing'
    sandbox.execQueue.push(okResult([], 'PLUTON_EGRESS_BLOCKED\n'), okResult([], 'PLUTON_EGRESS_BLOCKED\n'))

    const contexts = await prepareContainerMode(ctx, store, projectId, sandbox, () => Promise.resolve(ENGINE_PROBE))

    expect(contexts.size).toBe(2)
    expect(sandbox.ensureNetworkCalls).toEqual([`pluton-restricted-${projectId}`])
    expect(sandbox.created.map((spec) => spec.network)).toEqual(['restricted', 'restricted'])
    expect(new Set(sandbox.created.map((spec) => spec.customNetwork))).toEqual(
      new Set([`pluton-restricted-${projectId}`]),
    )
    expect(sandbox.execCalls).toHaveLength(2)
    expect(sandbox.execCalls.every((call) => call.argv[0] === 'node' && call.argv[1] === '-e')).toBe(true)
  })

  it('refuses the whole run when a container can still reach the internet', async () => {
    const { ctx, store, projectId } = fixture()
    const sandbox = new FakeSandbox()
    sandbox.statusResult = 'missing'
    sandbox.execQueue.push(okResult([], 'PLUTON_EGRESS_OPEN\n'))

    await expect(
      prepareContainerMode(ctx, store, projectId, sandbox, () => Promise.resolve(ENGINE_PROBE)),
    ).rejects.toThrowError(SandboxUnavailableError)
  })

  it('refuses the run when the probe cannot produce a verdict', async () => {
    const { ctx, store, projectId } = fixture()
    const sandbox = new FakeSandbox()
    sandbox.statusResult = 'missing'
    sandbox.execQueue.push(failResult([], 'node: not found', 127))

    await expect(
      prepareContainerMode(ctx, store, projectId, sandbox, () => Promise.resolve(ENGINE_PROBE)),
    ).rejects.toThrowError(SandboxUnavailableError)
  })

  it('does not probe open-policy containers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-open-wiring-'))
    tmpDirs.push(dir)
    writeFileSync(join(dir, 'pluton.yaml'), CONFIG.replace('network_policy: restricted', 'network_policy: open'), 'utf8')
    const loaded = loadConfig(dir)
    const ctx: ProjectContext = { rootDir: dir, configPath: join(dir, 'pluton.yaml'), loaded }
    const { store, projectId } = bootstrapStore(loaded)
    stores.push(store)

    const sandbox = new FakeSandbox()
    sandbox.statusResult = 'missing'
    const contexts = await prepareContainerMode(ctx, store, projectId, sandbox, () => Promise.resolve(ENGINE_PROBE))

    expect(contexts.size).toBe(2)
    expect(sandbox.ensureNetworkCalls).toEqual([])
    expect(sandbox.execCalls).toEqual([])
    expect(sandbox.created.map((spec) => spec.network)).toEqual(['open', 'open'])
  })
})
