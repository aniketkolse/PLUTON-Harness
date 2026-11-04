import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'
import { resolveTaskModelFor, RunSupervisor } from '../../src/orchestrator/supervisor.ts'
import { saveConnection } from '../../src/providers/store.ts'
import { openDatabase } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

const roots: string[] = []

beforeAll(() => {
  registerBuiltinEngines()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Windows lock cleanup
    }
  }
})

function fakeShip(overrides: Partial<ShipRecord> = {}): ShipRecord {
  return {
    id: 'coder',
    projectId: 'p',
    slug: 'coder',
    displayName: 'Coder',
    role: 'coder',
    engineKind: 'openai-compatible',
    model: 'conn-a:claude-3-5-sonnet',
    provider: 'conn-a',
    instructionsFile: null,
    workspacePolicy: 'coordinator-read-only',
    permissions: [...PERMISSIONS],
    approvalMode: 'autonomous-bounded',
    engineHome: '.pluton/engine-homes/coder',
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
    assigneeShipId: 'coder',
    creatorShipId: 'manager',
    parentTaskId: null,
    delegationDepth: 1,
    title: 'Code endpoint',
    brief: 'Implement feature endpoint',
    acceptanceCriteria: ['tests pass'],
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

describe('Mixed-Provider Supervisor & Model Preservation', () => {
  it('preserves user-assigned ship.model in resolveTaskModelFor when registry has other candidates', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels(
      'openai-compatible',
      [
        {
          id: 'conn-a:cheaper-model',
          source: 'engine',
          toolCalling: true,
          codingCapable: true,
          capabilities: { taskFit: ['coding'] },
          contextWindow: 128000,
        },
      ],
      '2030-01-01T00:00:00.000Z',
      'conn-a',
      'conn-a',
    )

    const ship = fakeShip({
      id: 'coder',
      model: 'conn-a:claude-3-5-sonnet',
    })
    const task = fakeTask()

    // Config does not set automatic selection mode for this ship
    const resolved = resolveTaskModelFor(ship, task, registry, null)
    expect(resolved).toBe('conn-a:claude-3-5-sonnet')
  })

  it('orchestrates mixed-provider team (supervisor on mock, coder on conn-a, reviewer on conn-b) preserving models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-mixed-supervisor-'))
    roots.push(root)

    // Configure connection A (Coder provider) and connection B (QA provider)
    saveConnection(root, {
      id: 'conn-a',
      providerId: 'provider-a',
      displayName: 'Anthropic Direct',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })

    saveConnection(root, {
      id: 'conn-b',
      providerId: 'provider-b',
      displayName: 'OpenAI Direct',
      baseUrl: 'http://127.0.0.1:20129/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    })

    const dbPath = join(root, 'pluton.sqlite')
    const db = openDatabase(dbPath)
    migrate(db)
    const store = new Store(db)

    const project = store.ensureProject({
      name: 'mixed-team-project',
      rootPath: root,
      configPath: join(root, 'pluton.yaml'),
      defaultBranch: 'main',
    })

    // Create 3 ships with 3 different providers/engines:
    // 1. Manager (Supervisor): Mock engine
    // 2. Coder: Connection A
    // 3. Reviewer: Connection B
    store.syncMuses(project.id, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Supervisor Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/manager-model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'coder',
        slug: 'coder',
        displayName: 'Coder Ship',
        role: 'coder',
        engineKind: 'openai-compatible',
        provider: 'conn-a',
        model: 'conn-a:claude-3-5-sonnet',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/coder',
      },
      {
        id: 'reviewer',
        slug: 'reviewer',
        displayName: 'QA Reviewer Ship',
        role: 'reviewer',
        engineKind: 'openai-compatible',
        provider: 'conn-b',
        model: 'conn-b:gpt-4o',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [...PERMISSIONS],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/reviewer',
      },
    ])

    const run = store.createRun({
      projectId: project.id,
      goal: 'Mixed team delivery',
      origin: 'cli',
      requestedBy: 'tester',
      acceptanceCriteria: ['complete'],
      managerMuseId: 'manager',
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 2,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })

    const startedSessions: { shipId: string; model: string; adapterKind: string }[] = []

    const mockAdapterFor = (ship: ShipRecord): EngineAdapter => {
      return {
        kind: ship.engineKind,
        capabilities: () => ({ toolCalling: true } as any),
        discover: async () => ({ models: [] } as any),
        listModels: async () => [],
        authStatus: async () => ({ kind: 'authenticated' } as any),
        startSession: async (req: StartSessionRequest): Promise<EngineSession> => {
          startedSessions.push({
            shipId: ship.id,
            model: req.ship?.model ?? ship.model,
            adapterKind: ship.engineKind,
          })
          return {
            id: `sess-${ship.id}`,
            prompt: async function* () {
              yield { kind: 'text', text: 'done' } as EngineEvent
            },
            close: async () => {},
          } as any
        },
      } as any
    }

    const registry = new ModelRegistry()
    // Populate registry with generic models that could tempt heuristic selection
    registry.replaceEngineModels('openai-compatible', [
      { id: 'generic-cheaper', source: 'engine', toolCalling: true, codingCapable: true, contextWindow: 64000 },
    ], '2030-01-01T00:00:00.000Z')

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
      adapterFor: mockAdapterFor,
      modelRegistry: registry,
      diagnostic: () => {},
    })

    // Queue task 1 for coder (conn-a) and task 2 for reviewer (conn-b)
    const task1 = store.createTask({
      runId: run.id,
      assigneeShipId: 'coder',
      title: 'Write code',
      brief: 'Implement logic',
      acceptanceCriteria: ['done'],
    })
    store.setTaskState(task1.id, 'queued')

    const task2 = store.createTask({
      runId: run.id,
      assigneeShipId: 'reviewer',
      title: 'Review code',
      brief: 'Verify logic',
      acceptanceCriteria: ['approved'],
    })
    store.setTaskState(task2.id, 'queued')

    // Execute tasks through supervisor
    await (supervisor as any).executeTask(task1)
    await (supervisor as any).executeTask(task2)

    // Verify:
    // 1. Coder task ran with 'conn-a:claude-3-5-sonnet', not overridden by registry
    const coderSession = startedSessions.find((s) => s.shipId === 'coder')
    expect(coderSession).toBeDefined()
    expect(coderSession?.model).toBe('conn-a:claude-3-5-sonnet')

    // 2. Reviewer task ran with 'conn-b:gpt-4o', not overridden by registry
    const reviewerSession = startedSessions.find((s) => s.shipId === 'reviewer')
    expect(reviewerSession).toBeDefined()
    expect(reviewerSession?.model).toBe('conn-b:gpt-4o')

    db.close()
  })
})
