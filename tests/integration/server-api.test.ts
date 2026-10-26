import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { admitTask } from '../../src/orchestrator/task-graph.ts'
import { checkServerHealth, readServerInstance } from '../../src/server/instance.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

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
  name: server-api-test
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
`

function setupTestProject(options: { logWatcherIntervalMs?: number } = {}): {
  rootDir: string
  appServer: Promise<AppServerInstance>
} {
  const root = mkdtempSync(join(tmpdir(), 'pluton-server-it-'))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')
  writeFileSync(join(root, 'sample.txt'), 'Hello Pluton Server', 'utf8')

  const loaded = loadConfig(root)
  const bootstrapped = bootstrapStore(loaded)

  const serverPromise = startAppServer({
    store: bootstrapped.store,
    projectId: bootstrapped.projectId,
    loaded,
    ...(options.logWatcherIntervalMs !== undefined ? { logWatcherIntervalMs: options.logWatcherIntervalMs } : {}),
  })

  return { rootDir: root, appServer: serverPromise }
}

interface SseReadResult {
  frames: Array<Record<string, unknown>>
  dataLines: string[]
  timedOut: boolean
}

/**
 * Reads `data:` frames from an SSE body until `isDone` or the deadline. The
 * read is bounded so a missing-frame regression fails fast instead of hanging
 * until the test timeout.
 */
async function readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  isDone: (frames: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 15_000,
): Promise<SseReadResult> {
  const decoder = new TextDecoder()
  const frames: Array<Record<string, unknown>> = []
  const dataLines: string[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  while (!isDone(frames)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { frames, dataLines, timedOut: true }
    let timer: ReturnType<typeof setTimeout> | null = null
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`SSE read timed out after ${String(timeoutMs)}ms`)),
          remaining,
        )
      }),
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer)
    })
    if (chunk.done) break

    buffer += decoder.decode(chunk.value, { stream: true })
    let separator = buffer.indexOf('\n\n')
    while (separator !== -1) {
      const block = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice('data: '.length)
        dataLines.push(raw)
        frames.push(JSON.parse(raw) as Record<string, unknown>)
      }
      separator = buffer.indexOf('\n\n')
    }
  }
  return { frames, dataLines, timedOut: false }
}

describe('Pluton application server REST & SSE API', () => {
  it('serves static frontend assets without token over loopback', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const resHtml = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(resHtml.status).toBe(200)
      expect(resHtml.headers.get('content-type')).toContain('text/html')
      const htmlText = await resHtml.text()
      expect(htmlText).toContain('PLUTON — AI Coding Agent')
      expect(htmlText).toContain('Agent Orchestra')

      const resCss = await fetch(`http://127.0.0.1:${server.port}/app.css`)
      expect(resCss.status).toBe(200)
      expect(resCss.headers.get('content-type')).toContain('text/css')
      const cssText = await resCss.text()
      expect(cssText).toContain('--accent-purple:')

      const resJs = await fetch(`http://127.0.0.1:${server.port}/app.js`)
      expect(resJs.status).toBe(200)
      expect(resJs.headers.get('content-type')).toContain('application/javascript')
      const jsText = await resJs.text()
      expect(jsText).toContain('PLUTON Client Application')
    } finally {
      await server.close()
    }
  })

  it('rejects API requests without a valid token (401 Unauthorized)', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`)
      expect(res.status).toBe(401)
      const data = (await res.json()) as { ok: boolean; error: string }
      expect(data.ok).toBe(false)
      expect(data.error).toContain('unauthorized')
    } finally {
      await server.close()
    }
  })

  it('returns health, workspace summary, files, and content with token', async () => {
    const { rootDir, appServer } = setupTestProject()
    const server = await appServer
    try {
      // Health
      const healthRes = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(healthRes.status).toBe(200)
      const health = (await healthRes.json()) as { ok: boolean; version: string; projectName: string }
      expect(health.ok).toBe(true)
      expect(health.projectName).toBe('server-api-test')

      // Workspace
      const wsRes = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(wsRes.status).toBe(200)
      const ws = (await wsRes.json()) as { ok: boolean; workspace: { muses: Array<{ displayName: string }> } }
      expect(ws.ok).toBe(true)
      expect(ws.workspace.muses.length).toBeGreaterThan(0)
      expect(ws.workspace.muses[0]!.displayName).toBe('Supervisor')

      // Files
      const filesRes = await fetch(`http://127.0.0.1:${server.port}/api/files`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(filesRes.status).toBe(200)
      const files = (await filesRes.json()) as { ok: boolean; files: string[] }
      expect(files.ok).toBe(true)
      expect(files.files).toContain('sample.txt')

      // Content
      const contentRes = await fetch(`http://127.0.0.1:${server.port}/api/files/content?path=sample.txt`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(contentRes.status).toBe(200)
      const content = (await contentRes.json()) as { ok: boolean; content: string }
      expect(content.ok).toBe(true)
      expect(content.content).toBe('Hello Pluton Server')
    } finally {
      await server.close()
    }
  })

  it('handles chat sessions lifecycle and prompt dispatch', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      // 1. Create chat session
      const createRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pluton-token': server.token,
        },
        body: JSON.stringify({ title: 'Test Chat' }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { ok: boolean; session: { id: string; title: string } }
      expect(created.ok).toBe(true)
      const sessionId = created.session.id

      // 2. Fetch session detail
      const detailRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionId}`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as { ok: boolean; session: { session: { id: string } } }
      expect(detail.session.session.id).toBe(sessionId)

      // 3. Dispatch prompt turn (Accepted 202)
      const promptRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionId}/prompt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pluton-token': server.token,
        },
        body: JSON.stringify({ text: 'Hello supervisor' }),
      })
      expect(promptRes.status).toBe(202)
      const promptData = (await promptRes.json()) as { ok: boolean; status: string }
      expect(promptData.ok).toBe(true)
      expect(promptData.status).toBe('streaming')
    } finally {
      await server.close()
    }
  })

  it('registers instance discovery and passes health check', async () => {
    const { rootDir, appServer } = setupTestProject()
    const server = await appServer
    try {
      const instance = readServerInstance(rootDir)
      expect(instance).not.toBeNull()
      expect(instance!.port).toBe(server.port)
      expect(instance!.pid).toBe(process.pid)

      const isHealthy = await checkServerHealth(instance!)
      expect(isHealthy).toBe(true)
    } finally {
      await server.close()
    }

    // Instance file cleared after close
    expect(readServerInstance(rootDir)).toBeNull()
  })

  it('decides approval via API with autoContinue', async () => {
    const { rootDir, appServer } = setupTestProject()
    const server = await appServer
    try {
      const loaded = loadConfig(rootDir)
      const { store, projectId } = bootstrapStore(loaded)
      try {
        const approval = store.createApproval({
          projectId,
          runId: null,
          taskId: null,
          requestedByMuseId: null,
          action: 'tool.execute',
          reason: 'Allow sensitive script execution',
          scope: { command: 'npm test' },
          expiresAt: null,
        })

        const decideRes = await fetch(`http://127.0.0.1:${server.port}/api/approvals/${approval.id}/decide`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pluton-token': server.token,
          },
          body: JSON.stringify({ decision: 'approved', autoContinue: true }),
        })

        expect(decideRes.status).toBe(200)
        const decideData = (await decideRes.json()) as { ok: boolean; approval: { status: string }; report: unknown }
        expect(decideData.ok).toBe(true)
        expect(decideData.approval.status).toBe('approved')
        expect(decideData.report).toBeDefined()
      } finally {
        store.close()
      }
    } finally {
      await server.close()
    }
  })

  it('serves task and run diff endpoints and reports an active run in the workspace summary', async () => {
    const { rootDir, appServer } = setupTestProject()
    const server = await appServer
    try {
      const loaded = loadConfig(rootDir)
      const { store, projectId } = bootstrapStore(loaded)
      try {
        const run = store.createRun({
          projectId,
          goal: 'test diff endpoint',
          origin: 'cli',
          requestedBy: 'operator',
          acceptanceCriteria: [],
          managerMuseId: 'supervisor',
          budget: {
            maxConcurrentWorkers: 2,
            maxTasks: 10,
            maxDelegationDepth: 2,
            maxRunMinutes: 10,
            defaultTaskMinutes: 5,
          },
        })

        const diffRes = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.id}/diff`, {
          headers: { 'x-pluton-token': server.token },
        })
        expect(diffRes.status).toBe(200)
        const diffData = (await diffRes.json()) as { ok: boolean; diffs: unknown[] }
        expect(diffData.ok).toBe(true)
        expect(diffData.diffs).toBeInstanceOf(Array)

        // Regression: `active` is the primary live run state. A reload adopts
        // this summary, so omitting it made the SPA fall back to a stale run.
        store.setRunState(run.id, 'active')
        const wsRes = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
          headers: { 'x-pluton-token': server.token },
        })
        expect(wsRes.status).toBe(200)
        const wsData = (await wsRes.json()) as {
          workspace: { activeRun: { id: string; state: string } | null }
        }
        expect(wsData.workspace.activeRun?.id).toBe(run.id)
        expect(wsData.workspace.activeRun?.state).toBe('active')
      } finally {
        store.close()
      }
    } finally {
      await server.close()
    }
  })

  it('sets Referrer-Policy on assets and API responses so the URL token never leaks', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const html = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(html.headers.get('referrer-policy')).toBe('no-referrer')
      const api = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(api.headers.get('referrer-policy')).toBe('no-referrer')
    } finally {
      await server.close()
    }
  })

  it('refuses to follow directory links out of the workspace (junction/symlink containment)', async () => {
    const { rootDir, appServer } = setupTestProject()
    const server = await appServer

    const outsideDir = mkdtempSync(join(tmpdir(), 'pluton-outside-'))
    tmpDirs.push(outsideDir)
    writeFileSync(join(outsideDir, 'outside-secret.txt'), 'TOP_SECRET_OUTSIDE_WORKSPACE', 'utf8')

    const linkPath = join(rootDir, 'linked-outside')
    let linked = false
    try {
      if (process.platform === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, outsideDir], { stdio: 'pipe' })
      } else {
        symlinkSync(outsideDir, linkPath, 'dir')
      }
      linked = true
    } catch {
      linked = false
    }

    try {
      if (!linked) {
        // Hosts without link privileges: containment cannot be exercised here.
        return
      }
      const escape = await fetch(
        `http://127.0.0.1:${server.port}/api/files/content?path=${encodeURIComponent('linked-outside/outside-secret.txt')}`,
        { headers: { 'x-pluton-token': server.token } },
      )
      expect(escape.status).toBe(403)

      const files = await fetch(`http://127.0.0.1:${server.port}/api/files`, {
        headers: { 'x-pluton-token': server.token },
      })
      const listing = (await files.json()) as { ok: boolean; files: string[] }
      expect(listing.files.some((f) => f.startsWith('linked-outside'))).toBe(false)

      // Normal in-workspace reads still work.
      const ok = await fetch(
        `http://127.0.0.1:${server.port}/api/files/content?path=${encodeURIComponent('sample.txt')}`,
        { headers: { 'x-pluton-token': server.token } },
      )
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { content: string }
      expect(body.content).toBe('Hello Pluton Server')
    } finally {
      await server.close()
    }
  })

  it('serves enhanced SPA assets with Task DAG, Worktree Diffs tab, and Approve & Continue button', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      const resHtml = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(resHtml.status).toBe(200)
      const htmlText = await resHtml.text()
      expect(htmlText).toContain('btnBannerApproveContinue')
      expect(htmlText).toContain('btnVerifyRedispatch')
      expect(htmlText).toContain('tabDiffs')
      expect(htmlText).toContain('dagContainer')
      expect(htmlText).toContain('collapsedSidebarToggle')
      expect(htmlText).toContain('btnRestoreSidebar')
      expect(htmlText).toContain('accountInfoBox')
      expect(htmlText).toContain('customModelNameInput')
      expect(htmlText).toContain('customApiKeyInput')
      expect(htmlText).toContain('toggleAutonomous')
      expect(htmlText).toContain('thinkingEffortSelect')

      const resJs = await fetch(`http://127.0.0.1:${server.port}/app.js`)
      expect(resJs.status).toBe(200)
      const jsText = await resJs.text()
      expect(jsText).toContain('loadRunDetail')
      expect(jsText).toContain('renderDiffContent')
      expect(jsText).toContain('plutonVerifyTask')
      expect(jsText).toContain('dag-flow-container')
      expect(jsText).toContain('btnToggleDagMode')
      expect(jsText).toContain("ev.type === 'run_state'")
      expect(jsText).toContain("ev.type === 'task_state'")
      expect(jsText).toContain('loadSettings')
      expect(jsText).toContain('verifyAndAddCustomModel')
      expect(jsText).toContain('handleSignOutAccount')
      expect(jsText).toContain('toggleVoiceInput')
    } finally {
      await server.close()
    }
  })

  it('streams run_state and task_state frames on real run transitions', async () => {
    const { rootDir, appServer } = setupTestProject({ logWatcherIntervalMs: 25 })
    const server = await appServer
    const loaded = loadConfig(rootDir)
    const { store } = bootstrapStore(loaded)
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    try {
      // A real transition to observe: create a run, then let the mock-engine
      // supervisor execute it through the resume route.
      const createRes = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ goal: 'observe live state over SSE' }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { ok: boolean; run: { id: string } }
      const runId = created.run.id

      // The skip-manager resume executes the tasks that exist; seed one so the
      // run produces real task.* transitions too.
      const task = admitTask(
        store,
        {
          runId,
          parentTaskId: null,
          title: 'sse observed task',
          brief: 'exercise task transitions for the log watcher',
          acceptanceCriteria: [],
          assigneeMuseId: 'supervisor',
        },
        { maxChildrenPerTask: 5 },
      )

      // Subscribe BEFORE the transitions so the frames are live deltas.
      const sseRes = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(sseRes.status).toBe(200)
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
      reader = sseRes.body!.getReader()

      const readLoop = readSseFrames(
        reader,
        (frames) =>
          frames.some((frame) => frame.type === 'run_state' && frame.runId === runId) &&
          frames.some(
            (frame) =>
              frame.type === 'task_state' &&
              frame.taskId === task.id &&
              frame.runId === runId &&
              frame.state !== 'queued',
          ),
      )

      const resumeRes = await fetch(`http://127.0.0.1:${server.port}/api/runs/${runId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: '{}',
      })
      expect(resumeRes.status).toBe(200)

      const { frames, dataLines, timedOut } = await readLoop
      expect(timedOut, `no orchestration frames before the deadline; got ${JSON.stringify(frames)}`).toBe(false)

      // Frames only ever come from JSON-parsed `data:` lines (a malformed one
      // would have thrown while reading).
      expect(dataLines.length).toBeGreaterThan(0)
      expect(frames.some((frame) => frame.type === 'connected')).toBe(true)

      const runFrame = frames.find((frame) => frame.type === 'run_state' && frame.runId === runId)
      expect(runFrame, `missing run_state frame; got ${JSON.stringify(frames)}`).toBeDefined()
      expect(typeof runFrame!.state).toBe('string')

      // The seeding admitTask call itself appends `task.admitted`, so a frame
      // with state 'queued' proves nothing: only the supervisor leaving that
      // state (task.started → running, then completed) makes the frame real.
      const taskFrame = frames.find(
        (frame) =>
          frame.type === 'task_state' && frame.taskId === task.id && frame.runId === runId && frame.state !== 'queued',
      )
      expect(taskFrame, `missing supervisor-driven task_state frame; got ${JSON.stringify(frames)}`).toBeDefined()
      expect(taskFrame!.runId).toBe(runId)
      expect(typeof taskFrame!.state).toBe('string')
    } finally {
      // Cancel the reader so the open SSE connection cannot keep server.close() hanging.
      if (reader !== null) {
        await reader.cancel().catch(() => undefined)
      }
      store.close()
      await server.close()
    }
  })

  it('manages runtime settings, account sign in/out, and custom AI models securely', async () => {
    const { appServer } = setupTestProject()
    const server = await appServer
    try {
      // 1. GET /api/settings defaults
      const getSettingsRes = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(getSettingsRes.status).toBe(200)
      const initialSettings = (await getSettingsRes.json()) as {
        ok: boolean
        settings: {
          account: { username: string; email: string; connected: boolean }
          permissions: { autonomousToolExecution: boolean; parallelSubAgents: boolean; autoApproveReadTools: boolean; terminalAndBash: boolean }
          thinkingEffort: string
          customModels: unknown[]
        }
      }
      expect(initialSettings.ok).toBe(true)
      expect(initialSettings.settings.account.connected).toBe(true)
      expect(initialSettings.settings.permissions.autonomousToolExecution).toBe(true)
      expect(initialSettings.settings.thinkingEffort).toBe('auto')

      // 2. POST /api/settings update policy & thinking effort
      const updateSettingsRes = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({
          permissions: { autonomousToolExecution: false, terminalAndBash: false },
          thinkingEffort: 'max',
        }),
      })
      expect(updateSettingsRes.status).toBe(200)
      const updatedSettings = (await updateSettingsRes.json()) as typeof initialSettings
      expect(updatedSettings.settings.permissions.autonomousToolExecution).toBe(false)
      expect(updatedSettings.settings.permissions.parallelSubAgents).toBe(true)
      expect(updatedSettings.settings.permissions.terminalAndBash).toBe(false)
      expect(updatedSettings.settings.thinkingEffort).toBe('max')

      // 3. POST /api/account/signout & /api/account/signin
      const signOutRes = await fetch(`http://127.0.0.1:${server.port}/api/account/signout`, {
        method: 'POST',
        headers: { 'x-pluton-token': server.token },
        body: '{}',
      })
      expect(signOutRes.status).toBe(200)
      const signOutData = (await signOutRes.json()) as { ok: boolean; account: { connected: boolean } }
      expect(signOutData.account.connected).toBe(false)

      const signInRes = await fetch(`http://127.0.0.1:${server.port}/api/account/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ username: 'lead-dev', email: 'lead@pluton.ai' }),
      })
      expect(signInRes.status).toBe(200)
      const signInData = (await signInRes.json()) as {
        ok: boolean
        account: { username: string; email: string; connected: boolean }
      }
      expect(signInData.account.connected).toBe(true)
      expect(signInData.account.username).toBe('lead-dev')
      expect(signInData.account.email).toBe('lead@pluton.ai')

      // 4. POST /api/models/custom registers model without leaking secret API key
      const SECRET_KEY = 'sk-pluton-super-secret-key-12345'
      const addModelRes = await fetch(`http://127.0.0.1:${server.port}/api/models/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pluton-token': server.token },
        body: JSON.stringify({ modelName: 'custom/claude-enterprise-v1', apiKey: SECRET_KEY }),
      })
      expect(addModelRes.status).toBe(200)
      const addModelRaw = await addModelRes.text()
      expect(addModelRaw).not.toContain(SECRET_KEY)
      const addModelData = JSON.parse(addModelRaw) as {
        ok: boolean
        model: { id: string; name: string }
      }
      expect(addModelData.ok).toBe(true)
      expect(addModelData.model.id).toBe('custom/claude-enterprise-v1')

      // 5. GET /api/models lists the custom model under engine 'custom'
      const modelsRes = await fetch(`http://127.0.0.1:${server.port}/api/models`, {
        headers: { 'x-pluton-token': server.token },
      })
      expect(modelsRes.status).toBe(200)
      const modelsRaw = await modelsRes.text()
      expect(modelsRaw).not.toContain(SECRET_KEY)
      const modelsData = JSON.parse(modelsRaw) as {
        ok: boolean
        models: Record<string, Array<{ id: string; name: string }>>
      }
      expect(modelsData.models['custom']).toBeDefined()
      expect(modelsData.models['custom']!.some((m) => m.id === 'custom/claude-enterprise-v1')).toBe(true)
    } finally {
      await server.close()
    }
  })
})
