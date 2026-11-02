import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'
import { loadConfig } from '../../src/config/load.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'

const TEST_CONFIG = `version: 1
project:
  name: Search Test Project
  repository: .
  default_branch: main
ships: {}
`

describe('Server Files Search API (GET /api/files/search)', () => {
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

  it('searches workspace files and respects limit and query', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-search-it-')))
    tmpDirs.push(root)
    writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')
    mkdirSync(join(root, 'deep', 'nested', 'dir'), { recursive: true })
    writeFileSync(join(root, 'deep', 'nested', 'dir', 'TargetFile.txt'), 'found me', 'utf8')
    writeFileSync(join(root, 'root-target.txt'), 'root target', 'utf8')

    const loaded = loadConfig(root)
    const bootstrapped = bootstrapStore(loaded)
    const server = await startAppServer({
      store: bootstrapped.store,
      projectId: bootstrapped.projectId,
      loaded,
    })
    servers.push(server)

    // Missing query parameter -> 400
    const badRes = await fetch(`http://127.0.0.1:${server.port}/api/files/search`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(badRes.status).toBe(400)

    // Valid query
    const res = await fetch(`http://127.0.0.1:${server.port}/api/files/search?q=target`, {
      headers: { 'x-pluton-token': server.token },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      query: string
      matches: Array<{ name: string; path: string; type: string }>
      totalMatches: number
      truncated: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.query).toBe('target')
    expect(body.matches.length).toBeGreaterThanOrEqual(2)
    const paths = body.matches.map((m) => m.path.replace(/\\/g, '/'))
    expect(paths).toContain('deep/nested/dir/TargetFile.txt')
    expect(paths).toContain('root-target.txt')
  })
})
