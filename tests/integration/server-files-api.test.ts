import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'
import { loadConfig } from '../../src/config/load.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'

const TEST_CONFIG = `version: 1
project:
  name: Test Server Files
  repository: .
  default_branch: main
ships: {}
`

describe('Server Files API (On-demand directory expansion & paging)', () => {
  const tmpDirs: string[] = []
  const servers: AppServerInstance[] = []

  afterEach(async () => {
    for (const server of servers) {
      try { await server.close() } catch {}
    }
    servers.length = 0
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
    tmpDirs.length = 0
  })

  function createProject(): { rootDir: string; serverPromise: Promise<AppServerInstance> } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-files-api-')))
    tmpDirs.push(root)
    writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')
    writeFileSync(join(root, 'root-file.txt'), 'root content', 'utf8')
    writeFileSync(join(root, '.env'), 'SECRET=123', 'utf8')

    // Create nested directory structure
    mkdirSync(join(root, 'src', 'components'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}', 'utf8')
    writeFileSync(join(root, 'src', 'components', 'Button.tsx'), 'export const Button = null', 'utf8')

    // Create large directory with 15 files
    mkdirSync(join(root, 'docs', 'items'), { recursive: true })
    for (let i = 0; i < 15; i++) {
      const pad = String(i).padStart(2, '0')
      writeFileSync(join(root, 'docs', 'items', `item-${pad}.md`), `# Item ${pad}`)
    }

    const loaded = loadConfig(root)
    const bootstrapped = bootstrapStore(loaded)
    const serverPromise = startAppServer({
      store: bootstrapped.store,
      projectId: bootstrapped.projectId,
      loaded,
    })
    return { rootDir: root, serverPromise }
  }

  it('lists root directory on demand with entries and legacy files array', async () => {
    const { serverPromise } = createProject()
    const server = await serverPromise
    servers.push(server)

    const res = await fetch(`http://127.0.0.1:${server.port}/api/files`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      dir: string
      entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size: number }>
      files: string[]
      total: number
      hasMore: boolean
    }

    expect(body.ok).toBe(true)
    expect(body.dir).toBe('')
    expect(Array.isArray(body.entries)).toBe(true)
    expect(Array.isArray(body.files)).toBe(true)

    // Check directory sorting: dirs first, then files
    const types = body.entries.map((e) => e.type)
    const firstFileIdx = types.indexOf('file')
    const lastDirIdx = types.lastIndexOf('dir')
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx)
    }

    const entryNames = body.entries.map((e) => e.name)
    expect(entryNames).toContain('src')
    expect(entryNames).toContain('docs')
    expect(entryNames).toContain('root-file.txt')
    // .env should be excluded
    expect(entryNames).not.toContain('.env')
  })

  it('expands nested subdirectory on demand', async () => {
    const { serverPromise } = createProject()
    const server = await serverPromise
    servers.push(server)

    const res = await fetch(`http://127.0.0.1:${server.port}/api/files?dir=src`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      dir: string
      entries: Array<{ name: string; path: string; type: 'dir' | 'file' }>
      total: number
    }

    expect(body.ok).toBe(true)
    expect(body.dir).toBe('src')
    const names = body.entries.map((e) => e.name)
    expect(names).toContain('components')
    expect(names).toContain('index.ts')

    const paths = body.entries.map((e) => e.path.replace(/\\/g, '/'))
    expect(paths).toContain('src/components')
    expect(paths).toContain('src/index.ts')
  })

  it('paginates large directory deterministically', async () => {
    const { serverPromise } = createProject()
    const server = await serverPromise
    servers.push(server)

    // Page 1: 5 items
    const resPage1 = await fetch(`http://127.0.0.1:${server.port}/api/files?dir=docs/items&offset=0&limit=5`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(resPage1.status).toBe(200)
    const page1 = (await resPage1.json()) as {
      ok: boolean
      entries: Array<{ name: string }>
      total: number
      hasMore: boolean
      offset: number
      limit: number
    }
    expect(page1.entries).toHaveLength(5)
    expect(page1.total).toBe(15)
    expect(page1.hasMore).toBe(true)
    expect(page1.entries[0]?.name).toBe('item-00.md')
    expect(page1.entries[4]?.name).toBe('item-04.md')

    // Page 2: next 5 items
    const resPage2 = await fetch(`http://127.0.0.1:${server.port}/api/files?dir=docs/items&offset=5&limit=5`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(resPage2.status).toBe(200)
    const page2 = (await resPage2.json()) as {
      entries: Array<{ name: string }>
      hasMore: boolean
    }
    expect(page2.entries).toHaveLength(5)
    expect(page2.entries[0]?.name).toBe('item-05.md')
    expect(page2.entries[4]?.name).toBe('item-09.md')
    expect(page2.hasMore).toBe(true)

    // Page 3: final 5 items
    const resPage3 = await fetch(`http://127.0.0.1:${server.port}/api/files?dir=docs/items&offset=10&limit=5`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(resPage3.status).toBe(200)
    const page3 = (await resPage3.json()) as {
      entries: Array<{ name: string }>
      hasMore: boolean
    }
    expect(page3.entries).toHaveLength(5)
    expect(page3.entries[4]?.name).toBe('item-14.md')
    expect(page3.hasMore).toBe(false)
  })

  it('rejects traversal in dir query parameter', async () => {
    const { serverPromise } = createProject()
    const server = await serverPromise
    servers.push(server)

    const res = await fetch(`http://127.0.0.1:${server.port}/api/files?dir=../escape`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(res.status).toBe(403)
  })
})
