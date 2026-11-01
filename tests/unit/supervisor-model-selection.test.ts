import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import { resolveModelConfig } from '../../src/config/model-config.ts'
import { resolveTaskModelFor } from '../../src/orchestrator/supervisor.ts'
import type { ShipRecord, TaskRecord } from '../../src/domain/models.ts'
import type { EngineModel } from '../../src/engines/contract/types.ts'

function model(id: string, extra: Partial<EngineModel> = {}): EngineModel {
  return { id, source: 'engine', toolCalling: true, contextWindow: 32_000, capabilities: { taskFit: ['coding'] }, codingCapable: true, ...extra }
}

function ship(overrides: Partial<ShipRecord> = {}): ShipRecord {
  return {
    id: 'worker-a',
    projectId: 'p',
    slug: 'worker-a',
    displayName: 'Worker A',
    role: 'coder',
    engineKind: 'mock',
    model: 'mock/legacy-model',
    instructionsFile: null,
    workspacePolicy: 'coordinator-read-only',
    permissions: [],
    approvalMode: 'ask-for-sensitive-actions',
    engineHome: '.pluton/engine-homes/worker-a',
    enabled: true,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  } as ShipRecord
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    runId: 'run-1',
    parentTaskId: null,
    rootTaskId: 'task-1',
    depth: 0,
    title: 'implement endpoint',
    brief: 'add a new REST endpoint',
    acceptanceCriteria: ['done'],
    writeScope: [],
    assigneeShipId: 'worker-a',
    state: 'queued',
    attempt: 0,
    workspaceId: null,
    engineSessionId: null,
    result: null,
    failure: null,
    assignment: null,
    createdAt: '2030-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as TaskRecord
}

describe('resolveTaskModelFor (Phase 7)', () => {
  it('returns ship.model when no registry or config is supplied (legacy)', () => {
    const result = resolveTaskModelFor(ship(), task(), null, null)
    expect(result).toBe('mock/legacy-model')
  })

  it('honors an explicit pin and never bypasses it', () => {
    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: { 'worker-a': { display_name: 'Worker A', role: 'coder', engine: 'mock', model: 'mock/pinned-model' } },
    } as any)
    const result = resolveTaskModelFor(ship(), task(), null, cfg)
    expect(result).toBe('mock/pinned-model')
  })

  it('selects dynamically from the registry when no pin is configured', () => {
    const registry = new ModelRegistry()
    const preferred = 'mock/preferred-model'
    registry.replaceEngineModels('mock', [model(preferred, { codingCapable: true, capabilities: { taskFit: ['coding'] }, contextWindow: 64000 }), model('mock/other')], '2030-01-01T00:00:00.000Z')

    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: { 'worker-a': { display_name: 'Worker A', role: 'coder', engine: 'mock' } },
    } as any)

    const result = resolveTaskModelFor(ship({ model: 'mock/legacy-model' }), task(), registry, cfg)
    expect(result).toBe(preferred)
  })

  it('falls back to ship.model when no eligible candidate exists', () => {
    const registry = new ModelRegistry()
    registry.replaceEngineModels('mock', [model('mock/only', { toolCalling: false })], '2030-01-01T00:00:00.000Z')

    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: { 'worker-a': { display_name: 'Worker A', role: 'coder', engine: 'mock' } },
    } as any)

    const diagnostics: string[] = []
    const result = resolveTaskModelFor(ship({ model: 'mock/legacy-model' }), task(), registry, cfg, (l) => diagnostics.push(l))
    expect(result).toBe('mock/legacy-model')
    expect(diagnostics.some((d) => d.includes('no eligible model'))).toBe(true)
  })

  it('resolves independently per task/ship without reserving a model', () => {
    const registry = new ModelRegistry()
    const a = 'mock/model-a'
    const b = 'mock/model-b'
    registry.replaceEngineModels('mock', [model(a, { codingCapable: true }), model(b, { reasoningCapable: true, capabilities: { taskFit: ['research'] } })], '2030-01-01T00:00:00.000Z')

    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: {
        'worker-a': { display_name: 'Worker A', role: 'coder', engine: 'mock' },
        'worker-b': { display_name: 'Worker B', role: 'researcher', engine: 'mock' },
      },
    } as any)

    const r1 = resolveTaskModelFor(ship({ id: 'worker-a', model: 'mock/legacy' }), task({ title: 'implement endpoint', brief: 'write code and fix the build', acceptanceCriteria: ['compiles'] }), registry, cfg)
    const r2 = resolveTaskModelFor(ship({ id: 'worker-b', role: 'researcher', model: 'mock/legacy' }), task({ title: 'research and summarize findings', brief: 'investigate and analyze the codebase', acceptanceCriteria: ['summary'] }), registry, cfg)
    expect(r1).toBe(a)
    expect(r2).toBe(b)
  })

  it('never selects a model discovered from another engine', () => {
    const registry = new ModelRegistry()
    // A dev-only mock entry with complete metadata outranks the real entry.
    registry.replaceEngineModels('mock', [model('mock/dev-only', { contextWindow: 128_000 })], '2030-01-01T00:00:00.000Z')
    registry.replaceEngineModels('opencode', [model('opencode/real-model', { contextWindow: 8_000 })], '2030-01-01T00:00:00.000Z')

    const cfg = resolveModelConfig({
      version: 1,
      project: { name: 'p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {} as any,
      sandbox: {} as any,
      git: {} as any,
      ships: { 'worker-a': { display_name: 'Worker A', role: 'coder', engine: 'opencode' } },
    } as any)

    const result = resolveTaskModelFor(
      ship({ engineKind: 'opencode', model: 'opencode/configured' }),
      task({ title: 'simple task' }),
      registry,
      cfg,
    )
    expect(result).toBe('opencode/real-model')
  })
})
