import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PolicyDeniedError, SandboxUnavailableError } from '../../src/domain/errors.ts'
import {
  ensureMuseContainer,
  HOST_GATEWAY_ADD_HOST,
  type MuseContainerSpec,
} from '../../src/sandbox/muse-containers.ts'
import { sandboxContainerName, type SandboxSpec } from '../../src/sandbox/types.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { FakeSandbox } from '../helpers/fake-sandbox.ts'

/**
 * Per-Muse container provisioning (Phase B / ADR-0004): create-on-first-use,
 * reuse behind the managed-label guard, one SandboxRecord per (project, muse).
 * The fake manager records exact method order; no Docker daemon involved.
 */

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore(name: string): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), `pluton-muse-containers-${name}-`))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'demo',
    rootPath: join(dir, 'repo'),
    configPath: join(dir, 'repo', 'pluton.yaml'),
    defaultBranch: 'main',
  })
  return { store, projectId: project.id }
}

function specFor(projectId: string): MuseContainerSpec {
  return {
    projectId,
    museId: 'worker-a',
    image: 'pluton-worker:engines',
    limits: { cpus: 2, memoryMb: 4096, pids: 512 },
    network: 'restricted',
    mounts: [
      { hostPath: 'C:\\work\\checkout', containerPath: '/work' },
      { hostPath: 'C:\\home\\worker-a', containerPath: '/home/pluton' },
    ],
  }
}

