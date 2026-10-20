import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig, type LoadedConfig } from '../../src/config/load.ts'
import type { TaskRecord, RunBudget } from '../../src/domain/models.ts'
import { isTerminalRunState } from '../../src/domain/state.ts'
import { admitTask as admitTaskUtil } from '../../src/orchestrator/task-graph.ts'
import { ServerEventBroadcaster } from '../../src/server/events.ts'
import { Store } from '../../src/store/store.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'

export interface CreateTestContextOptions {
  rootDir?: string
  configYaml?: string
}

export interface TestContext {
  readonly rootDir: string
  readonly loaded: LoadedConfig
  readonly store: Store
  readonly projectId: string
  readonly broadcaster: ServerEventBroadcaster
  readonly workspaceManager: GitWorkspaceManager
  startRun(goal: string): Promise<string>
  admitTask(req: {
    runId?: string
    id?: string
    title: string
    brief: string
    assigneeMuseId: string
    acceptanceCriteria?: string[]
    dependsOn?: string[]
    writeScope?: string[]
    parentTaskId?: string | null
  }): Promise<TaskRecord>
  waitForRunCompletion(runId: string, timeoutMs?: number): Promise<{ id: string; state: string }>
  cleanup(): Promise<void>
}

const DEFAULT_CONFIG_YAML = `version: 1
project:
  name: Pluton-E2E
  repository: .
  default_branch: main
  verification: []
runtime:
  max_concurrent_workers: 4
  max_team_size: 8
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 20
  max_run_minutes: 30
  default_task_minutes: 10
sandbox:
  kind: local-process
  local_process_acknowledged: true
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model
    instructions_file: .pluton/roles/manager.md
    workspace_policy: coordinator-read-only
    approval_mode: ask-for-sensitive-actions
  qa:
    display_name: QA
    role: tester
    engine: mock
    model: mock/model
    instructions_file: .pluton/roles/qa.md
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
  researcher:
    display_name: Researcher
    role: researcher
    engine: mock
    model: mock/model
    instructions_file: .pluton/roles/researcher.md
    workspace_policy: read-only
    approval_mode: ask-for-sensitive-actions
  coder:
    display_name: Coder
    role: coder
    engine: mock
    model: mock/model
    instructions_file: .pluton/roles/coder.md
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
  reviewer:
    display_name: Reviewer
    role: reviewer
    engine: mock
    model: mock/model
    instructions_file: .pluton/roles/reviewer.md
    workspace_policy: read-only
    approval_mode: ask-for-sensitive-actions
`

export async function createTestContext(opts: CreateTestContextOptions = {}): Promise<TestContext> {
  const rootDir = opts.rootDir ?? mkdtempSync(join(tmpdir(), 'pluton-e2e-'))

  // 1. Scaffold role files and initial source files
  mkdirSync(join(rootDir, '.pluton', 'roles'), { recursive: true })
  mkdirSync(join(rootDir, 'src'), { recursive: true })

  writeFileSync(join(rootDir, '.pluton', 'roles', 'manager.md'), '# Manager\n', 'utf8')
  writeFileSync(join(rootDir, '.pluton', 'roles', 'qa.md'), '# QA\n', 'utf8')
  writeFileSync(join(rootDir, '.pluton', 'roles', 'researcher.md'), '# Researcher\n', 'utf8')
  writeFileSync(join(rootDir, '.pluton', 'roles', 'coder.md'), '# Coder\n', 'utf8')
  writeFileSync(join(rootDir, '.pluton', 'roles', 'reviewer.md'), '# Reviewer\n', 'utf8')

  writeFileSync(join(rootDir, 'README.md'), '# Pluton E2E Test Project\n', 'utf8')
  writeFileSync(join(rootDir, 'src', 'index.ts'), 'export const ready = true;\n', 'utf8')
  writeFileSync(join(rootDir, 'pluton.yaml'), opts.configYaml ?? DEFAULT_CONFIG_YAML, 'utf8')

  // 2. Initialize Git repo and make initial commit
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: rootDir, stdio: 'ignore', timeout: 30_000 })
  git(['init', '-b', 'main'])
  git(['add', '.'])
  git(['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'initial commit'])

  // 3. Bootstrap store and config
  const loaded = loadConfig(rootDir)
  const { store, projectId } = bootstrapStore(loaded)

  // 4. Initialize workspace manager and broadcaster
  const workspacesRoot = join(rootDir, '.pluton', 'workspaces')
  mkdirSync(workspacesRoot, { recursive: true })
  const workspaceManager = new GitWorkspaceManager({ workspacesRoot })
  const broadcaster = new ServerEventBroadcaster(15000, store, projectId)

  let activeRunId: string | null = null

  return {
    rootDir,
    loaded,
    store,
    projectId,
    broadcaster,
    workspaceManager,

    async startRun(goal: string): Promise<string> {
      const manager = store.getMuse('manager')
      const budget: RunBudget = {
        maxConcurrentWorkers: loaded.config.runtime.max_concurrent_workers,
        maxTasks: loaded.config.runtime.max_tasks_per_run,
        maxDelegationDepth: loaded.config.runtime.max_delegation_depth,
        maxRunMinutes: loaded.config.runtime.max_run_minutes,
        defaultTaskMinutes: loaded.config.runtime.default_task_minutes,
      }
      const run = store.createRun({
        projectId,
        goal,
        origin: 'api',
        requestedBy: 'operator',
        acceptanceCriteria: ['pass e2e orchestration'],
        managerMuseId: manager ? manager.id : 'manager',
        budget,
      })
      store.setRunState(run.id, 'active')
      activeRunId = run.id
      return run.id
    },

    async admitTask(req: {
      runId?: string
      id?: string
      title: string
      brief: string
      assigneeMuseId: string
      acceptanceCriteria?: string[]
      dependsOn?: string[]
      writeScope?: string[]
      parentTaskId?: string | null
    }): Promise<TaskRecord> {
      const runId = req.runId ?? activeRunId
      if (!runId) throw new Error('No active run in context')

      return admitTaskUtil(
        store,
        {
          id: req.id,
          runId,
          parentTaskId: req.parentTaskId ?? null,
          title: req.title,
          brief: req.brief,
          acceptanceCriteria: req.acceptanceCriteria ?? [],
          assigneeMuseId: req.assigneeMuseId,
          writeScope: req.writeScope,
          dependsOn: req.dependsOn,
        },
        { maxChildrenPerTask: 10, maxBriefChars: 60000 },
      )
    },

    async waitForRunCompletion(runId: string, timeoutMs: number = 10000): Promise<{ id: string; state: string }> {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const run = store.getRun(runId)
        if (isTerminalRunState(run.state)) {
          return { id: run.id, state: run.state === 'completed' ? 'succeeded' : run.state }
        }
        const tasks = store.listTasks(runId)
        if (tasks.length > 0 && tasks.every((t) => t.state === 'completed')) {
          store.setRunState(runId, 'completed', { finalSummary: 'All tasks completed successfully' })
          return { id: runId, state: 'succeeded' }
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      const finalRun = store.getRun(runId)
      return { id: finalRun.id, state: finalRun.state === 'completed' ? 'succeeded' : finalRun.state }
    },

    async cleanup(): Promise<void> {
      broadcaster.close()
      try {
        store.db.close()
      } catch {
        // ignore
      }
      try {
        rmSync(rootDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}
