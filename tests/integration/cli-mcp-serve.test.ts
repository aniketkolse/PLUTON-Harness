import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'

/**
 * Integration: `pluton mcp serve` — the restricted tool bridge as a real child
 * process speaking MCP over stdio, exactly how a local-process engine session
 * consumes it. Verifies the protocol channel stays pure stdout, identity is
 * fixed at launch, permissions/scope are enforced, and admissions land in
 * durable state (checked through a second store connection).
 */

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

let projectDir: string
let runId: string
let workerTaskId: string

const CONFIG = `version: 1
project:
  name: cli-mcp-it
  repository: .
  default_branch: main
  verification: []
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
  network_policy: restricted
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
  heartbeat_seconds: 30
muses:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.read
      - task.create
      - task.delegate
      - task.inspect
      - task.cancel
      - result.collect
      - diff.inspect
      - muse.propose_create
      - approval.request
      - run.stop
  worker-a:
    display_name: Worker A
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
`

interface JsonRpcResponse {
  jsonrpc: string
  id?: number
  result?: {
    serverInfo?: { name: string }
    tools?: { name: string }[]
    isError?: boolean
    content?: { type: string; text: string }[]
  }
  error?: { code: number; message: string }
}

interface ServeHandle {
  child: ChildProcessWithoutNullStreams
  rpc: (id: number, method: string, params?: unknown) => Promise<JsonRpcResponse>
  stdoutLines: string[]
  stderrText: () => string
  finish: () => Promise<number>
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

function spawnServe(args: string[]): ServeHandle {
  const child = spawn(process.execPath, [BIN, 'mcp', 'serve', ...args], {
    cwd: projectDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutLines: string[] = []
  let buffer = ''
  let stderrText = ''
  const waiters: (() => void)[] = []
  ;(child.stdout as Readable).on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (const wake of waiters.splice(0)) wake()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
  })

  const nextLine = async (): Promise<string> => {
    while (!buffer.includes('\n')) {
      await withTimeout(
        new Promise<void>((resolve) => waiters.push(resolve)),
        15_000,
        'a stdout line from `pluton mcp serve`',
      )
    }
    const idx = buffer.indexOf('\n')
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    stdoutLines.push(line)
    return line
  }

  return {
    child,
    stdoutLines,
    stderrText: () => stderrText,
    rpc: async (id, method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`)
      const line = await nextLine()
      return JSON.parse(line) as JsonRpcResponse
    },
    finish: async () => {
      child.stdin.end()
      return withTimeout(
        new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1))),
        15_000,
        '`pluton mcp serve` to exit after stdin closed',
      )
    },
  }
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'pluton-cli-mcp-'))
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

  const loaded = loadConfig(projectDir)
  const { store, projectId } = bootstrapStore(loaded)
  const run = store.createRun({
    projectId,
    goal: 'stdio integration goal',
    origin: 'cli',
    requestedBy: 'integration-test',
    acceptanceCriteria: [],
    managerMuseId: 'manager',
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 10,
      maxDelegationDepth: 3,
      maxRunMinutes: 30,
      defaultTaskMinutes: 10,
    },
  })
  runId = run.id
  workerTaskId = admitTask(
    store,
    {
      runId,
      parentTaskId: null,
      title: 'worker task',
      brief: 'seed task for scope tests',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker-a',
    },
    { maxChildrenPerTask: 5 },
  ).id
  store.close()
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('pluton mcp serve (stdio)', () => {
  it('serves the manager surface, admits a task, and keeps stdout pure protocol', async () => {
    const serve = spawnServe(['--run', runId, '--muse', 'manager'])
    try {
      const init = await serve.rpc(1, 'initialize', {})
      expect(init.result?.serverInfo?.name).toBe('pluton-tools')

      const list = await serve.rpc(2, 'tools/list')
      const names = list.result?.tools?.map((t) => t.name) ?? []
      expect(names).toContain('task.create')
      expect(names).toContain('run.stop')

      const created = await serve.rpc(3, 'tools/call', {
        name: 'task.create',
        arguments: {
          title: 'stdio task',
          brief: 'created through the real child process',
          acceptanceCriteria: ['durable'],
          assigneeMuseId: 'worker-a',
        },
      })
      expect(created.result?.isError).toBe(false)
      // The MCP layer hands the engine the handler's data directly (no envelope).
      const payload = JSON.parse(created.result?.content?.[0]?.text ?? '') as {
        task: { id: string; state: string }
      }
      expect(payload.task.state).toBe('queued')

      // Durable state, verified through a second (independent) store connection.
      const reopened = bootstrapStore(loadConfig(projectDir))
      const recorded = reopened.store.listTasks(runId).filter((t) => t.title === 'stdio task')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.id).toBe(payload.task.id)
      reopened.store.close()

      // stdout carried exactly the three JSON-RPC responses — nothing else.
      expect(serve.stdoutLines).toHaveLength(3)
      expect(serve.stdoutLines.every((l) => l.trimStart().startsWith('{'))).toBe(true)

      const exitCode = await serve.finish()
      expect(exitCode).toBe(0)
      expect(serve.stderrText()).toContain(`run ${runId} muse manager (manager scope)`)
    } finally {
      if (serve.child.exitCode === null) serve.child.kill()
    }
  })

  it('scopes a task session to its own subtree and enforces permissions', async () => {
    const serve = spawnServe(['--run', runId, '--muse', 'worker-a', '--task', workerTaskId])
    try {
      await serve.rpc(1, 'initialize', {})

      const list = await serve.rpc(2, 'tools/list')
      expect(list.result?.tools?.map((t) => t.name)).toEqual(['task.inspect', 'task.wait', 'task.get_result', 'diff.inspect'])

      const inspect = await serve.rpc(3, 'tools/call', { name: 'task.inspect', arguments: {} })
      const scoped = JSON.parse(inspect.result?.content?.[0]?.text ?? '') as { count: number }
      expect(scoped.count).toBe(1)

      const denied = await serve.rpc(4, 'tools/call', {
        name: 'task.create',
        arguments: { title: 'x', brief: 'x', acceptanceCriteria: [], assigneeMuseId: 'worker-a' },
      })
      expect(denied.result?.isError).toBe(true)
      const deniedPayload = JSON.parse(denied.result?.content?.[0]?.text ?? '') as { code: string }
      expect(deniedPayload.code).toBe('policy_denied')

      const exitCode = await serve.finish()
      expect(exitCode).toBe(0)
    } finally {
      if (serve.child.exitCode === null) serve.child.kill()
    }
  })

  it('refuses a task whose assignee does not match --muse, with a typed exit', () => {
    const result = spawnSync(
      process.execPath,
      [BIN, 'mcp', 'serve', '--run', runId, '--muse', 'manager', '--task', workerTaskId],
      { cwd: projectDir, encoding: 'utf8', timeout: 60_000 },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/assigned to muse worker-a, not 'manager'/)
    expect(result.stdout).toBe('')
  })
})
