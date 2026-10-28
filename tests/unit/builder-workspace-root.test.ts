import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { engineHomesDir, loadConfig } from '../../src/config/load.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { createNativeExecutionProvider, nativeSpecForShip } from '../../src/execution/factory.ts'
import { resumeRun, startRunInBackground } from '../../src/orchestrator/service.ts'

const CONFIG_YAML = `
version: 1
project:
  name: builder-root-test
  default_branch: main
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
runtime:
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_concurrent_workers: 2
  network_policy: open
ships:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
  worker:
    display_name: Worker
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
`

describe('Builder mode execution with external workspace root', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch {}
      }
    }
  })

  it('allows native engine home from project root when run executes on external workspace root', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'pluton-proj-root-'))
    const externalWorkspaceDir = mkdtempSync(join(tmpdir(), 'pluton-ext-ws-'))
    tmpDirs.push(projectDir, externalWorkspaceDir)

    writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG_YAML, 'utf8')
    const loaded = loadConfig(projectDir)
    const ctx: ProjectContext = {
      rootDir: projectDir,
      configPath: join(projectDir, 'pluton.yaml'),
      loaded,
    }

    const { store, projectId } = bootstrapStore(loaded)
    const manager = store.getShip('manager')!
    expect(manager).toBeDefined()
    // Verify engine home is under project root
    expect(manager.engineHome).toBe(join(engineHomesDir(projectDir), 'manager'))
    mkdirSync(manager.engineHome, { recursive: true })

    // Build run with external workspaceRoot
    const { runId, done } = startRunInBackground(
      ctx,
      store,
      projectId,
      {
        goal: 'test builder mode on external workspace',
        acceptance: ['done'],
        workspaceRoot: externalWorkspaceDir,
      },
      {
        adapterFor: () =>
          new MockEngineAdapter({
            script: [
              {
                text: 'Task planned and done',
                outcome: 'success',
              },
            ],
          }),
      },
    )

    expect(runId).toMatch(/^run_/)
    const summary = await done
    expect(summary.state).toBe('completed')

    // Test startRunInBackground WITHOUT mock adapterFor (uses nativeAdapterFor and tests real containment)
    const { runId: nativeRunId, done: nativeDone } = startRunInBackground(
      ctx,
      store,
      projectId,
      {
        goal: 'test native supervisorAdapterFor on external workspace',
        acceptance: ['done'],
        workspaceRoot: externalWorkspaceDir,
      },
    )
    expect(nativeRunId).toMatch(/^run_/)
    const nativeSummary = await nativeDone
    // It should complete (or fail on prompt/mcp, NOT throw PolicyDeniedError on engineHome outside roots)
    expect(nativeSummary.state).not.toBe('crashed')

    // Also test native provider containment directly with extraRoots
    const nativeProvider = createNativeExecutionProvider({
      config: loaded.config,
      rootDir: externalWorkspaceDir,
      extraRoots: [projectDir, engineHomesDir(projectDir)],
    })

    const spec = nativeSpecForShip({
      config: loaded.config,
      rootDir: externalWorkspaceDir,
      projectId,
      ship: manager,
      workdir: externalWorkspaceDir,
      engineHome: manager.engineHome,
      isolatedCheckout: false,
      sessionKind: 'run',
      extraAllowedRoots: [projectDir, engineHomesDir(projectDir)],
    })

    // Starting native session must not throw PolicyDeniedError on engineHome
    expect(spec.hostEngineHome).toBe(manager.engineHome)
    expect(spec.allowedRoots).toContain(projectDir)
    await nativeProvider.close()

    // Test resumeRun (the exact path /api/runs/:id/start uses)
    const runForResume = store.createRun({
      projectId,
      goal: 'test resumeRun with external workspace root',
      origin: 'api',
      requestedBy: 'operator',
      managerShipId: manager.id,
      acceptanceCriteria: ['done'],
      budget: {
        maxConcurrentWorkers: 2,
        maxTasks: 10,
        maxDelegationDepth: 2,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
      workspaceRoot: externalWorkspaceDir,
    })
    const resumeSummary = await resumeRun(
      { rootDir: externalWorkspaceDir, configPath: ctx.configPath, loaded: ctx.loaded },
      runForResume.id,
      { skipManager: false },
    )
    expect(resumeSummary.state).not.toBe('crashed')
  })
})
