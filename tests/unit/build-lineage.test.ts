import { describe, expect, it } from 'vitest'
import type { ShipRecord } from '../../src/domain/models.ts'
import {
  buildBuildLineageSection,
  buildManagerPrompt,
  type BuildLineageEntry,
} from '../../src/orchestrator/supervisor.ts'

/**
 * Dynamic planning refinement (PLUTON 4.1 Phase 4).
 *
 * The manager of a later Build must see durable prior-build lineage and be
 * told to refine the existing plan. These tests pin the exact evidence that
 * reaches the prompt and the truncation contract that keeps it bounded.
 */

const manager: ShipRecord = {
  id: 'ship_manager',
  projectId: 'project_test',
  slug: 'manager',
  displayName: 'Manager',
  role: 'supervisor',
  engineKind: 'mock',
  model: 'mock/test',
  instructionsFile: null,
  workspacePolicy: 'coordinator-read-only',
  permissions: [],
  approvalMode: 'ask-for-sensitive-actions',
  engineHome: '.pluton/engine-homes/manager',
  enabled: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

function entry(overrides: Partial<BuildLineageEntry> = {}): BuildLineageEntry {
  return {
    runId: 'run_a',
    goal: 'Ship the login page',
    state: 'completed',
    summary: 'Login page shipped with tests.',
    tasks: [
      { title: 'Build the form', state: 'completed' },
      { title: 'Wire the API', state: 'completed' },
    ],
    ...overrides,
  }
}

describe('buildBuildLineageSection', () => {
  it('renders the build anchor and prior build evidence', () => {
    const section = buildBuildLineageSection({
      buildNumber: 3,
      workspaceRoot: 'C:/workspace/app',
      priorBuilds: [
        entry({
          runId: 'run_b',
          goal: 'Add password reset',
          state: 'completed',
          summary: 'Reset flow shipped.',
          tasks: [
            { title: 'Reset endpoint', state: 'completed' },
            { title: 'Reset UI', state: 'running' },
          ],
        }),
        entry(),
      ],
    })

    expect(section).toContain('build 3')
    expect(section).toContain('C:/workspace/app')
    expect(section).toContain('run_b [completed]')
    expect(section).toContain('goal: Add password reset')
    expect(section).toContain('tasks: 1 completed, 0 failed, 1 unsettled')
    expect(section).toContain('outcome: Reset flow shipped.')
    expect(section).toContain('unfinished: Reset UI')
    // Newest build first, as supplied by the durable query.
    expect(section.indexOf('run_b')).toBeLessThan(section.indexOf('run_a'))
    expect(section).toContain('Do not recreate or re-run work that is already completed')
  })

  it('does not list completed tasks as unfinished', () => {
    const section = buildBuildLineageSection({
      buildNumber: 2,
      workspaceRoot: '/workspace/app',
      priorBuilds: [entry()],
    })

    const unfinishedLine = section.split('\n').find((line) => line.trimStart().startsWith('unfinished:'))
    expect(unfinishedLine).toBeUndefined()
    expect(section).toContain('tasks: 2 completed, 0 failed, 0 unsettled')
  })

  it('states the first-build case honestly instead of inventing history', () => {
    const section = buildBuildLineageSection({
      buildNumber: 1,
      workspaceRoot: '/workspace/app',
      priorBuilds: [],
    })

    expect(section).toContain('build 1')
    expect(section).toContain('No prior builds')
    expect(section).not.toContain('Previous builds in this project')
  })

  it('truncates with an explicit marker when the cap is exceeded', () => {
    const longHistory = Array.from({ length: 20 }, (_, index) =>
      entry({
        runId: `run_${index}`,
        goal: `Long goal number ${index} ${'x'.repeat(120)}`,
      }),
    )
    const section = buildBuildLineageSection({
      buildNumber: 21,
      workspaceRoot: '/workspace/app',
      priorBuilds: longHistory,
      maxChars: 240,
    })

    expect(section.length).toBeLessThan(400)
    expect(section).toContain('build lineage exceeded 240 chars')
    expect(section.startsWith('Persistent Build session')).toBe(true)
  })
})

describe('buildManagerPrompt lineage injection', () => {
  it('places the refinement section in the manager prompt', () => {
    const prompt = buildManagerPrompt(
      'Continue the project',
      manager,
      [manager],
      [],
      20_000,
      undefined,
      undefined,
      'PERSISTENT-BUILD-LINEAGE-MARKER',
    )

    expect(prompt).toContain('PERSISTENT-BUILD-LINEAGE-MARKER')
    expect(prompt.indexOf('PERSISTENT-BUILD-LINEAGE-MARKER')).toBeLessThan(prompt.indexOf('Team:'))
  })
})
