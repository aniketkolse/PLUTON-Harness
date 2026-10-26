import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { chatRun } from '../../src/cli/commands/chat.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const CONFIG_YAML = `version: 1
project:
  name: cli-chat-model-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
runtime:
  max_concurrent_workers: 1
  max_team_size: 2
  max_delegation_depth: 1
  max_child_tasks_per_task: 2
  max_tasks_per_run: 2
  max_run_minutes: 5
  default_task_minutes: 5
  default_cpu_limit: 1
  default_memory_mb: 1024
  max_retries_per_task: 1
  network_policy: open
  max_prompt_chars: 10000
  max_event_payload_chars: 5000
  max_tool_result_chars: 50000
  heartbeat_seconds: 30
muses:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.status
      - run.list
      - run.inspect
      - run.start
      - approvals.list
`

function makeFixture(): { ctx: ProjectContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-chat-model-test-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG_YAML, 'utf8')
  const loaded = loadConfig(dir)
  return { ctx: { rootDir: dir, configPath: join(dir, 'pluton.yaml'), loaded }, dir }
}

describe('cli chat model and cancel slash commands', () => {
  it('lists models and switches model in live chat session', async () => {
    const { ctx, dir } = makeFixture()
    const { store } = bootstrapStore(ctx.loaded)

    const mockAdapter = new MockEngineAdapter({
      capabilities: { modelList: true },
      models: [
        { id: 'mock/model-a', label: 'Model A', source: 'engine' },
        { id: 'mock/model-b', label: 'Model B', source: 'engine' },
      ],
    })

    const io = new ScriptedIo()

    const runPromise = chatRun(ctx, { museRef: 'supervisor' }, {
      io,
      adapterFor: () => mockAdapter,
    })

    await new Promise((r) => setTimeout(r, 50))

    io.send('/models')
    await new Promise((r) => setTimeout(r, 50))

    io.send('/model mock/model-b')
    await new Promise((r) => setTimeout(r, 50))

    io.send('/model')
    await new Promise((r) => setTimeout(r, 50))

    io.send('/exit')
    const { exitCode } = await runPromise

    expect(exitCode).toBe(0)

    const fullTranscript = io.commits.join('\n')
    expect(fullTranscript).toContain('Available models for engine')
    expect(fullTranscript).toContain('mock/model-a')
    expect(fullTranscript).toContain('(current)')
    expect(fullTranscript).toContain('Switched model for supervisor to mock/model-b')
    expect(fullTranscript).toContain('Current model for supervisor: mock/model-b')

    // Verify persistence in Store
    const muse = store.getMuse('supervisor')
    expect(muse?.model).toBe('mock/model-b')
  })

  it('cancels active run via /cancel slash command', async () => {
    const { ctx, dir } = makeFixture()
    const { store } = bootstrapStore(ctx.loaded)

    // Pre-create an active run in the store
    const muses = store.listMuses()
    const projectId = muses[0]!.projectId
    const run = store.createRun({
      projectId,
      goal: 'test active run',
      origin: 'cli',
      requestedBy: 'operator',
      acceptanceCriteria: [],
      managerMuseId: 'supervisor',
      budget: {
        maxConcurrentWorkers: 1,
        maxTasks: 5,
        maxDelegationDepth: 1,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })
    store.setRunState(run.id, 'active')

    const mockAdapter = new MockEngineAdapter({})
    const io = new ScriptedIo()

    const runPromise = chatRun(ctx, { museRef: 'supervisor' }, {
      io,
      adapterFor: () => mockAdapter,
    })

    await new Promise((r) => setTimeout(r, 50))

    io.send(`/cancel ${run.id}`)
    await new Promise((r) => setTimeout(r, 50))

    io.send('/exit')
    const { exitCode } = await runPromise
    expect(exitCode).toBe(0)

    const fullTranscript = io.commits.join('\n')
    expect(fullTranscript).toContain(`Cancelled run ${run.id}`)

    const updated = store.getRun(run.id)
    expect(updated?.state).toBe('cancelled')
  })
})
