import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { resolveContainerUser } from '../../src/sandbox/user-mapping.ts'
import { ensureMuseContainer, type MuseContainerSpec } from '../../src/sandbox/ship-containers.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { FakeSandbox } from '../helpers/fake-sandbox.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function freshStore(name: string): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), `pluton-user-map-${name}-`))
  tmpDirs.push(dir)
  const db = openDatabase(join(dir, 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'user-mapping-demo',
    rootPath: join(dir, 'repo'),
    configPath: join(dir, 'repo', 'pluton.yaml'),
    defaultBranch: 'main',
  })
  return { store, projectId: project.id }
}

describe('container user mapping and file ownership alignment', () => {
  it('resolves explicit non-root containerUser from configuration', () => {
    const res = resolveContainerUser({ configured: '1000:1000' })
    expect(res.containerUser).toBe('1000:1000')
    expect(res.source).toBe('configured')
  })

  it('rejects root container user in configuration to enforce container security boundary', () => {
    expect(() => resolveContainerUser({ configured: '0' })).toThrowError(ValidationError)
    expect(() => resolveContainerUser({ configured: '0:0' })).toThrowError(ValidationError)
    expect(() => resolveContainerUser({ configured: '0:1000' })).toThrowError(ValidationError)
  })

  it('rejects malformed container user specifications', () => {
    expect(() => resolveContainerUser({ configured: 'root' })).toThrowError(ValidationError)
    expect(() => resolveContainerUser({ configured: 'pluton' })).toThrowError(ValidationError)
    expect(() => resolveContainerUser({ configured: '1000:root' })).toThrowError(ValidationError)
  })

  it('respects PLUTON_CONTAINER_USER environment override', () => {
    const res = resolveContainerUser({
      configured: 'auto',
      envUser: '1002:1002',
    })
    expect(res.containerUser).toBe('1002:1002')
    expect(res.source).toBe('env')
  })

  it('resolves POSIX host UID/GID when auto/host requested and host user is non-root', () => {
    const res = resolveContainerUser({
      configured: 'auto',
      platform: 'linux',
      getuid: () => 1005,
      getgid: () => 1005,
    })
    expect(res.containerUser).toBe('1005:1005')
    expect(res.source).toBe('host-detected')
  })

  it('falls back to 10001:10001 with a warning if host user is root (0) on Linux to avoid root container execution', () => {
    const res = resolveContainerUser({
      configured: 'auto',
      platform: 'linux',
      getuid: () => 0,
      getgid: () => 0,
    })
    expect(res.containerUser).toBe('10001:10001')
    expect(res.source).toBe('default')
    expect(res.warning).toContain('root')
  })

  it('defaults to 10001:10001 on Windows platform', () => {
    const res = resolveContainerUser({
      configured: 'auto',
      platform: 'win32',
    })
    expect(res.containerUser).toBe('10001:10001')
    expect(res.source).toBe('default')
  })

  it('passes configured containerUser to container creation in ensureMuseContainer and detects user mismatch on reuse', async () => {
    const { store, projectId } = freshStore('user-spec')
    const fake = new FakeSandbox()
    fake.statusResult = 'missing'

    const spec: MuseContainerSpec = {
      projectId,
      museId: 'worker-user-test',
      image: 'pluton-worker:engines',
      limits: { cpus: 2, memoryMb: 4096, pids: 512 },
      network: 'restricted',
      customNetwork: 'pluton-restricted',
      containerUser: '1000:1000',
      mounts: [{ hostPath: 'C:\\work\\checkout', containerPath: '/work' }],
    }

    const createdResult = await ensureMuseContainer(fake, store, spec)
    expect(createdResult.created).toBe(true)
    expect(fake.created[0]?.containerUser).toBe('1000:1000')

    // Simulate inspection showing existing container was created with 10001:10001
    fake.statusResult = 'running'
    fake.inspectResult = {
      imageId: 'sha256:1111',
      user: '10001:10001', // old user mismatch!
      extraHosts: ['host.docker.internal:host-gateway'],
      networks: ['pluton-restricted'],
      mounts: [{ destination: '/work', readOnly: false }],
    }

    // Must detect stale user mapping and recreate with 1000:1000
    fake.created.length = 0
    const reuseResult = await ensureMuseContainer(fake, store, spec)
    expect(reuseResult.created).toBe(true)
    expect(fake.methods()).toContain('remove')
    expect(fake.created[0]?.containerUser).toBe('1000:1000')
  })
})
