import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerProject } from '../../src/projects/registry.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

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

describe('Concurrent Multi-Build Coordination & Persistent Workspace Re-use', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string
  let serverInstance: AppServerInstance | null = null

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-cm-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-ca-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-cb-')))
    tmpDirs.push(tempHome, projectDirA, projectDirB)

    const baseConfig = (name: string) => `version: 1
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

    writeFileSync(join(projectDirA, 'pluton.yaml'), baseConfig('Project Alpha'), 'utf8')
    writeFileSync(join(projectDirB, 'pluton.yaml'), baseConfig('Project Beta'), 'utf8')
  })

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close()
      serverInstance = null
    }
  })

  async function createServer() {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)

    const loadedA = loadConfig(projectDirA)
    const bootA = bootstrapStore(loadedA)

    const server = await startAppServer({
      store: bootA.store,
      projectId: bootA.projectId,
      loaded: loadedA,
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
      return fetch(`http://127.0.0.1:${server.port}${path}`, {
        ...init,
        headers,
      })
    }

    return { server, fetchApi, entryA, entryB }
  }

  it('runs concurrent builds across distinct projects without cross-project conflict', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    // 1. Create run on Project A
    const resRunA = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Build on Project Alpha' }),
    })
    expect(resRunA.status).toBe(201)
    const dataRunA = (await resRunA.json()) as any
    expect(dataRunA.ok).toBe(true)
    const runAId = dataRunA.run.id
    expect(dataRunA.run.projectId).toBe(entryA.id)

    // 2. Create run on Project B
    const resRunB = await fetchApi(`/api/runs?projectId=${entryB.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Build on Project Beta' }),
    })
    expect(resRunB.status).toBe(201)
    const dataRunB = (await resRunB.json()) as any
    expect(dataRunB.ok).toBe(true)
    const runBId = dataRunB.run.id
    expect(dataRunB.run.projectId).toBe(entryB.id)

    // 3. Start Run A
    const resStartA = await fetchApi(`/api/runs/${runAId}/start`, { method: 'POST' })
    expect(resStartA.status).toBe(202)
    const startAData = (await resStartA.json()) as any
    expect(startAData.ok).toBe(true)

    // 4. Concurrently start Run B (different project, must not conflict!)
    const resStartB = await fetchApi(`/api/runs/${runBId}/start`, { method: 'POST' })
    expect(resStartB.status).toBe(202)
    const startBData = (await resStartB.json()) as any
    expect(startBData.ok).toBe(true)

    // 5. Verify run isolation in project listings
    const resListA = await fetchApi(`/api/runs?projectId=${entryA.id}`)
    expect(resListA.status).toBe(200)
    const listA = (await resListA.json()) as any
    const runIdsA = listA.runs.map((r: any) => r.id)
    expect(runIdsA).toContain(runAId)
    expect(runIdsA).not.toContain(runBId)

    const resListB = await fetchApi(`/api/runs?projectId=${entryB.id}`)
    expect(resListB.status).toBe(200)
    const listB = (await resListB.json()) as any
    const runIdsB = listB.runs.map((r: any) => r.id)
    expect(runIdsB).toContain(runBId)
    expect(runIdsB).not.toContain(runAId)
  })

  it('rejects concurrent intra-project build on the same workspace with 409 Conflict', async () => {
    const { fetchApi, entryA } = await createServer()

    // 1. Create run 1 on Project A
    const resRun1 = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'First run in Alpha' }),
    })
    const run1Id = ((await resRun1.json()) as any).run.id

    // 2. Start run 1
    const resStart1 = await fetchApi(`/api/runs/${run1Id}/start`, { method: 'POST' })
    expect(resStart1.status).toBe(202)

    // 3. Create run 2 on Project A with identical workspace
    const resRun2 = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Second concurrent run in Alpha' }),
    })
    const run2Id = ((await resRun2.json()) as any).run.id

    // 4. Attempt to start run 2 while run 1 is active on the same workspace
    const resStart2 = await fetchApi(`/api/runs/${run2Id}/start`, { method: 'POST' })
    expect(resStart2.status).toBe(409)
    const start2Data = (await resStart2.json()) as any
    expect(start2Data.ok).toBe(false)
    expect(start2Data.error).toMatch(/busy|already running/i)
  })

  it('allows subsequent builds to reuse persistent workspace after previous run completes', async () => {
    const { fetchApi, entryA } = await createServer()

    // 1. Create and complete run 1
    const resRun1 = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'First sequential run' }),
    })
    const run1Id = ((await resRun1.json()) as any).run.id

    // Mark run 1 as cancelled in store (or let it complete)
    const pool = serverInstance!.projectPool
    const projA = pool.resolveContext(entryA.id)
    projA.store.setRunState(run1Id, 'cancelled', { finalSummary: 'Cancelled for test' })

    // 2. Subsequent run on the same project and workspace
    const resRun2 = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Subsequent run reusing workspace' }),
    })
    expect(resRun2.status).toBe(201)
    const run2Id = ((await resRun2.json()) as any).run.id

    // 3. Starting run 2 succeeds without conflict
    const resStart2 = await fetchApi(`/api/runs/${run2Id}/start`, { method: 'POST' })
    expect(resStart2.status).toBe(202)
  })

  it('supports listing runs across all projects via GET /api/runs?allProjects=true', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    // Create runs in both projects
    const resRunA = await fetchApi(`/api/runs?projectId=${entryA.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Run in Alpha' }),
    })
    const runAId = ((await resRunA.json()) as any).run.id

    const resRunB = await fetchApi(`/api/runs?projectId=${entryB.id}`, {
      method: 'POST',
      body: JSON.stringify({ goal: 'Run in Beta' }),
    })
    const runBId = ((await resRunB.json()) as any).run.id

    const resAll = await fetchApi('/api/runs?allProjects=true')
    expect(resAll.status).toBe(200)
    const allData = (await resAll.json()) as any
    expect(allData.ok).toBe(true)
    const allIds = allData.runs.map((r: any) => r.id)
    expect(allIds).toContain(runAId)
    expect(allIds).toContain(runBId)

    // Test CLI statusAllProjects helper
    const { statusAllProjects } = await import('../../src/cli/commands/status.ts')
    const allProjectRuns = statusAllProjects(tempHome)
    expect(allProjectRuns.length).toBeGreaterThanOrEqual(2)
    const allProjectRunIds = allProjectRuns.map((r) => r.run.id)
    expect(allProjectRunIds).toContain(runAId)
    expect(allProjectRunIds).toContain(runBId)
  })
})
