import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatRun } from '../../src/cli/commands/chat.ts'
import { startRunInBackground } from '../../src/cli/commands/run.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import type { McpServerSpec } from '../../src/engines/contract/types.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'

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
  name: cli-chat-run-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  network_policy: open
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
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
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - task.inspect
`

function makeFixture(): { ctx: ProjectContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-chat-run-test-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG_YAML, 'utf8')
  const loaded = loadConfig(dir)
  return { ctx: { rootDir: dir, configPath: join(dir, 'pluton.yaml'), loaded }, dir }
}

async function callMcpTool(
  spec: Extract<McpServerSpec, { kind: 'http' }>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: spec.headers?.['Authorization'] ?? '',
  }

  // 1. initialize
  await fetch(spec.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'chat-run-test', version: '0.0.0' },
      },
    }),
  })

  // 2. notifications/initialized
  await fetch(spec.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  })

  // 3. tools/call
  const res = await fetch(spec.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const json = (await res.json()) as any
  if (json.error) return { ok: false, error: json.error }
  const content = json.result?.content?.[0]?.text
  const parsed = content ? JSON.parse(content) : null
  if (json.result?.isError) {
    return { ok: false, error: parsed }
  }
  return { ok: true, data: parsed }
}

describe('chat background run driver', () => {
  it('calls run.start via operator HTTP bridge and returns runId', async () => {
    const { ctx } = makeFixture()
    const io = new ScriptedIo()

    let capturedServer: Extract<McpServerSpec, { kind: 'http' }> | null = null
    const adapter = new MockEngineAdapter({
      onStartSession: (req) => {
        capturedServer = (req.mcpServers?.[0] as Extract<McpServerSpec, { kind: 'http' }>) ?? null
      },
      script: [
        {
          text: 'Operator ready',
          outcome: 'success',
        },
      ],
    })

    const runPromise = chatRun(ctx, {}, {
      io,
      adapterFor: () => adapter,
      startRun: async (input) => {
        return { runId: 'run_fake123' }
      },
    })

    // Wait for session to start
    await new Promise((r) => setTimeout(r, 40))
    expect(capturedServer).not.toBeNull()

    // Call run.start through the HTTP bridge
    const callRes = await callMcpTool(capturedServer!, 'run.start', {
      goal: 'build feature X',
      acceptance: ['passes tests'],
    })

    expect(callRes.ok).toBe(true)
    expect(callRes.data).toMatchObject({
      runId: 'run_fake123',
    })

    io.send('/exit')
    await runPromise
  })

  it('enforces active-run guard: second run.start while active returns error', async () => {
    const { ctx } = makeFixture()
    const io = new ScriptedIo()

    let capturedServer: Extract<McpServerSpec, { kind: 'http' }> | null = null
    const adapter = new MockEngineAdapter({
      onStartSession: (req) => {
        if (!capturedServer) {
          capturedServer = (req.mcpServers?.[0] as Extract<McpServerSpec, { kind: 'http' }>) ?? null
        }
      },
      script: [
        { text: 'ready', outcome: 'success' },
        // The guard only exists while the first run is active. Without a
        // delay the one-event mock run can finish before the second MCP call
        // arrives, so keep it in flight long enough for the assertion.
        { text: 'working', outcome: 'success', delayMs: 250 },
      ],
    })

    const runPromise = chatRun(ctx, {}, {
      io,
      adapterFor: () => adapter,
    })

    await new Promise((r) => setTimeout(r, 40))
    expect(capturedServer).not.toBeNull()

    // First run.start: starts a run in background
    const call1 = await callMcpTool(capturedServer!, 'run.start', {
      goal: 'first run',
      acceptance: [],
    })
    expect(call1.ok).toBe(true)
    const firstRunId = call1.data.runId

    // Second run.start: should be rejected by the active-run guard
    const call2 = await callMcpTool(capturedServer!, 'run.start', {
      goal: 'second run',
      acceptance: [],
    })
    expect(call2.ok).toBe(false)
    expect(call2.error).toMatchObject({
      code: 'validation_failed',
    })
    expect(call2.error.message).toContain('still active')

    io.send('/exit')
    await runPromise
  })

  it('runs startRunInBackground directly and drives run to completion', async () => {
    const { ctx } = makeFixture()
    const { store, projectId } = bootstrapStore(ctx.loaded)

    try {
      const managerAdapter = new MockEngineAdapter({
        script: [
          {
            text: 'I will create task 1',
            outcome: 'success',
          },
        ],
      })

      const { runId, done } = startRunInBackground(
        ctx,
        store,
        projectId,
        {
          goal: 'test goal background',
          acceptance: ['test done'],
        },
        {
          adapterFor: () => managerAdapter,
        },
      )

      expect(runId).toMatch(/^run_/)
      const runRow = store.getRun(runId)
      expect(runRow.goal).toBe('test goal background')

      const summary = await done
      expect(summary.runId).toBe(runId)
      expect(summary.state).toBe('completed')
      expect(summary.outcome).toBe('success')
    } finally {
      store.close()
    }
  })
})
