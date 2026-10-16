import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../../src/tools/bridge.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import { InternalError, NotFoundError } from '../../src/domain/errors.ts'

const LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 10,
  maxBriefChars: 20_000,
  maxTeamSize: 5,
  maxToolResultChars: 50_000,
  defaultWaitSeconds: 10,
  waitHeartbeatSeconds: 1,
  approvalTtlMinutes: 60,
}

describe('Operator-scoped PlutonToolBridge', () => {
  let tmpDir: string
  let db: DatabaseSync
  let store: Store
  let projectId: string
  let rootDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pluton-op-bridge-'))
    db = openDatabase(join(tmpDir, 'pluton.sqlite'))
    migrate(db)
    store = new Store(db)
    rootDir = join(tmpDir, 'project-root')
    const proj = store.ensureProject({
      name: 'op-proj',
      rootPath: rootDir,
      configPath: join(rootDir, 'pluton.yaml'),
      defaultBranch: 'main',
    })
    projectId = proj.id

    store.syncMuses(projectId, [
      {
        id: 'supervisor-muse',
        slug: 'supervisor-muse',
        displayName: 'Supervisor',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: [...PERMISSIONS],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/supervisor',
      },
      {
        id: 'restricted-muse',
        slug: 'restricted-muse',
        displayName: 'Restricted',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model-a',
        instructionsFile: null,
        workspacePolicy: 'shared-project-root',
        permissions: ['project.status'], // only project.status
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/restricted',
      },
    ])
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('constructs without a runId and exposes only operator tools filtered by permission', () => {
    const startRun = vi.fn()
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'supervisor-muse',
      limits: LIMITS,
      startRun,
    })

    const tools = bridge.listTools().map((t) => t.name)
    expect(tools.sort()).toEqual([
      'approvals.list',
      'project.status',
      'run.get',
      'run.list',
      'run.start',
    ])

    // Restricted muse only sees allowed tools
    const restrictedBridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'restricted-muse',
      limits: LIMITS,
      startRun,
    })
    expect(restrictedBridge.listTools().map((t) => t.name)).toEqual(['project.status'])
  })

  it('throws InternalError if constructed without runId and without startRun', () => {
    expect(
      () =>
        new PlutonToolBridge({
          store,
          projectId,
          rootDir,
          callerMuseId: 'supervisor-muse',
          limits: LIMITS,
        }),
    ).toThrow(InternalError)
  })

  it('enforces scope isolation: run-scope tools are not found in operator scope', async () => {
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'supervisor-muse',
      limits: LIMITS,
      startRun: vi.fn(),
    })

    const res = await bridge.call('task.create', {
      title: 'do work',
      brief: 'brief',
      acceptanceCriteria: ['done'],
      assigneeMuseId: 'supervisor-muse',
    })
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })

    // Audited as tool.denied with run_id: null
    const events = store.eventsSince(projectId, 0)
    const denied = events.find((e) => e.type === 'tool.denied')
    expect(denied).toBeDefined()
    expect(denied?.runId).toBeNull()
  })

  it('returns policy_denied when caller lacks required permission', async () => {
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'restricted-muse',
      limits: LIMITS,
      startRun: vi.fn(),
    })

    const res = await bridge.call('run.list', {})
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'policy_denied' },
    })
  })

  it('run.start delegates to startRun closure and audits with run_id: null', async () => {
    const startRun = vi.fn().mockResolvedValue({ runId: 'run_created123' })
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'supervisor-muse',
      limits: LIMITS,
      startRun,
    })

    const res = await bridge.call('run.start', {
      goal: 'Build feature X',
      acceptance: ['passes test'],
      requestId: 'req_1',
    })
    expect(res).toEqual({
      ok: true,
      data: { runId: 'run_created123' },
    })
    expect(startRun).toHaveBeenCalledWith({
      goal: 'Build feature X',
      acceptance: ['passes test'],
      requestId: 'req_1',
    })

    const events = store.eventsSince(projectId, 0)
    const callEv = events.find((e) => e.type === 'tool.call' && (e.payload as any).tool === 'run.start')
    expect(callEv).toBeDefined()
    expect(callEv?.runId).toBeNull()
  })

  it('run.start surfaces startRun rejection as a typed failure', async () => {
    const startRun = vi.fn().mockRejectedValue(new Error('Another run is currently active in chat'))
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'supervisor-muse',
      limits: LIMITS,
      startRun,
    })

    const res = await bridge.call('run.start', { goal: 'Fail run' })
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: 'internal_error',
        message: expect.stringContaining('Another run is currently active'),
      },
    })
  })

  it('queries project.status, run.list, run.get, approvals.list with expected shapes', async () => {
    // Seed a run
    const createdRun = store.createRun({
      projectId,
      goal: 'Existing run',
      origin: 'cli',
      requestedBy: 'operator',
      acceptanceCriteria: ['done'],
      managerMuseId: 'supervisor-muse',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 5,
        maxDelegationDepth: 1,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })
    // Seed an approval
    store.createApproval({
      projectId,
      runId: createdRun.id,
      taskId: null,
      requestedByMuseId: 'supervisor-muse',
      action: 'deploy',
      reason: 'ready',
      scope: { env: 'prod' },
    })

    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir,
      callerMuseId: 'supervisor-muse',
      limits: LIMITS,
      startRun: vi.fn(),
    })

    // project.status
    const statusRes = await bridge.call('project.status', {})
    expect(statusRes.ok).toBe(true)
    expect((statusRes as any).data.project.id).toBe(projectId)
    expect((statusRes as any).data.runs.length).toBe(1)

    // run.list
    const listRes = await bridge.call('run.list', { limit: 5 })
    expect(listRes.ok).toBe(true)
    expect((listRes as any).data.length).toBe(1)

    // run.get
    const getRes = await bridge.call('run.get', { run: createdRun.id })
    expect(getRes.ok).toBe(true)
    expect((getRes as any).data.run.id).toBe(createdRun.id)

    // approvals.list
    const appRes = await bridge.call('approvals.list', {})
    expect(appRes.ok).toBe(true)
    expect((appRes as any).data.length).toBe(1)
    expect((appRes as any).data[0].action).toBe('deploy')
  })
})
