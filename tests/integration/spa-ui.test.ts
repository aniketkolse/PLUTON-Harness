import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

/**
 * PLUTON SPA â€” reference UI replacement and functional integration.
 *
 * Covers the endpoints the new workspace UI binds to (MCP registry, model
 * switch, supervised-build start/cancel) and the shape of the replaced SPA
 * assets.
 */

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

const TEST_CONFIG = `version: 1
project:
  name: spa-ui-test
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
  network_policy: restricted
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
`

/**
 * Build a project config with an overridden `sandbox` block.
 *
 * The default is the local-process sandbox (dev-only, no isolation). The
 * container-mode sandbox is used by the start-failure test: a supervised run
 * against a worker image that does not exist must fail, not hang.
 */
function testConfig(sandbox?: { kind: 'docker' | 'local-process'; image?: string }): string {
  if (!sandbox) return TEST_CONFIG
  const lines = [`  kind: ${sandbox.kind}`]
  if (sandbox.image !== undefined) lines.push(`  image: ${sandbox.image}`)
  if (sandbox.kind === 'local-process') lines.push('  local_process_acknowledged: true')
  return TEST_CONFIG.replace(
    'sandbox:\n  kind: local-process\n  local_process_acknowledged: true',
    `sandbox:\n${lines.join('\n')}`,
  )
}

async function setupTestProject(options?: {
  sandbox?: { kind: 'docker' | 'local-process'; image?: string }
}): Promise<{
  rootDir: string
  appServer: Promise<AppServerInstance>
}> {
  const root = mkdtempSync(join(tmpdir(), 'pluton-spa-ui-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), testConfig(options?.sandbox), 'utf8')
  writeFileSync(join(root, 'sample.txt'), 'Hello Pluton SPA', 'utf8')

  const loaded = loadConfig(root)
  const bootstrapped = bootstrapStore(loaded)

  return {
    rootDir: root,
    appServer: startAppServer({
      store: bootstrapped.store,
      projectId: bootstrapped.projectId,
      loaded,
    }),
  }
}

describe('PLUTON SPA â€” MCP connection registry', () => {
  it('reports a real (empty) registry instead of a hardcoded server list', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/mcp`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as {
        ok: boolean
        connected: number
        total: number
        transportUp: boolean
        servers: unknown[]
      }
      expect(data.ok).toBe(true)
      expect(Array.isArray(data.servers)).toBe(true)
      // Nothing is registered before an engine session exists â€” the count must
      // be derived from the registry, never hardcoded.
      expect(data.connected).toBe(0)
      expect(data.total).toBe(0)
      expect(data.servers).toHaveLength(0)
      // Self-consistent: the count always equals the number of connected rows.
      expect(data.connected).toBe(
        (data.servers as Array<{ state: string }>).filter((s) => s.state === 'connected').length,
      )
    } finally {
      await server.close()
    }
  })

  it('requires a valid token', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/mcp`)
      expect(res.status).toBe(401)
    } finally {
      await server.close()
    }
  })
})

