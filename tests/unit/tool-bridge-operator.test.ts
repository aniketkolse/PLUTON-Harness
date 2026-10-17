import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { ROLE_DEFAULT_PERMISSIONS } from '../../src/domain/permissions.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const BASE_LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 3,
  maxBriefChars: 5_000,
  maxTeamSize: 6,
  maxToolResultChars: 120_000,
  defaultWaitSeconds: 5,
  waitHeartbeatSeconds: 15,
  approvalTtlMinutes: 60,
}

describe('Operator Tool Bridge Catalog Exposure', () => {
  it('exposes operator tools when caller Muse has supervisor default permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-op-bridge-'))
    tmpDirs.push(dir)
    const db = openDatabase(join(dir, 'test.sqlite'))
    openDbs.push(db)
    migrate(db)
    const store = new Store(db)
    const proj = store.ensureProject({
      name: 'op-test',
      rootPath: dir,
      configPath: join(dir, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(proj.id, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock-1',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...ROLE_DEFAULT_PERMISSIONS.supervisor],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
    ])

    const bridge = new PlutonToolBridge({
      store,
      projectId: proj.id,
      rootDir: dir,
      callerMuseId: 'manager',
      limits: BASE_LIMITS,
      startRun: async () => ({ runId: 'run_test1' }),
    })

    const tools = bridge.listTools()
    const toolNames = tools.map((t) => t.name)

    expect(toolNames).toContain('project.status')
    expect(toolNames).toContain('run.list')
    expect(toolNames).toContain('run.get')
    expect(toolNames).toContain('run.start')
    expect(toolNames).toContain('approvals.list')
  })

  it('exposes zero tools and rejects calls when caller lacks operator permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-op-bridge-empty-'))
    tmpDirs.push(dir)
    const db = openDatabase(join(dir, 'test.sqlite'))
    openDbs.push(db)
    migrate(db)
    const store = new Store(db)
    const proj = store.ensureProject({
      name: 'op-test-empty',
      rootPath: dir,
      configPath: join(dir, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(proj.id, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock-1',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: ['project.read'], // Missing operator permissions!
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
    ])

    const bridge = new PlutonToolBridge({
      store,
      projectId: proj.id,
      rootDir: dir,
      callerMuseId: 'manager',
      limits: BASE_LIMITS,
      startRun: async () => ({ runId: 'run_test2' }),
    })

    const tools = bridge.listTools()
    expect(tools.length).toBe(0)

    const callRes = await bridge.call('project.status', {})
    expect(callRes.ok).toBe(false)
    expect(callRes.error?.code).toBe('policy_denied')
  })
})
