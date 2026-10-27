import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'
import { PROSE_SECRET_PATTERNS } from '../../src/util/redact.ts'

/**
 * PLUTON SPA — reference UI replacement and functional integration.
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
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
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
`

/**
 * Build a project config with an overridden `sandbox` block.
 */
function testConfig(sandbox?: { kind: 'docker' | 'local-process' }): string {
  if (!sandbox) return TEST_CONFIG
  const lines = [`  kind: ${sandbox.kind}`]
  if (sandbox.kind === 'local-process') lines.push('  local_process_acknowledged: true')
  return TEST_CONFIG.replace(
    `sandbox:\n  kind: native\n  native:\n    acknowledge_partial_enforcement: true\n    acknowledge_host_network: true\n    mode_by_platform:\n      darwin: unconfined\n      win32: unconfined\n    acknowledge_unconfined: true`,
    `sandbox:\n${lines.join('\n')}`,
  )
}

async function setupTestProject(options?: {
  sandbox?: { kind: 'docker' | 'local-process' }
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

describe('PLUTON SPA — MCP connection registry', () => {
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
      // Nothing is registered before an engine session exists — the count must
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

describe('PLUTON SPA — model switch', () => {
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

describe('PLUTON SPA � supervised build control', () => {
  it('surfaces a stranded run in run detail (supervisorStale) without fabricating any state', async () => {
    // Defect 2026-10-21: a run whose supervisor died mid-run stayed `active`
    // forever with no signal other than reading raw DB heartbeats. The run
    // detail API now exposes the stranded condition; recovery stays the
    // operator's explicit Resume decision � nothing on the server writes a
    // terminal state from this flag.
    const { rootDir, appServer } = await setupTestProject()
    const server = await appServer
    const loaded = loadConfig(rootDir)
    const { store, projectId } = bootstrapStore(loaded)
    try {
      const run = store.createRun({
        projectId,
        goal: 'stranded-run observability test',
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

      const readDetail = async (): Promise<{ state: string; supervisorStale: boolean }> => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}`, {
          headers: { 'x-pluton-token': server.token },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { run: { run: { state: string }; supervisorStale: boolean } }
        return { state: body.run.run.state, supervisorStale: body.run.supervisorStale }
      }

      // A live claim with a fresh heartbeat is not stranded.
      store.setRunState(run.id, 'active')
      store.claimRunSupervisor(run.id, { pid: 4242, ttlMs: 90_000 })
      let detail = await readDetail()
      expect(detail.state).toBe('active')
      expect(detail.supervisorStale).toBe(false)

      // Age the heartbeat far beyond the ownership TTL: stranded.
      store.db
        .prepare('UPDATE runs SET supervisor_heartbeat_at = ? WHERE id = ?')
        .run(Date.now() - 200_000, run.id)
      detail = await readDetail()
      expect(detail.state).toBe('active') // still honestly non-terminal
      expect(detail.supervisorStale).toBe(true)

      // A run claimed but still pre-heartbeat is not stranded; a STARTED run
      // with no heartbeat at all means its owner died before renewing once.
      store.db.prepare('UPDATE runs SET supervisor_heartbeat_at = NULL WHERE id = ?').run(run.id)
      detail = await readDetail()
      expect(detail.supervisorStale).toBe(true)

      // A terminal run is never reported stranded, whatever its heartbeat was.
      store.db
        .prepare('UPDATE runs SET state = ?, supervisor_heartbeat_at = ? WHERE id = ?')
        .run('cancelled', Date.now() - 900_000, run.id)
      detail = await readDetail()
      expect(detail.state).toBe('cancelled')
      expect(detail.supervisorStale).toBe(false)
    } finally {
      store.close()
      await server.close()
    }
  })

  it('settles a run whose supervised start failed, instead of leaving it pending forever', async () => {
    // A legacy-configured project whose sandbox cannot be prepared: the
    // supervised start cannot succeed, so the run MUST reach a terminal
    // state.
    const { rootDir, appServer } = await setupTestProject({
      sandbox: { kind: 'docker' },
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
      expect(settled.finalSummary).toContain("sandbox.kind 'docker' is no longer supported")

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

describe('PLUTON SPA — replaced assets', () => {
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

  it('supports Plan, Build, and Chat mode switching with proper payload propagation and indicator styles', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Two primary mode controls exist: Chat button followed by Plan/Build toggle button
      expect(html).toContain('id="modeChatBtn"')
      expect(html).toContain('id="modeToggleBtn"')
      expect(html).toContain('id="modeToggleLabel"')
      expect(html).not.toContain('id="modePlanBtn"')
      expect(html).not.toContain('id="modeBuildBtn"')
      // Dead JS wiring for the removed buttons is gone too (Low C)
      expect(js).not.toContain('modePlanBtn')
      expect(js).not.toContain('modeBuildBtn')

      // Mode-aware thinking indicators
      expect(css).toContain('.status-thinking.mode-plan')
      expect(css).toContain('.status-thinking.mode-build')
      expect(css).toContain('--accent-plan:')
      expect(css).toContain('--accent-build:')

      // Prompt dispatch sends mode in payload
      expect(js).toContain('mode: state.mode')

      // Mode switching updates UI state without losing draft
      expect(js).toContain("setMode('plan')")
      expect(js).toContain("setMode('build')")
      expect(js).toContain("setMode('chat')")

      // Jump to latest control and auto-scroll threshold
      expect(html).toContain('id="btnJumpToLatest"')
      expect(js).toContain('btnJumpToLatest')

      // Connection status hidden during normal operation
      expect(css).toMatch(/\.conn\s*\{[^}]*display:\s*none/)

      // 100% width conversation area when sidebar is collapsed
      expect(css).toContain('#leftSidebar.is-collapsed ~ .app-main .messages')

      // Agent Model Configuration section in Settings
      expect(html).toContain('Agent Model Configuration')

      // Activity timeline with collapsible details and secret redaction
      expect(js).toContain('activity-timeline-node')
      expect(js).toContain('redactSecrets')
    } finally {
      await server.close()
    }
  })

  it('enforces coworker presentation ranking in Settings (Manager, QA, Researcher, Coder, Reviewer)', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Presentation order ranking exists. The former flat
      // COWORKER_PRESENTATION_ORDER array was defined but never read �
      // coworkerRank computes the order from role/id/name � and was removed;
      // nothing may reintroduce an unused ordering table.
      expect(js).not.toContain('COWORKER_PRESENTATION_ORDER')
      expect(js).toContain('coworkerRank')
      // One identity rule drives Settings display AND model fan-out: the
      // coder/worker group is the rank-4 bucket; rank orders, never hides.
      expect(js).toContain('function isWorkerAgent(m)')
      expect(js).toContain('coworkerRank(m) === 4')
      expect(js).toContain('(workers share one model)')
    } finally {
      await server.close()
    }
  })

  it('keeps long sessions responsive: streaming renders coalesce, histories stay bounded, background tabs skip the MCP poll', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Streaming coalesces to one markdown render per animation frame:
      // appendStreamingToken accumulates and schedules, it no longer runs the
      // full renderMarkdown(state.streamingText) per token (that was O(n^2)
      // across a long stream).
      expect(js).toContain('function flushStreamingToken')
      expect(js).toContain('function scheduleStreamFlush')
      expect(js).toContain('streamFlushPending')

      // Bounded live histories: the transcript and each worker stream drop
      // their oldest nodes (follow-guarded), and the retained worker log state
      // is capped. Bulk session replays set a guard so full history renders.
      expect(js).toContain('function trimMessagesList')
      expect(js).toContain('MAX_MESSAGES_DOM')
      expect(js).toContain('MAX_WORKER_STREAM_ENTRIES')
      expect(js).toContain('state.bulkRendering')

      // MCP poll does no work in background tabs and skips unchanged
      // registries; returning to the tab re-runs one load immediately.
      expect(js).toContain('lastMcpSnapshot')
      expect(js).toContain("document.addEventListener('visibilitychange'")
      expect(js).toContain('if (document.hidden) return')
    } finally {
      await server.close()
    }
  })

  it('provides VS Code-inspired file explorer with SVG icons and error retry capabilities', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // The misleading workspace-picker input was removed: the server pins the
      // workspace, so no client-side input may project a different folder.
      expect(html).not.toContain('pcWorkspaceInput')

      // SVG file icons mapping present in JS (no emoji as file icons)
      expect(js).toContain('getFileIconSvg')
      expect(js).toContain('loadFilesList')
    } finally {
      await server.close()
    }
  })

  it('removes unwanted blue outline on composer-textarea while preserving accessible focus on container', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()

      // Textarea has outline: none
      expect(css).toMatch(/\.composer-textarea\s*\{[^}]*outline:\s*none/)
      // Container has focus-within styling for accessible keyboard focus
      expect(css).toMatch(/\.composer:focus-within\s*\{[^}]*border-color:/)
    } finally {
      await server.close()
    }
  })

  it('explains the pinned workspace, supports split-view toggle, and keeps responsive viewport rules', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Split view toggle button in header
      expect(html).toContain('id="btnToggleSplitView"')
      expect(js).toContain('btnToggleSplitView')

      // The workspace pin explainer replaced the directory picker: no client
      // workspace-selection API exists, so the UI explains the limitation
      // instead of pretending a folder choice changed the server workspace.
      expect(js).toContain('explainWorkspacePin')
      expect(js).not.toContain('showDirectoryPicker')

      // Responsive media queries covering breakpoints for desktop, tablet, and mobile
      expect(css).toContain('@media (max-width: 1000px)')
      expect(css).toContain('@media (max-width: 720px)')
      expect(css).toContain('@media (max-width: 480px)')
    } finally {
      await server.close()
    }
  })

  it('enforces neutral grey theme without visible purple accents or hardcoded purple hexes', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()

      // Root token for verify-assets remains defined as neutral grey
      expect(css).toContain('--accent-purple: #71717a;')
      expect(css).toContain('--accent-purple-deep: #52525b;')
      expect(css).toContain('--accent-purple-soft: #a1a1aa;')

      // No lingering legacy purple hex codes in CSS (including the tool/mic/
      // activity tints that used to bypass the token layer).
      const forbiddenPurples = ['#7c3aed', '#6d28d9', '#8b5cf6', '#a855f7', '#3b2d63', '#2f2749', '#1b172a', '#14121f', '#31274f', '#161422', '#2a263d', '#b5b1c9', '#241e38', '#181625']
      for (const hex of forbiddenPurples) {
        expect(css.toLowerCase()).not.toContain(hex)
      }

      // Mic and working indicator are icons, not boxed controls.
      expect(css).toContain('#btnMic,\n#btnMic:hover:not(.is-disabled) {')
      expect(css).toMatch(/\.activity-inner\s*\{[^}]*border:\s*none/)
      expect(css).toMatch(/\.activity-inner\s*\{[^}]*background:\s*transparent/)

      // ChatGPT-style charcoal/neutral background variables are used
      expect(css).toContain('--bg-main: #111114;')
      expect(css).toContain('--bg-sidebar: #17171a;')
      expect(css).toContain('--bg-surface: #1e1e24;')
      expect(css).toContain('--border: #2a2a30;')
    } finally {
      await server.close()
    }
  })

  it('stabilizes scroll tracking and toggles jump-to-latest when new content arrives scrolled up', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Scroll threshold is between 60-90px
      expect(js).toContain('box.clientHeight) <= 80')
      // maybeScroll reveals or hides jumpBtn based on scroll position
      expect(js).toContain('jumpBtn.classList.remove(\'is-hidden\')')
      expect(js).toContain('jumpBtn.classList.add(\'is-hidden\')')
      // Smooth scroll on jump to latest
      expect(js).toContain("behavior: 'smooth'")
    } finally {
      await server.close()
    }
  })

  it('renders borderless blended tool activity with full output and code-aware colouring', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // No rectangles: cards, input lines, and output are transparent and
      // borderless; the name and status blend into the transcript.
      expect(css).toMatch(/\.tool-card\s*\{[^}]*border:\s*none/)
      expect(css).toMatch(/\.tool-card-input\s*\{[^}]*border:\s*none/)
      expect(css).toMatch(/\.tool-card-body\s*\{[^}]*border:\s*none/)
      expect(css).toMatch(/\.tool-card-body\s*\{[^}]*max-height:\s*none/)
      expect(css).toMatch(/\.tool-card-body\s*\{[^}]*overflow:\s*visible/)
      expect(css).not.toContain('max-height: 280px')
      expect(css).toContain('.tool-status.running,\n.tool-status.succeeded { background: transparent; color: var(--text-dim); }')
      expect(css).toMatch(/\.tool-name\s*\{[^}]*color:\s*var\(--text-muted\)/)

      // Status words are human labels, not raw event names.
      expect(js).toContain("status === 'running' ? 'Running' : (status === 'succeeded' ? 'Completed' : (status === 'failed' ? 'Failed' : status))")

      // Code-aware output: only inferable languages are tokenised.
      expect(js).toContain('function guessToolCodeLang')
      expect(js).toContain('function langFromPath')
      expect(js).toContain('highlightCode(cleanedOutput, codeLang)')
      expect(css).toContain('.tok-cm { color: #6a9955; font-style: italic; }')
      expect(css).toContain('.tok-st { color: #ce9178; }')
      expect(css).toContain('.tok-kw { color: #569cd6; }')
      expect(css).toContain('.tok-num { color: #b5cea8; }')
    } finally {
      await server.close()
    }
  })

  it('follows appended output until the operator scrolls up, then resumes on jump', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Follow intent survives appends taller than the threshold.
      expect(js).toContain('followTail: true')
      expect(js).toContain('function onChatScroll')
      expect(js).toContain('top < state.lastScrollTop - 2')
      expect(js).toContain('state.followTail = false')
      expect(js).toContain('state.followTail = true')
      expect(js).toContain('if (state.followTail) {')
      // Bulk replays do not thrash layout per message; one scroll at the end.
      expect(js).toContain('if (!state.bulkRendering) maybeScroll(false)')
      expect(js).toContain('maybeScroll(true, true)')
    } finally {
      await server.close()
    }
  })

  it('opens files in a main-area viewer/editor with save, close, and per-item delete controls', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // The sidebar preview is gone; the viewer lives over the conversation.
      expect(html).not.toContain('id="filePreview"')
      expect(js).not.toContain("el('filePreview')")
      expect(html).toContain('id="fileViewer"')
      expect(html).toContain('id="fileViewerClose"')
      expect(html).toContain('id="fileViewerEdit"')
      expect(html).toContain('id="fileViewerSave"')
      expect(html).toContain('id="fileEditorInput"')
      expect(html).toContain('id="codeGutter"')

      // Open -> edit -> save -> close plumbing is real, not decorative.
      expect(js).toContain('function openFileViewer')
      expect(js).toContain('function enterFileEditMode')
      expect(js).toContain('function saveFileContent')
      expect(js).toContain('function closeFileViewer')
      expect(js).toContain("method: 'PUT'")
      expect(js).toContain("headers: { 'Content-Type': 'text/plain; charset=utf-8' }")
      expect(js).toContain('MAX_HIGHLIGHT_CHARS')
      expect(js).toContain('function syncCodeScroll')
      expect(js).toContain('Ctrl+S saves')
      expect(css).toContain('.file-viewer {')
      expect(css).toContain('.code-gutter')
      expect(css).toContain('.code-input')

      // Per-item deletion for sessions and files, both confirmed and real.
      expect(js).toContain('function deleteSession')
      expect(js).toContain('function deleteWorkspaceFile')
      expect(js).toContain("method: 'DELETE'")
      expect(js).toContain('data-delete-path')
      expect(js).toContain('session-delete')
      expect(css).toContain('.session-delete')
      expect(css).toContain('.file-row-delete')
    } finally {
      await server.close()
    }
  })

  it('redacts sensitive API tokens, passwords, and secrets in activity details', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Function redactSecrets is defined and bound to tool card summary and output
      expect(js).toContain('function redactSecrets(text)')
      expect(js).toContain('redactSecrets(tool.summary')
      expect(js).toContain('redactSecrets(tool.output')

      // Verify regex patterns inside js
      expect(js).toContain('sk-[REDACTED]')
      expect(js).toContain('$1[REDACTED]')
    } finally {
      await server.close()
    }
  })

  it('propagates real sanitized failure summaries in applyRunState instead of generic run goal text', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // applyRunState checks error before summary before goal
      expect(js).toContain('error || summary || (goal ? \'Goal: \' + goal : \'\')')
      expect(js).toContain('labels[runState]')
      expect(js).toContain('TERMINAL_RUN_STATES[runState]')
    } finally {
      await server.close()
    }
  })

  it('binds workspace to server-confirmed state and supports native folder selection per session', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()
      const res = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as { ok: boolean; workspace: { name: string; rootDir: string } }
      expect(data.ok).toBe(true)
      expect(data.workspace.rootDir.length).toBeGreaterThan(0)

      // No browser input directory selection artifacts remain: folder picking is handled
      // server-side via the native folder picker endpoint (/api/workspace/pick).
      expect(html).not.toContain('webkitdirectory')
      expect(js).not.toContain('showDirectoryPicker')
      expect(js).not.toContain('openPcWorkspacePicker')

      // Labels are written from server workspace state
      expect(js).toContain('state.workspace.rootDir')
      // Native picker integration and session workspace binding
      expect(js).toContain('/api/workspace/pick')
      expect(js).toContain('pickWorkspaceFolder')
      expect(js).toContain('browseNewSessionWorkspace')
      expect(html).toContain('id="btnNewSessionBrowseWorkspace"')
      expect(html).toContain('id="newSessionWorkspaceInput"')
    } finally {
      await server.close()
    }
  })

  it('enforces full-width layout, correlated tool cards, dock-anchored jump button, and 202-gated composer reset', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const css = await (await fetch(`http://127.0.0.1:${server.port}/app.css`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Full-width layout for messages and composer
      expect(css).toContain('.messages { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 100%; box-sizing: border-box; }')
      expect(css).toContain('.composer {\n  width: 100%;\n  box-sizing: border-box;')
      expect(css).toContain('.msg-user {\n  align-self: stretch;\n  width: 100%;')
      expect(css).toContain('.msg-ai {\n  align-self: stretch;\n  width: 100%;')

      // Jump-to-latest button anchored relative to dock
      expect(css).toContain('.dock { position: relative;')
      expect(css).toContain('bottom: calc(100% + 8px);')
      expect(html).toContain('<div class="dock">\n        <button id="btnJumpToLatest"')

      // Correlated tool cards with id lifecycle and failure presentation
      expect(js).toContain('data-tool-id')
      expect(js).toContain('data-call-id')
      expect(js).toContain("existing.setAttribute('data-status', status)")
      expect(js).toContain("card.className = 'tool-card activity-timeline-node' + (status === 'failed' ? ' is-failed' : '')")
      expect(css).toContain('.tool-card.is-failed')
      expect(js).toContain('formatToolOutput')
      expect(js).toContain('formatToolInput')
      expect(css).toContain('.tool-spinner')
      expect(css).toContain('.tool-card-input')

      // Composer only clears and resets height on HTTP 202 Accepted
      expect(js).toContain('res.status === 202')
      expect(js).toContain("input.style.height = 'auto'")
    } finally {
      await server.close()
    }
  })

  it('tracks per-agent model fan-out outcomes and surfaces partial failures (Medium B)', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // Per-target outcome tracking exists and the swallow-and-warn catch is gone
      expect(js).toContain('var succeeded = []')
      expect(js).toContain('var failed = []')
      expect(js).not.toContain("console.warn('Failed syncing model to '")

      // State updates only for confirmed targets: a failed worker keeps the
      // previous model and stays visibly identifiable on re-render.
      expect(js).toContain('okSet[m.id]')

      // Out-of-order or stale fan-out completions cannot clobber a newer selection.
      expect(js).toContain('switchSeq !== modelSwitchSeq')

      // Every target is addressed by stable id, URL-encoded.
      expect(js).toContain("'/api/muses/' + encodeURIComponent(tid) + '/model'")

      // Full success, total failure, and partial failure each have an honest
      // toast; partial failure never claims success or a rollback.
      expect(js).toContain('agents updated')
      expect(js).toContain('Model switch failed for ')
      expect(js).toContain('Model switch partially failed: ')
      expect(js).toContain('Failed (kept previous model): ')

      // Non-worker agents never fan out: their target list is exactly [museId].
      expect(js).toContain('? workerFanoutTargets(muses, museId) : [museId]')
    } finally {
      await server.close()
    }
  })

  it('renders every addressable agent and guards unaddressable entries (Medium C + Low D)', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // The rank-bucket dedupe that silently hid distinct agents is gone.
      expect(js).not.toContain('seenRanks')
      expect(js).not.toContain('distinctMuses')

      // Rank orders the list; id-less entries are filtered out because they
      // cannot be addressed by the API. Every surviving agent stays visible,
      // with a stable secondary sort by identity.
      expect(js).toContain("String(m.id || m.slug || '') !== ''")
      expect(js).toContain('.sort(function (a, b) { return (a.rank - b.rank) ||')
      expect(js).toContain('No addressable agents configured')

      // Fan-out skips empty ids instead of targeting them.
      expect(js).toContain("String((m && (m.id || m.slug)) || '')")
      expect(js).toContain("id !== '' && id !== changedId && isWorkerAgent(m)")

      // Unknown/missing roles and missing display names render safely instead
      // of collapsing unrelated agents together.
      expect(js).toContain("m.role || 'unknown role'")
      expect(js).toContain('escapeHtml(m.displayName || m.id)')
    } finally {
      await server.close()
    }
  })

  it('redacts credential-shaped terminal run-state text while escaping stays separate (Low B)', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // applyRunState redacts the composed detail BEFORE rendering; the
      // markdown pipeline still HTML-escapes afterwards (independent layers).
      expect(js).toContain('detail = redactSecrets(String(detail))')
      // The markdown renderer escapes as its first step.
      const inlineIdx = js.indexOf('function inlineMarkdown(src)')
      expect(inlineIdx).toBeGreaterThan(-1)
      expect(js.indexOf('var out = escapeHtml(src);', inlineIdx)).toBeGreaterThan(inlineIdx)
    } finally {
      await server.close()
    }
  })

  it('mirrors the server prose-secret redaction patterns in the SPA (documented duplication, Low E)', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // The server redacts at-rest surfaces and the SPA redacts at display.
      // Both copies must keep the same three patterns in lockstep � changing
      // one side fails this test until the other side is updated (the sync
      // requirement is documented in both files).
      expect(PROSE_SECRET_PATTERNS).toHaveLength(3)
      for (const re of PROSE_SECRET_PATTERNS) {
        expect(js).toContain(re.source)
      }
      expect(js).toContain('PROSE_SECRET_PATTERNS')
    } finally {
      await server.close()
    }
  })
})

