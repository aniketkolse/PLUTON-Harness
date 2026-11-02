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
      // Windows file locks tolerance
    }
  }
})

describe('Server Multi-Project Context Pool & REST Endpoints', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string
  let serverInstance: AppServerInstance | null = null

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-srv-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-sa-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-sb-')))
    tmpDirs.push(tempHome, projectDirA, projectDirB)

    // Project A config
    writeFileSync(
      join(projectDirA, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Server Alpha\n  repository: .\n  default_branch: main\n  verification: []\nships:\n  supervisor:\n    display_name: Supervisor\n    role: supervisor\n    engine: mock\n    model: mock/test\n    workspace_policy: coordinator-read-only\n`,
      'utf8',
    )
    writeFileSync(join(projectDirA, 'alpha-file.txt'), 'hello from alpha', 'utf8')

    // Project B config
    writeFileSync(
      join(projectDirB, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Server Beta\n  repository: .\n  default_branch: develop\n  verification: []\nships:\n  supervisor:\n    display_name: Supervisor\n    role: supervisor\n    engine: mock\n    model: mock/test\n    workspace_policy: coordinator-read-only\n`,
      'utf8',
    )
    writeFileSync(join(projectDirB, 'beta-file.txt'), 'hello from beta', 'utf8')
  })

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close()
      serverInstance = null
    }
  })

  async function createServer() {
    // Register both projects in custom test home
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

  it('GET /api/projects returns registered projects with active status and metadata', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    const res = await fetchApi('/api/projects')
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.ok).toBe(true)
    expect(Array.isArray(data.projects)).toBe(true)
    expect(data.projects.length).toBe(2)

    const pA = data.projects.find((p: any) => p.id === entryA.id)
    const pB = data.projects.find((p: any) => p.id === entryB.id)
    expect(pA).toBeDefined()
    expect(pB).toBeDefined()
    expect(pA.name).toBe('Server Alpha')
    expect(pB.name).toBe('Server Beta')
  })

  it('serves project-scoped workspace and files using query parameter ?projectId=', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    // 1. Files in project A
    const resFilesA = await fetchApi(`/api/files?projectId=${entryA.id}`)
    expect(resFilesA.status).toBe(200)
    const filesA = (await resFilesA.json()) as any
    expect(filesA.ok).toBe(true)
    expect(filesA.files).toContain('alpha-file.txt')
    expect(filesA.files).not.toContain('beta-file.txt')

    // 2. Files in project B
    const resFilesB = await fetchApi(`/api/files?projectId=${entryB.id}`)
    expect(resFilesB.status).toBe(200)
    const filesB = (await resFilesB.json()) as any
    expect(filesB.ok).toBe(true)
    expect(filesB.files).toContain('beta-file.txt')
    expect(filesB.files).not.toContain('alpha-file.txt')

    // 3. Workspace for Project B
    const resWsB = await fetchApi(`/api/workspace?projectId=${entryB.id}`)
    expect(resWsB.status).toBe(200)
    const wsB = (await resWsB.json()) as any
    expect(wsB.ok).toBe(true)
    expect(wsB.workspace.name).toBe('Server Beta')
    expect(wsB.workspace.projectId).toBe(entryB.id)
  })

  it('POST /api/projects/switch updates client context without mutating global active-project file', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    // 1. Initial current project is Project A
    const resCurr1 = await fetchApi('/api/projects/current')
    expect(resCurr1.status).toBe(200)
    const curr1 = (await resCurr1.json()) as any
    expect(curr1.project.id).toBe(entryA.id)

    // 2. Client switches to Project B
    const resSwitch = await fetchApi('/api/projects/switch', {
      method: 'POST',
      body: JSON.stringify({ projectId: entryB.id }),
    })
    expect(resSwitch.status).toBe(200)
    const switched = (await resSwitch.json()) as any
    expect(switched.ok).toBe(true)
    expect(switched.activeProjectId).toBe(entryB.id)

    // 3. Querying current with client scope returns Project B
    const resCurr2 = await fetchApi(`/api/projects/current?projectId=${entryB.id}`)
    expect(resCurr2.status).toBe(200)
    const curr2 = (await resCurr2.json()) as any
    expect(curr2.project.id).toBe(entryB.id)

    // 4. Verify global active-project pointer still points to Project A (or was untouched)
    const { getActiveProjectId } = await import('../../src/projects/registry.ts')
    expect(getActiveProjectId(tempHome)).toBe(entryA.id)
  })

  it('POST /api/projects registers new project and makes it immediately accessible', async () => {
    const { fetchApi } = await createServer()
    const projectDirC = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-sc-')))
    tmpDirs.push(projectDirC)

    writeFileSync(
      join(projectDirC, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Server Gamma\n  repository: .\n  default_branch: main\n  verification: []\nships: {}\n`,
      'utf8',
    )

    const res = await fetchApi('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: projectDirC }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.ok).toBe(true)
    expect(data.project.name).toBe('Server Gamma')

    // Verify it now appears in /api/projects
    const listRes = await fetchApi('/api/projects')
    const listData = (await listRes.json()) as any
    expect(listData.projects.length).toBe(3)
  })
})
