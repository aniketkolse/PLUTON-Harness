import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { getProjectRegistry, registerProject } from '../../src/projects/registry.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

/**
 * Persistent Build sessions over the real HTTP API (PLUTON 4.1 Phase 4).
 *
 * The first Build establishes the project workspace and optional operator
 * name; later Builds reuse that session without a repeat confirmation. A
 * server restart re-reads the same durable anchor, and rename never moves the
 * project directory.
 */

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows lock tolerance
    }
  }
})

const CONFIG = (name: string) => `version: 1
project:
  name: ${name}
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
  network_policy: open
ships:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/test
    workspace_policy: coordinator-read-only
`

describe('persistent Build sessions', () => {
  let tempHome: string
  let projectDir: string
  let serverInstance: AppServerInstance | null = null

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-pbuild-home-')))
    projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-pbuild-proj-')))
    tmpDirs.push(tempHome, projectDir)
    writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG('Initial Project'), 'utf8')
  })

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close()
      serverInstance = null
    }
  })

  async function createServer() {
    const entry = registerProject(projectDir, tempHome)
    const loaded = loadConfig(projectDir)
    const boot = bootstrapStore(loaded)
    const server = await startAppServer({
      store: boot.store,
      projectId: boot.projectId,
      loaded,
      customHome: tempHome,
    })
    serverInstance = server

    const fetchApi = (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('x-pluton-token', server.token)
      headers.set('origin', `http://127.0.0.1:${server.port}`)
      headers.set('host', `127.0.0.1:${server.port}`)
      if (init.body && !headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }
      return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers })
    }

    return { fetchApi, entry }
  }

  it('establishes the session and operator name on the first Build', async () => {
    const { fetchApi, entry } = await createServer()

    const res = await fetchApi(`/api/runs?projectId=${entry.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Build the landing page', projectName: 'Operator Named' }),
    })
    expect(res.status).toBe(201)
    const data = (await res.json()) as any

    expect(data.run.projectSessionId).toBe(data.projectSession.id)
    expect(data.projectSession.buildCount).toBe(1)
    expect(data.projectSession.workspaceRoot).toBe(entry.rootDir)
    expect(data.run.workspaceRoot).toBe(entry.rootDir)

    expect(loadConfig(projectDir).config.project.name).toBe('Operator Named')
    expect(getProjectRegistry(tempHome).projects[entry.id]?.name).toBe('Operator Named')

    const wsRes = await fetchApi(`/api/workspace?projectId=${entry.id}`)
    expect(wsRes.status).toBe(200)
    const ws = (await wsRes.json()) as any
    expect(ws.workspace.name).toBe('Operator Named')
    expect(ws.workspace.projectSession.id).toBe(data.projectSession.id)
    expect(ws.workspace.projectSession.buildCount).toBe(1)
    expect(ws.workspace.projectSession.workspaceRoot).toBe(entry.rootDir)
  })

  it('reuses the same session and workspace for later Builds', async () => {
    const { fetchApi, entry } = await createServer()

    const first = (await (
      await fetchApi(`/api/runs?projectId=${entry.id}`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'First build' }),
      })
    ).json()) as any

    const second = (await (
      await fetchApi(`/api/runs?projectId=${entry.id}`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'Second build' }),
      })
    ).json()) as any

    expect(second.projectSession.id).toBe(first.projectSession.id)
    expect(second.projectSession.buildCount).toBe(2)
    expect(second.projectSession.workspaceRoot).toBe(first.projectSession.workspaceRoot)
    expect(second.run.projectSessionId).toBe(first.projectSession.id)
    expect(second.run.workspaceRoot).toBe(first.run.workspaceRoot)

    const ws = (await (await fetchApi(`/api/workspace?projectId=${entry.id}`)).json()) as any
    expect(ws.workspace.projectSession.buildCount).toBe(2)
    expect(ws.workspace.rootDir).toBe(first.projectSession.workspaceRoot)
  })

  it('keeps the session and build counter across a server restart', async () => {
    const { fetchApi, entry } = await createServer()

    const created = (await (
      await fetchApi(`/api/runs?projectId=${entry.id}`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'Before restart' }),
      })
    ).json()) as any

    await serverInstance!.close()
    serverInstance = null

    // Reopen the same project: a fresh store and a fresh server process.
    const restarted = await createServer()
    const ws = (await (await restarted.fetchApi(`/api/workspace?projectId=${entry.id}`)).json()) as any
    expect(ws.workspace.projectSession.id).toBe(created.projectSession.id)
    expect(ws.workspace.projectSession.buildCount).toBe(1)
    expect(ws.workspace.projectSession.workspaceRoot).toBe(created.projectSession.workspaceRoot)
  })

  it('renames through PATCH without moving the workspace', async () => {
    const { fetchApi, entry } = await createServer()

    const res = await fetchApi(`/api/projects/${entry.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed Through API' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.project.name).toBe('Renamed Through API')
    expect(body.project.rootDir).toBe(entry.rootDir)

    expect(loadConfig(projectDir).config.project.name).toBe('Renamed Through API')
    expect(getProjectRegistry(tempHome).projects[entry.id]?.name).toBe('Renamed Through API')

    const ws = (await (await fetchApi(`/api/workspace?projectId=${entry.id}`)).json()) as any
    expect(ws.workspace.name).toBe('Renamed Through API')
    expect(ws.workspace.rootDir).toBe(entry.rootDir)
  })

  it('still rejects a concurrent start on the same workspace with 409', async () => {
    const { fetchApi, entry } = await createServer()

    const first = (await (
      await fetchApi(`/api/runs?projectId=${entry.id}`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'First active build' }),
      })
    ).json()) as any
    const startFirst = await fetchApi(`/api/runs/${first.run.id}/start`, { method: 'POST' })
    expect(startFirst.status).toBe(202)

    const second = (await (
      await fetchApi(`/api/runs?projectId=${entry.id}`, {
        method: 'POST',
        body: JSON.stringify({ goal: 'Second concurrent build' }),
      })
    ).json()) as any
    const startSecond = await fetchApi(`/api/runs/${second.run.id}/start`, { method: 'POST' })
    expect(startSecond.status).toBe(409)

    // Stop the live run so teardown does not wait on a supervisor.
    await fetchApi(`/api/runs/${first.run.id}/cancel`, { method: 'POST' })
  }, 20_000)
})
