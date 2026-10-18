import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkServerHealth, clearServerInstance, readServerInstance, writeServerInstance } from '../../src/server/instance.ts'
import type { ServerInstanceInfo } from '../../src/server/types.ts'
import { optionalProject } from '../../src/cli/context.ts'
import { appRun } from '../../src/cli/commands/app.ts'

const tmpDirs: string[] = []
const activeServers: Server[] = []

afterEach(async () => {
  for (const s of activeServers.splice(0)) {
    await new Promise<void>((res) => s.close(() => res()))
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('desktop and browser application lifecycle', () => {
  it('rejects health check if server is an unintended service (non-JSON or different rootDir)', async () => {
    const rootA = mkdtempSync(join(tmpdir(), 'pluton-health-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'pluton-health-b-'))
    tmpDirs.push(rootA, rootB)

    // Mock an unintended HTTP service that returns 200 HTML on /api/health
    const unintendedServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body>Not Pluton</body></html>')
    })
    await new Promise<void>((res) => unintendedServer.listen(0, '127.0.0.1', res))
    activeServers.push(unintendedServer)
    const unintendedPort = (unintendedServer.address() as { port: number }).port

    const unintendedInstance: ServerInstanceInfo = {
      pid: process.pid,
      port: unintendedPort,
      token: 'fake-token-1234567890abcdef1234567890abcdef',
      url: `http://127.0.0.1:${unintendedPort}/?token=fake`,
      rootDir: rootA,
      startedAt: new Date().toISOString(),
    }

    // Must be rejected because it is not a Pluton HealthResponse
    const isUnintendedHealthy = await checkServerHealth(unintendedInstance, 500)
    expect(isUnintendedHealthy).toBe(false)

    // Mock a Pluton server for rootB
    const plutonServerB = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          version: '0.1.0',
          node: process.version,
          platform: process.platform,
          projectId: 'proj-b',
          projectName: 'project-b',
          rootDir: rootB,
        }),
      )
    })
    await new Promise<void>((res) => plutonServerB.listen(0, '127.0.0.1', res))
    activeServers.push(plutonServerB)
    const portB = (plutonServerB.address() as { port: number }).port

    // Checking rootA against server for rootB must fail
    const mismatchedInstance: ServerInstanceInfo = {
      pid: process.pid,
      port: portB,
      token: 'fake-token-1234567890abcdef1234567890abcdef',
      url: `http://127.0.0.1:${portB}/?token=fake`,
      rootDir: rootA,
      startedAt: new Date().toISOString(),
    }
    const isMismatchedHealthy = await checkServerHealth(mismatchedInstance, 500)
    expect(isMismatchedHealthy).toBe(false)

    // Checking rootB against server for rootB must succeed
    const matchedInstance: ServerInstanceInfo = {
      ...mismatchedInstance,
      rootDir: rootB,
    }
    const isMatchedHealthy = await checkServerHealth(matchedInstance, 500)
    expect(isMatchedHealthy).toBe(true)
  })

  it('provides portable configuration paths in optionalProject', () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-ctx-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: ctx-test\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    const ctx = optionalProject(root)
    expect(ctx).not.toBeNull()
    expect(ctx!.configPath).not.toContain('\\\\')
    expect(ctx!.configPath.endsWith('pluton.yaml')).toBe(true)
    expect(ctx!.rootDir).toBe(root)
  })

  it('safely reuses existing healthy instance on multiple invocations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-reuse-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: reuse-test\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    // Mock healthy server
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          version: '0.1.0',
          rootDir: root,
        }),
      )
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    activeServers.push(server)
    const port = (server.address() as { port: number }).port

    writeServerInstance(root, {
      pid: process.pid,
      port,
      token: 'test-token',
      url: `http://127.0.0.1:${port}/?token=test-token`,
      rootDir: root,
      startedAt: new Date().toISOString(),
    })

    const runRes = await appRun(null, { headless: true }, root)
    expect(runRes.reused).toBe(true)
    expect(runRes.port).toBe(port)
    expect(runRes.url).toBe(`http://127.0.0.1:${port}/?token=test-token`)
    expect(runRes.waitForClose).toBeUndefined()
  })
})
