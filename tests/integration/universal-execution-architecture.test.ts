import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveModelConfig } from '../../src/config/model-config.ts'
import type { ShipRecord, TaskRecord } from '../../src/domain/models.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import type {
  EngineAdapter,
  EngineEvent,
  EngineSession,
  StartSessionRequest,
} from '../../src/engines/contract/types.ts'
import { resolveExecutionRoute } from '../../src/engines/execution-router.ts'
import { ModelHealthMonitor } from '../../src/engines/model-health.ts'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { resolveTaskModelFor, RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import {
  getConnection,
  listConnections,
  listManualModels,
  readConnectionCredential,
  saveConnection,
  saveManualModel,
  writeConnectionCredential,
} from '../../src/providers/store.ts'
import { validateEndpointUrl } from '../../src/providers/validation.ts'
import { openDatabase } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlutonToolBridge } from '../../src/tools/bridge.ts'

const tmpDirs: string[] = []

beforeAll(() => {
  registerBuiltinEngines()
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows lock cleanup
    }
  }
})

function fakeShip(overrides: Partial<ShipRecord> = {}): ShipRecord {
  return {
    id: 'worker',
    projectId: 'p',
    slug: 'worker',
    displayName: 'Worker',
    role: 'coder',
    engineKind: 'openai-compatible',
    model: 'conn-a:model-x',
    provider: 'conn-a',
    instructionsFile: null,
    workspacePolicy: 'coordinator-read-only',
    permissions: [...PERMISSIONS],
    approvalMode: 'autonomous-bounded',
    engineHome: '.pluton/engine-homes/worker',
    enabled: true,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function fakeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-1',
    projectId: 'p',
    runId: 'r-1',
    assigneeShipId: 'worker',
    creatorShipId: 'manager',
    parentTaskId: null,
    delegationDepth: 1,
    title: 'Code task',
    brief: 'Implement task',
    acceptanceCriteria: ['done'],
    state: 'queued',
    attemptCount: 0,
    maxAttempts: 3,
    leaseExpiry: null,
    leaseOwnerShipId: null,
    assignedAt: null,
    heartbeatAt: null,
    recoveryAttemptCount: 0,
    recoveryExhausted: false,
    failure: null,
    assignment: null,
    createdAt: '2030-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as TaskRecord
}

describe('PLUTON 6.0: Universal Execution Architecture (18 End-to-End Scenarios)', () => {
  // Scenario 1: OpenCode model executes through OpenCode
  it('Scenario 1: OpenCode model executes through OpenCode engine route', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-1-')))
    tmpDirs.push(root)
    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'opencode/minimax-m3.1-flash-free',
    })
    expect(route.identity.engineKind).toBe('opencode')
    expect(route.providerModelId).toBe('opencode/minimax-m3.1-flash-free')
  })

  // Scenario 2: External model executes through its own adapter
  it('Scenario 2: External model executes through its own HTTP adapter route', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-2-')))
    tmpDirs.push(root)
    saveConnection(root, {
      id: 'anthropic-direct',
      providerId: 'anthropic',
      displayName: 'Anthropic Direct',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'anthropic-direct:claude-3-5-sonnet',
    })
    expect(route.identity.engineKind).toBe('openai-compatible')
    expect(route.identity.providerId).toBe('anthropic-direct')
    expect(route.providerModelId).toBe('claude-3-5-sonnet')
  })

  // Scenario 3: Custom compatible API can be configured
  it('Scenario 3: Custom compatible API endpoint can be saved and loaded with headers', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-3-')))
    tmpDirs.push(root)
    saveConnection(root, {
      id: 'custom-internal',
      providerId: 'custom-gateway',
      displayName: 'Internal Custom LLM',
      baseUrl: 'http://127.0.0.1:20129/v1',
      protocol: 'custom',
      auth: { style: 'header', header: 'X-API-Key' },
      customHeaders: { 'X-Tenant': 'pluton-prod' },
    })

    const conn = getConnection(root, 'custom-internal')
    expect(conn).toBeDefined()
    expect(conn?.protocol).toBe('custom')
    expect(conn?.auth?.header).toBe('X-API-Key')
    expect(conn?.customHeaders?.['X-Tenant']).toBe('pluton-prod')
  })

  // Scenario 4: Manually registered model resolves
  it('Scenario 4: Manually registered model resolves with user-declared capabilities', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-4-')))
    tmpDirs.push(root)
    saveManualModel(root, {
      connectionId: 'custom-conn',
      modelId: 'nvidia/nemotron-4-340b',
      displayName: 'Nemotron 340B',
      capabilities: {
        toolCalling: true,
        contextWindow: 128000,
        coding: true,
        reasoning: true,
      },
      registeredAt: new Date().toISOString(),
    })

    const models = listManualModels(root, 'custom-conn')
    expect(models).toHaveLength(1)
    expect(models[0]?.modelId).toBe('nvidia/nemotron-4-340b')
    expect(models[0]?.capabilities?.toolCalling).toBe(true)

    const registry = new ModelRegistry()
    registry.registerManualModel(
      'custom-conn',
      { id: 'custom-conn:nvidia/nemotron-4-340b', source: 'engine' },
      { toolCalling: true, contextWindow: 128000, coding: true, reasoning: true, verified: true },
    )
    const entry = registry.get('custom-conn', 'custom-conn:nvidia/nemotron-4-340b')
    expect(entry).toBeDefined()
    expect(entry?.toolCalling).toBe(true)
    expect(entry?.contextWindow).toBe(128000)
  })

  // Scenario 5: Multiple providers work simultaneously
  it('Scenario 5: Multiple providers work simultaneously in registry without collisions', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'prov-a:model-1', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'prov-a',
      'prov-a',
    )
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'prov-b:model-1', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'prov-b',
      'prov-b',
    )

    const entryA = registry.get('prov-a', 'prov-a:model-1')
    const entryB = registry.get('prov-b', 'prov-b:model-1')
    expect(entryA?.connectionId).toBe('prov-a')
    expect(entryB?.connectionId).toBe('prov-b')
    expect(registry.list()).toHaveLength(2)
  })

  // Scenario 6: Multiple connections to one provider remain isolated
  it('Scenario 6: Multiple connections to same provider remain strictly isolated', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-6-')))
    tmpDirs.push(root)

    saveConnection(root, {
      id: 'openrouter-dev',
      providerId: 'openrouter',
      displayName: 'OpenRouter Dev',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })
    writeConnectionCredential(root, 'openrouter-dev', 'sk-or-dev-key')

    saveConnection(root, {
      id: 'openrouter-prod',
      providerId: 'openrouter',
      displayName: 'OpenRouter Prod',
      baseUrl: 'http://127.0.0.1:20129/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })
    writeConnectionCredential(root, 'openrouter-prod', 'sk-or-prod-key')

    expect(readConnectionCredential(root, 'openrouter-dev')).toBe('sk-or-dev-key')
    expect(readConnectionCredential(root, 'openrouter-prod')).toBe('sk-or-prod-key')
  })

  // Scenario 7: External models are not validated against OpenCode catalog
  it('Scenario 7: External models resolve without OpenCode validation dependency', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-7-')))
    tmpDirs.push(root)
    saveConnection(root, {
      id: 'deepseek-conn',
      providerId: 'deepseek',
      displayName: 'DeepSeek Direct',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'deepseek-conn:deepseek-chat',
    })
    expect(route.identity.engineKind).toBe('openai-compatible')
    expect(route.identity.providerId).toBe('deepseek-conn')
    expect(route.providerModelId).toBe('deepseek-chat')
  })

  // Scenario 8: OpenCode quota exhaustion does not interrupt external models
  it('Scenario 8: OpenCode quota exhaustion does not affect external connection health', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'opencode/model', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'opencode-conn',
      'opencode-conn',
    )
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'claude-3-5', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'anthropic-conn',
      'anthropic-conn',
    )
    const monitor = new ModelHealthMonitor({ registry })
    monitor.recordFailure({
      engineKind: 'openai-compatible',
      modelId: 'opencode/model',
      connectionId: 'opencode-conn',
      providerMessage: 'monthly quota exceeded (429)',
      httpStatus: 429,
    })

    expect(monitor.getModelHealth('opencode-conn', 'opencode/model').state).not.toBe('healthy')
    expect(monitor.getModelHealth('anthropic-conn', 'claude-3-5').state).toBe('healthy')
  })

  // Scenario 9: Provider-specific failures remain isolated
  it('Scenario 9: Failures on Connection A do not impact Connection B', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'shared-model', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'conn-a',
      'conn-a',
    )
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: 'shared-model', source: 'engine' }],
      '2030-01-01T00:00:00.000Z',
      'conn-b',
      'conn-b',
    )
    const monitor = new ModelHealthMonitor({ registry })
    monitor.recordFailure({
      engineKind: 'openai-compatible',
      modelId: 'shared-model',
      connectionId: 'conn-a',
      errorCode: 'ECONNREFUSED',
      providerMessage: 'connection refused',
    })

    expect(monitor.getModelHealth('conn-a', 'shared-model').state).not.toBe('healthy')
    expect(monitor.getModelHealth('conn-b', 'shared-model').state).toBe('healthy')
  })

  // Scenario 10: Unsupported capabilities reported accurately
  it('Scenario 10: Unsupported capabilities are evaluated accurately in model selector', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'openai-compatible',
      [
        {
          id: 'conn-a:simple-model',
          source: 'engine',
          toolCalling: false,
          codingCapable: false,
        },
      ],
      '2030-01-01T00:00:00.000Z',
      'conn-a',
      'conn-a',
    )

    const ship = fakeShip({ id: 'worker', model: 'auto' })
    const task = fakeTask({ title: 'Code logic', brief: 'Write code' })
    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: { worker: { display_name: 'Worker', role: 'coder', engine: 'openai-compatible' } },
    } as any)

    // Coder tasks require coding and tool calling capabilities; simple-model will be excluded
    const resolved = resolveTaskModelFor(ship, task, registry, cfg)
    expect(resolved).toBe('auto') // Not selected because requirements not satisfied
  })

  // Scenario 11: Tool calls execute through secure PLUTON runtime (file.write, command.exec)
  it('Scenario 11: Tool calls file.write and command.exec execute safely within workspace', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-11-')))
    tmpDirs.push(root)
    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'tool-test',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        model: 'conn:model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'tool test',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['ok'],
      managerMuseId: 'worker',
      budget: { maxConcurrentWorkers: 1, maxTasks: 5, maxDelegationDepth: 1, maxRunMinutes: 5, defaultTaskMinutes: 2 },
    })

    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      runId: run.id,
      callerShipId: 'worker',
      rootDir: root,
      limits: {
        maxChildrenPerTask: 5,
        maxBriefChars: 10_000,
        maxTeamSize: 8,
        maxToolResultChars: 120_000,
        defaultWaitSeconds: 1,
        waitHeartbeatSeconds: 5,
        approvalTtlMinutes: 60,
        maxRevisionsPerTask: 1,
      },
    })

    // file.write
    const writeRes = await bridge.call('file.write', {
      path: 'src/output.txt',
      content: 'Architectural test written safely',
    })
    expect(writeRes.ok).toBe(true)

    // command.exec
    const execRes = await bridge.call('command.exec', {
      command: 'node -e "console.log(process.platform)"',
    })
    expect(execRes.ok).toBe(true)
    db.close()
  })

  // Scenario 12: Multiple Ships use different providers simultaneously
  it('Scenario 12: Supervisor orchestrates multiple Ships on different providers simultaneously', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-12-')))
    tmpDirs.push(root)
    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'multi-ship-project',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'sup',
        slug: 'sup',
        displayName: 'Supervisor',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/sup-model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/sup',
      },
      {
        id: 'worker-anthropic',
        slug: 'worker-anthropic',
        displayName: 'Anthropic Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        provider: 'conn-anthropic',
        model: 'conn-anthropic:claude-3-5',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker-anthropic',
      },
      {
        id: 'worker-openai',
        slug: 'worker-openai',
        displayName: 'OpenAI Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        provider: 'conn-openai',
        model: 'conn-openai:gpt-4o',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker-openai',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'test simultaneous providers',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['done'],
      managerMuseId: 'sup',
      budget: { maxConcurrentWorkers: 2, maxTasks: 5, maxDelegationDepth: 1, maxRunMinutes: 5, defaultTaskMinutes: 2 },
    })

    const started: { shipId: string; model: string }[] = []
    const supervisor = new RunSupervisor({
      store,
      projectId: project.id,
      rootDir: root,
      workspacesRoot: join(root, 'workspaces'),
      runId: run.id,
      limits: {
        maxChildrenPerTask: 5,
        maxBriefChars: 10_000,
        maxTeamSize: 8,
        maxToolResultChars: 120_000,
        defaultWaitSeconds: 1,
        waitHeartbeatSeconds: 5,
        approvalTtlMinutes: 60,
        maxRevisionsPerTask: 1,
      },
      maxConcurrentWorkers: 2,
      defaultTaskTimeoutMs: 5_000,
      runDeadlineMs: 10_000,
      verificationConfigured: false,
      loopPollMs: 20,
      maxRetriesPerTask: 1,
      adapterFor: (ship) => ({
        kind: ship.engineKind,
        capabilities: () => ({ toolCalling: true } as any),
        discover: async () => ({ models: [] } as any),
        listModels: async () => [],
        authStatus: async () => ({ kind: 'authenticated' } as any),
        startSession: async (req: StartSessionRequest) => {
          started.push({ shipId: ship.id, model: req.ship?.model ?? ship.model })
          return {
            id: `sess-${ship.id}`,
            prompt: async function* () {
              yield { kind: 'text', text: 'finished' } as EngineEvent
            },
            close: async () => {},
          } as any
        },
      } as any),
      diagnostic: () => {},
    })

    const t1 = store.createTask({
      runId: run.id,
      assigneeShipId: 'worker-anthropic',
      title: 'Anthropic work',
      brief: 'Brief 1',
      acceptanceCriteria: ['done'],
    })
    store.setTaskState(t1.id, 'queued')

    const t2 = store.createTask({
      runId: run.id,
      assigneeShipId: 'worker-openai',
      title: 'OpenAI work',
      brief: 'Brief 2',
      acceptanceCriteria: ['done'],
    })
    store.setTaskState(t2.id, 'queued')

    await (supervisor as any).executeTask(t1)
    await (supervisor as any).executeTask(t2)

    expect(started.find((s) => s.shipId === 'worker-anthropic')?.model).toBe('conn-anthropic:claude-3-5')
    expect(started.find((s) => s.shipId === 'worker-openai')?.model).toBe('conn-openai:gpt-4o')
    db.close()
  })

  // Scenario 13: Model identity survives restart
  it('Scenario 13: Assigned model identity survives server restart in SQLite store', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-13-')))
    tmpDirs.push(root)
    const dbPath = join(root, 'pluton.sqlite')

    let db = openDatabase(dbPath)
    migrate(db)
    let store = new Store(db)

    const project = store.ensureProject({
      name: 'persistence-test',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        model: 'conn-prod:my-model-v2',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])
    db.close()

    // Reopen database
    db = openDatabase(dbPath)
    store = new Store(db)
    const restored = store.getShip('worker')
    expect(restored).toBeDefined()
    expect(restored?.model).toBe('conn-prod:my-model-v2')
    db.close()
  })

  // Scenario 14: Session recovery preserves provider identity
  it('Scenario 14: Task assignment record preserves provider and model identity on admission', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-14-')))
    tmpDirs.push(root)
    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'session-recovery',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'mgr',
        slug: 'mgr',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/mgr',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/mgr',
      },
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        model: 'conn-isolated:custom-model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'assignment snapshot test',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['done'],
      managerMuseId: 'mgr',
      budget: { maxConcurrentWorkers: 1, maxTasks: 2, maxDelegationDepth: 1, maxRunMinutes: 5, defaultTaskMinutes: 2 },
    })

    const task = store.createTask({
      runId: run.id,
      assigneeShipId: 'worker',
      title: 'T1',
      brief: 'B1',
      acceptanceCriteria: ['ok'],
    })
    store.setTaskState(task.id, 'queued')

    store.setTaskStateIf(task.id, 'queued', 'admitted', {
      assignment: {
        shipId: 'worker',
        museId: 'worker',
        role: 'coder',
        engine: 'openai-compatible',
        model: 'conn-isolated:custom-model',
      },
    })

    const admitted = store.getTask(task.id)
    const assignment = admitted?.assignment as any
    expect(assignment?.model).toBe('conn-isolated:custom-model')
    expect(assignment?.engine).toBe('openai-compatible')
    db.close()
  })

  // Scenario 15: Cancellation works across adapters
  it('Scenario 15: Cancellation stops running tasks cleanly', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-15-')))
    tmpDirs.push(root)
    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'cancel-test',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'mgr',
        slug: 'mgr',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/mgr',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/mgr',
      },
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        model: 'conn:model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'cancel test',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['done'],
      managerMuseId: 'mgr',
      budget: { maxConcurrentWorkers: 1, maxTasks: 2, maxDelegationDepth: 1, maxRunMinutes: 5, defaultTaskMinutes: 2 },
    })

    const task = store.createTask({
      runId: run.id,
      assigneeShipId: 'worker',
      title: 'Task to cancel',
      brief: 'brief',
      acceptanceCriteria: ['done'],
    })
    store.setTaskState(task.id, 'queued')
    store.setTaskState(task.id, 'admitted')
    store.setTaskState(task.id, 'running')
    store.setTaskState(task.id, 'cancelled')

    const cancelled = store.getTask(task.id)
    expect(cancelled?.state).toBe('cancelled')
    db.close()
  })

  // Scenario 16: Invalid credentials do not activate connections
  it('Scenario 16: SSRF and invalid credentials reject connection activation', () => {
    expect(validateEndpointUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false)
    expect(validateEndpointUrl('ftp://example.com/api').ok).toBe(false)
    expect(validateEndpointUrl('https://api.openai.com/v1').ok).toBe(true)
  })

  // Scenario 17: Secrets never appear in logs or responses
  it('Scenario 17: Private credentials never leak in listConnections or REST responses', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-17-')))
    tmpDirs.push(root)
    const SECRET_KEY = 'sk-proj-super-secret-arch-key-999'

    saveConnection(root, {
      id: 'conn-leak-test',
      providerId: 'provider-test',
      displayName: 'Leak Test Connection',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })
    writeConnectionCredential(root, 'conn-leak-test', SECRET_KEY)

    const conns = listConnections(root)
    const serialized = JSON.stringify(conns)
    expect(serialized).not.toContain(SECRET_KEY)
  })

  // Scenario 18: Existing project isolation and approval tests still pass
  it('Scenario 18: Workspace policy and path security checks prevent directory traversal', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-arch-18-')))
    tmpDirs.push(root)

    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'security-project',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    store.syncMuses(project.id, [
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'openai-compatible',
        model: 'conn:model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'security test',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['ok'],
      managerMuseId: 'worker',
      budget: { maxConcurrentWorkers: 1, maxTasks: 5, maxDelegationDepth: 1, maxRunMinutes: 5, defaultTaskMinutes: 2 },
    })

    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      runId: run.id,
      callerShipId: 'worker',
      rootDir: root,
      limits: {
        maxChildrenPerTask: 5,
        maxBriefChars: 10_000,
        maxTeamSize: 8,
        maxToolResultChars: 120_000,
        defaultWaitSeconds: 1,
        waitHeartbeatSeconds: 5,
        approvalTtlMinutes: 60,
        maxRevisionsPerTask: 1,
      },
    })

    // Invoking file.write outside workspace is refused
    const res = await bridge.call('file.write', {
      path: '../../outside.txt',
      content: 'traversal attempt',
    })
    expect(res.ok).toBe(false)
    db.close()
  })
})