describe('ensureMuseContainer', () => {
  it('creates and starts the container on first use with the host gateway mapping, then records it', async () => {
    const { store, projectId } = freshStore('create')
    const fake = new FakeSandbox()
    fake.statusResult = 'missing'

    const r = await ensureMuseContainer(fake, store, specFor(projectId))
    const containerName = sandboxContainerName(projectId, 'worker-a')
    expect(r).toEqual({ containerName, created: true })
    expect(fake.methods()).toEqual(['status', 'create', 'start'])

    const created = fake.created[0] as SandboxSpec
    expect(created.containerName).toBe(containerName)
    expect(created.projectId).toBe(projectId)
    expect(created.museId).toBe('worker-a')
    expect(created.image).toBe('pluton-worker:engines')
    expect(created.containerUser).toBe('10001:10001')
    expect(created.limits).toEqual({ cpus: 2, memoryMb: 4096, pids: 512 })
    expect(created.network).toBe('restricted')
    expect(created.mounts).toEqual(specFor(projectId).mounts)
    // The bridge host must resolve inside every Muse container.
    expect(created.extraHosts).toEqual([HOST_GATEWAY_ADD_HOST])
    // No secrets (or anything else) in the create-time env.
    expect(created.env).toEqual({})

    const record = store.getSandboxForMuse(projectId, 'worker-a')
    expect(record).toMatchObject({
      containerName,
      state: 'running',
      kind: 'docker',
      image: 'pluton-worker:engines',
      containerId: `cid_${containerName}`,
    })
  })

  it('reuses a running managed container without recreating it, keeping the record id and id', async () => {
    const { store, projectId } = freshStore('reuse')
    const containerName = sandboxContainerName(projectId, 'worker-a')
    const first = store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName,
      containerId: 'cid_existing',
      image: 'pluton-worker:engines',
      state: 'running',
      createdBy: 'run',
    })
    const fake = new FakeSandbox()
    fake.statusResult = 'running'

    const r = await ensureMuseContainer(fake, store, specFor(projectId))
    expect(r).toEqual({ containerName, created: false })
    expect(fake.methods()).toEqual(['status', 'inspect', 'start'])
    expect(fake.created).toHaveLength(0)

    const record = store.getSandboxForMuse(projectId, 'worker-a')
    expect(record?.id).toBe(first.id)
    expect(record?.containerId).toBe('cid_existing')
  })

  it('reuses and starts a stopped managed container, still never recreating it', async () => {
    const { store, projectId } = freshStore('stopped')
    const fake = new FakeSandbox()
    fake.statusResult = 'stopped'

    const r = await ensureMuseContainer(fake, store, specFor(projectId))
    expect(r).toEqual({ containerName: sandboxContainerName(projectId, 'worker-a'), created: false })
    expect(fake.methods()).toEqual(['status', 'inspect', 'start'])
    expect(fake.created).toHaveLength(0)
  })

  it('refuses to adopt a container without the Pluton managed label, creating nothing', async () => {
    const { store, projectId } = freshStore('foreign')
    const fake = new FakeSandbox()
    fake.statusResult = 'running'
    fake.start = (containerName: string) => {
      fake.calls.push({ method: 'start', args: [containerName] })
      return Promise.reject(new PolicyDeniedError("refusing to act on container 'x': it does not carry the Pluton managed label"))
    }

    await expect(ensureMuseContainer(fake, store, specFor(projectId))).rejects.toThrowError(PolicyDeniedError)
    expect(fake.methods()).toEqual(['status', 'inspect', 'start'])
    expect(fake.created).toHaveLength(0)
    expect(store.getSandboxForMuse(projectId, 'worker-a')).toBeNull()
  })

  it('fails closed on an undeterminable container state (daemon down mid-flight)', async () => {
    const { store, projectId } = freshStore('unknown')
    const fake = new FakeSandbox()
    fake.statusResult = 'unknown'

    const err = await ensureMuseContainer(fake, store, specFor(projectId)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain(sandboxContainerName(projectId, 'worker-a'))
    expect(fake.methods()).toEqual(['status'])
    expect(store.getSandboxForMuse(projectId, 'worker-a')).toBeNull()
  })

  it('propagates a failed create (daemon unavailable) and writes no record', async () => {
    const { store, projectId } = freshStore('createfail')
    const fake = new FakeSandbox()
    fake.statusResult = 'missing'
    fake.create = (spec: SandboxSpec) => {
      fake.calls.push({ method: 'create', args: [spec] })
      return Promise.reject(new SandboxUnavailableError('cannot start sandbox: docker daemon not reachable'))
    }

    await expect(ensureMuseContainer(fake, store, specFor(projectId))).rejects.toThrowError(SandboxUnavailableError)
    expect(fake.methods()).toEqual(['status', 'create'])
    expect(store.getSandboxForMuse(projectId, 'worker-a')).toBeNull()
  })

  it('does not carry a stale container id from a record pointing at a different container name', async () => {
    const { store, projectId } = freshStore('stale')
    store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: 'pluton-old-name-worker-a',
      containerId: 'cid_stale',
      image: 'pluton-worker:old',
      state: 'running',
      createdBy: 'run',
    })
    const fake = new FakeSandbox()
    fake.statusResult = 'running'

    await ensureMuseContainer(fake, store, specFor(projectId))
    const record = store.getSandboxForMuse(projectId, 'worker-a')
    expect(record?.containerName).toBe(sandboxContainerName(projectId, 'worker-a'))
    expect(record?.containerId).toBeNull()
    expect(record?.image).toBe('pluton-worker:engines')
  })

  it('recreates a stale container whose image no longer matches the spec (rebuilt worker image)', async () => {
    const { store, projectId } = freshStore('stale-image')
    const fake = new FakeSandbox()
    fake.statusResult = 'running'
    fake.inspectResult = {
      imageId: 'sha256:old',
      user: '10001:10001',
      mounts: specFor(projectId).mounts.map((m) => ({ destination: m.containerPath, readOnly: m.readOnly === true })),
      extraHosts: [HOST_GATEWAY_ADD_HOST],
    }

    const r = await ensureMuseContainer(fake, store, { ...specFor(projectId), imageId: 'sha256:new' })
    expect(r.created).toBe(true)
    expect(fake.methods()).toEqual(['status', 'inspect', 'remove', 'create', 'start'])
    expect(fake.created).toHaveLength(1)
    expect(store.getSandboxForMuse(projectId, 'worker-a')?.containerId).toBe(`cid_${r.containerName}`)
  })

  it('recreates when the recorded mounts no longer match the spec (workspace-policy change)', async () => {
    const { store, projectId } = freshStore('stale-mounts')
    const fake = new FakeSandbox()
    fake.statusResult = 'stopped'
    fake.inspectResult = {
      imageId: 'sha256:img',
      user: '10001:10001',
      mounts: [{ destination: '/work', readOnly: false }], // '/home/pluton' is gone
      extraHosts: [HOST_GATEWAY_ADD_HOST],
    }

    const r = await ensureMuseContainer(fake, store, { ...specFor(projectId), imageId: 'sha256:img' })
    expect(r.created).toBe(true)
    expect(fake.methods()).toEqual(['status', 'inspect', 'remove', 'create', 'start'])
  })

  it('reuses a container only when image id, user, mounts and gateway all still match', async () => {
    const { store, projectId } = freshStore('matching')
    store.upsertSandbox({
      projectId,
      museId: 'worker-a',
      kind: 'docker',
      containerName: sandboxContainerName(projectId, 'worker-a'),
      containerId: 'cid_match',
      image: 'pluton-worker:engines',
      state: 'running',
      createdBy: 'run',
    })
    const fake = new FakeSandbox()
    fake.statusResult = 'running'
    fake.inspectResult = {
      imageId: 'sha256:img',
      user: '10001:10001',
      mounts: specFor(projectId).mounts.map((m) => ({ destination: m.containerPath, readOnly: m.readOnly === true })),
      extraHosts: [HOST_GATEWAY_ADD_HOST],
    }

    const r = await ensureMuseContainer(fake, store, { ...specFor(projectId), imageId: 'sha256:img' })
    expect(r.created).toBe(false)
    expect(fake.methods()).toEqual(['status', 'inspect', 'start'])
    expect(fake.created).toHaveLength(0)
    expect(store.getSandboxForMuse(projectId, 'worker-a')?.containerId).toBe('cid_match')
  })
})
