import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
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

function setupTestProject(): { rootDir: string; appServer: Promise<AppServerInstance> } {
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
  })

  return { rootDir: root, appServer: serverPromise }
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

  it('serves task and run diff endpoints', async () => {
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
      } finally {
        store.close()
      }
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

      const resJs = await fetch(`http://127.0.0.1:${server.port}/app.js`)
      expect(resJs.status).toBe(200)
      const jsText = await resJs.text()
      expect(jsText).toContain('loadRunDetail')
      expect(jsText).toContain('renderDiffContent')
      expect(jsText).toContain('plutonVerifyTask')
    } finally {
      await server.close()
    }
  })
})