describe('PLUTON SPA â€” model switch', () => {
  it('switches a Muse to a model the engine actually offers', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/muses/supervisor/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ model: 'mock/model-a' }),
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as { ok: boolean; model: string; museId: string }
      expect(data.ok).toBe(true)
      expect(data.model).toBe('mock/model-a')
      expect(data.museId).toBe('supervisor')
    } finally {
      await server.close()
    }
  })

  it('refuses a model the engine does not offer and lists the real alternatives', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/muses/supervisor/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ model: 'not-a-real/model' }),
      })
      expect(res.status).toBe(400)
      const data = (await res.json()) as { ok: boolean; error: string; available: string[] }
      expect(data.ok).toBe(false)
      expect(data.error).toContain('not-a-real/model')
      expect(data.available).toContain('mock/model-a')
    } finally {
      await server.close()
    }
  })

  it('404s for an unknown Muse and 400s for a missing model', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/muses/nobody/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ model: 'mock/model-a' }),
      })
      expect(missing.status).toBe(404)

      const empty = await fetch(`http://127.0.0.1:${server.port}/api/muses/supervisor/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({}),
      })
      expect(empty.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})

describe('PLUTON SPA — supervised build control', () => {
  it('settles a run whose supervised start failed, instead of leaving it pending forever', async () => {
    // A container-mode project whose worker image does not exist: the
    // supervised start cannot succeed, so the run MUST reach a terminal
    // state. Before the fix the rejection was swallowed, the run stayed in
    // `created`, and the client waited on a run that could never move.
    const { rootDir, appServer } = await setupTestProject({
      sandbox: {
        kind: 'docker',
        image: 'pluton-worker:missing-image-for-this-test',
      },
    })
    const server = await appServer
    const loaded = loadConfig(rootDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      const run = store.createRun({
        projectId,
        goal: 'SPA build start-failure test',
        origin: 'api',
        requestedBy: 'operator:ui',
        managerMuseId: 'supervisor',
        acceptanceCriteria: [],
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 2,
          maxRunMinutes: 10,
          defaultTaskMinutes: 5,
        },
      })

      const startRes = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{}',
      })
      // 202 = accepted, not executed. The execution outcome is asserted below.
      expect(startRes.status).toBe(202)

      // Wait for the run to settle (the supervised start runs in the background).
      const deadline = Date.now() + 30_000
      let detail: { state: string } | null = null
      while (Date.now() < deadline) {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}`, {
          headers: { 'x-pluton-token': server.token },
        })
        const body = (await res.json()) as { run: { run: { state: string } } }
        detail = { state: body.run.run.state }
        if (detail.state === 'failed' || detail.state === 'completed' || detail.state === 'cancelled') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(detail?.state).toBe('failed')

      // The durable record agrees with what the client is told.
      const settled = store.getRun(run.id)
      expect(settled.state).toBe('failed')
      expect(settled.finalSummary).toContain('supervised start failed')

      // A run.finished event is what the SSE log-watcher turns into the
      // terminal run_state frame the client needs to stop waiting.
      const events = store.eventsSince(projectId, 0, 500)
      const finished = events.find((e) => e.type === 'run.finished' && e.runId === run.id)
      expect(finished).toBeDefined()
    } finally {
      store.close()
      await server.close()
    }
  })

  it('starts a run in the background and cancels it through the durable cancel path', async () => {
    const { rootDir, appServer } = await setupTestProject()
    const server = await appServer
    const loaded = loadConfig(rootDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      const run = store.createRun({
        projectId,
        goal: 'SPA build control test',
        origin: 'api',
        requestedBy: 'operator:ui',
        managerMuseId: 'supervisor',
        acceptanceCriteria: [],
        budget: {
          maxConcurrentWorkers: 2,
          maxTasks: 10,
          maxDelegationDepth: 2,
          maxRunMinutes: 10,
          defaultTaskMinutes: 5,
        },
      })

      const startRes = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{}',
      })
      expect(startRes.status).toBe(202)
      const startData = (await startRes.json()) as { ok: boolean; runId: string; status: string }
      expect(startData.ok).toBe(true)
      expect(startData.runId).toBe(run.id)

      const cancelRes = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{}',
      })
      expect(cancelRes.status).toBe(200)
      const cancelData = (await cancelRes.json()) as { ok: boolean; cancelled: boolean }
      expect(cancelData.ok).toBe(true)
      expect(typeof cancelData.cancelled).toBe('boolean')
    } finally {
      store.close()
      await server.close()
    }
  })

  it('404s for an unknown run', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/does-not-exist/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{}',
      })
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('PLUTON SPA - request contract', () => {
  it('rejects an oversized body with 413 and a reason, not a reset connection', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ text: 'x'.repeat(1_200_000) }),
      })
      expect(res.status).toBe(413)
      const data = (await res.json()) as { ok: boolean; error: string }
      expect(data.ok).toBe(false)
      expect(data.error).toContain('payload too large')
    } finally {
      await server.close()
    }
  })

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{not json',
      })
      expect(res.status).toBe(400)
      const data = (await res.json()) as { ok: boolean; error: string }
      expect(data.ok).toBe(false)
      expect(data.error).toContain('invalid JSON')
    } finally {
      await server.close()
    }
  })
})

describe('PLUTON SPA â€” replaced assets', () => {
  it('serves the reference layout and drops the elements the brief removed', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Reference structure: sidebar tabs, header, composer, status strip.
      expect(html).toContain('sidebarTabSessions')
      expect(html).toContain('sidebarTabFiles')
      expect(html).toContain('sidebarTabSettings')
      expect(html).toContain('sidebarToggleBtn')
      expect(html).toContain('Agentic Harness')
      expect(html).toContain('promptInput')
      expect(html).toContain('mcpToggleBtn')
      expect(html).toContain('modelLabelBtn')
      expect(html).toContain('btnPrimary')
      expect(html).toContain('btnAttach')
      expect(html).toContain('btnMic')
      expect(html).toContain('btnNewSession')
      expect(html).toContain('workspacePath')

      // Removed by the brief.
      expect(html).not.toContain('Conversations')
      expect(html).not.toContain('data-tab="orchestra"')
      expect(html).not.toContain('data-tab="approvals"')
      expect(html).not.toContain('sbMode')
      expect(html).not.toContain('sbCostItem')
      expect(html).not.toContain('sbMusesCount')

      // The user message is no longer right-aligned.
      expect(css).not.toContain('align-self: flex-end')
      expect(css).toContain('--accent-purple:')
      expect(css).toContain('::-webkit-scrollbar')

      // The client binds the real endpoints (no hardcoded session/model/MCP data).
      expect(js).toContain("apiFetch('/api/mcp')")
      expect(js).toContain("apiFetch('/api/models')")
      expect(js).toContain("apiFetch('/api/sessions'")
      expect(js).toContain("apiFetch('/api/files')")
      expect(js).toContain('/api/muses/')
      expect(js).toContain('/model')
      expect(js).toContain('/start')
      expect(js).toContain('/cancel')
      // Hardcoded fixture arrays from the mockup must not survive.
      expect(js).not.toContain('const sessionsData')
      expect(js).not.toContain('const mcpServers = [')
      expect(js).not.toContain('let availableModels = [')
    } finally {
      await server.close()
    }
  })
})

