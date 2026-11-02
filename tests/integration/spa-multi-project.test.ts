import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerProject } from '../../src/projects/registry.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'
import { STATIC_ASSETS } from '../../src/server/static-assets.ts'

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

describe('PLUTON SPA — Multi-Project Web Workspace & Project Selector', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string
  let serverInstance: AppServerInstance | null = null

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-spa-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-sa-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-sb-')))
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

  it('serves index.html with required project selector DOM elements', async () => {
    const html = STATIC_ASSETS['/index.html']?.content ?? ''
    expect(html).toContain('id="projectSelectDropdown"')
    expect(html).toContain('id="projectSelectBtn"')
    expect(html).toContain('id="projectSelectName"')
  })

  it('contains client-side project switching logic in app.js', () => {
    const js = STATIC_ASSETS['/app.js']?.content ?? ''
    expect(js).toContain('loadProjects')
    expect(js).toContain('switchActiveProject')
    expect(js).toContain('projectSelectDropdown')
    expect(js).toContain('X-Pluton-Project')
  })

  it('serves SPA via HTTP and allows switching active project in web client without global pointer mutation', async () => {
    const { fetchApi, entryA, entryB } = await createServer()

    // 1. Fetch index.html via server
    const resHtml = await fetchApi('/')
    expect(resHtml.status).toBe(200)
    const textHtml = await resHtml.text()
    expect(textHtml).toContain('id="projectSelectDropdown"')
    expect(textHtml).toContain('id="projectSelectBtn"')

    // 2. Query /api/projects
    const resProjects = await fetchApi('/api/projects')
    expect(resProjects.status).toBe(200)
    const dataProjects = (await resProjects.json()) as any
    expect(dataProjects.ok).toBe(true)
    expect(dataProjects.projects.length).toBeGreaterThanOrEqual(2)

    // 3. Client calls with Project B scope header
    const resSessionsB = await fetchApi('/api/sessions', {
      headers: { 'X-Pluton-Project': entryB.id },
    })
    expect(resSessionsB.status).toBe(200)
    const dataSessionsB = (await resSessionsB.json()) as any
    expect(dataSessionsB.ok).toBe(true)

    // Verify global active project pointer was NOT mutated by client query
    const { getActiveProjectId } = await import('../../src/projects/registry.ts')
    const active = getActiveProjectId(tempHome)
    expect(active).toBe(entryA.id)
  })
})
