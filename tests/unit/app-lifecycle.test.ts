import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkServerHealth,
  claimServerInstance,
  clearServerInstance,
  readServerClaim,
  readServerInstance,
  releaseServerClaim,
  sameDirPath,
  serverClaimPath,
  serverInstancePath,
  writeServerInstance,
} from '../../src/server/instance.ts'
import { existsSync } from 'node:fs'
import { startAppServer } from '../../src/server/server.ts'
import type { ServerInstanceInfo } from '../../src/server/types.ts'
import { optionalProject } from '../../src/cli/context.ts'
import { appRun } from '../../src/cli/commands/app.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'

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

  it('compares workspace paths with platform path semantics (case-insensitive on win32/darwin)', () => {
    const root = join(tmpdir(), 'Pluton-Case-Test')
    const flipped = join(tmpdir(), 'pluton-case-test')
    expect(sameDirPath(root, flipped, 'win32')).toBe(true)
    expect(sameDirPath(root, flipped, 'darwin')).toBe(true)
    expect(sameDirPath(root, flipped, 'linux')).toBe(false)
    // Separator normalization still applies
    expect(sameDirPath('Y:\\Pluton\\', 'Y:\\Pluton', 'win32')).toBe(true)
  })

  it('accepts a healthy server addressed with different path case (same physical workspace)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-case-health-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: case-health\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: '0.1.0', rootDir: root }))
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    activeServers.push(server)
    const port = (server.address() as { port: number }).port

    const flippedRoot = root.replace(/[A-Za-z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
    const instance: ServerInstanceInfo = {
      pid: process.pid,
      port,
      token: 'case-token',
      url: `http://127.0.0.1:${port}/?token=case-token`,
      rootDir: flippedRoot,
      startedAt: new Date().toISOString(),
    }

    const healthy = await checkServerHealth(instance, 500)
    const caseInsensitiveHost = process.platform === 'win32' || process.platform === 'darwin'
    expect(healthy).toBe(caseInsensitiveHost)
  })

  it('refuses to signal a recycled PID from a stale instance file on --stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-stop-recycled-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: stop-recycled\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    // An unrelated, long-lived process whose PID a stale instance file claims.
    const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise((r) => innocent.once('spawn', r))
      const innocentPid = innocent.pid!

      writeServerInstance(root, {
        pid: innocentPid,
        port: 59997, // nothing listens here
        token: 'stale-token',
        url: 'http://127.0.0.1:59997/?token=stale-token',
        rootDir: root,
        startedAt: new Date(0).toISOString(),
      })

      const stopRes = await appRun(optionalProject(root), { stop: true }, root)
      expect(stopRes.ok).toBe(true)
      expect(stopRes.stopped).toBe(true)
      // The instance file is cleared, but the unverified PID is left running.
      expect(readServerInstance(root)).toBeNull()
      expect(stopRes.warning).toContain(String(innocentPid))

      // A regression would signal the PID before --stop returns, but signal
      // delivery is asynchronous — wait for an exit event in a bounded window
      // instead of sleeping a fixed duration.
      const exited = await Promise.race([
        new Promise<boolean>((r) => innocent.once('exit', () => r(true))),
        new Promise<boolean>((r) => setTimeout(() => r(false), 750)),
      ])
      expect(exited).toBe(false)
      expect(innocent.exitCode).toBeNull()
    } finally {
      innocent.kill('SIGKILL')
    }
  })

  it('clears a malformed instance file on --stop and --status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-malformed-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: malformed\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )
    const instancePath = serverInstancePath(root)
    // Create the run directory by writing a valid instance once, then corrupt it.
    writeServerInstance(root, {
      pid: process.pid,
      port: 1,
      token: 'x',
      url: 'http://127.0.0.1:1/?token=x',
      rootDir: root,
      startedAt: new Date(0).toISOString(),
    })
    writeFileSync(instancePath, '{ not valid json', 'utf8')
    expect(readServerInstance(root)).toBeNull()

    const stopRes = await appRun(optionalProject(root), { stop: true }, root)
    expect(stopRes.stopped).toBe(false)
    expect(existsSync(instancePath)).toBe(false)

    // --status also tolerates an unreadable file without crashing
    writeFileSync(instancePath, 'garbage', 'utf8')
    const statusRes = await appRun(optionalProject(root), { status: true }, root)
    expect(statusRes.mode).toBe('status')
    expect(statusRes.stopped).toBe(true)
    clearServerInstance(root)
  })

  it('reports an actionable error and leaves no instance file when the port is taken', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-port-conflict-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: port-conflict\n  repository: .\n  default_branch: main\n\nsandbox:\n  kind: local-process\n  local_process_acknowledged: true\n`,
      'utf8',
    )

    const blocker = createServer((_req, res) => res.end('occupied'))
    await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res))
    const blockedPort = (blocker.address() as { port: number }).port

    try {
      const loaded = loadConfig(root)
      const bootstrapped = bootstrapStore(loaded)
      try {
        await expect(
          startAppServer({
            store: bootstrapped.store,
            projectId: bootstrapped.projectId,
            loaded,
            port: blockedPort,
          }),
        ).rejects.toThrow(new RegExp(`port ${String(blockedPort)}.*already in use.*--port`))
      } finally {
        bootstrapped.store.close()
      }
      // A failed startup must not leave instance metadata behind.
      expect(readServerInstance(root)).toBeNull()
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()))
    }
  })

  it('releases the workspace claim when the requested port is taken', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-apprun-conflict-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: apprun-conflict\n  repository: .\n  default_branch: main\n\nsandbox:\n  kind: local-process\n  local_process_acknowledged: true\n`,
      'utf8',
    )

    const blocker = createServer((_req, res) => res.end('occupied'))
    await new Promise<void>((res) => blocker.listen(0, '127.0.0.1', res))
    const blockedPort = (blocker.address() as { port: number }).port
    try {
      await expect(
        appRun(optionalProject(root), { headless: true, port: blockedPort }, root),
      ).rejects.toThrow(/already in use/)
      expect(readServerInstance(root)).toBeNull()
      expect(readServerClaim(root)).toBeNull()
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()))
    }
  })

  it('grants the workspace claim exclusively and releases it for the owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-claim-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: claim\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    expect(claimServerInstance(root)).toBe(true)
    expect(claimServerInstance(root)).toBe(false)
    const claim = readServerClaim(root)
    expect(claim?.pid).toBe(process.pid)

    // A different live PID must never be able to release our claim.
    releaseServerClaim(root)
    expect(readServerClaim(root)).toBeNull()
    expect(claimServerInstance(root)).toBe(true)
    releaseServerClaim(root, true)
    expect(readServerClaim(root)).toBeNull()
  })

  it('waits for and reuses a server that already holds the claim instead of starting a second one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-claim-reuse-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: claim-reuse\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )

    // A healthy server for this workspace, with the claim held by a separate
    // live process (simulating another launch that is already serving).
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: '0.1.0', rootDir: root }))
    })
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
    activeServers.push(server)
    const port = (server.address() as { port: number }).port

    writeServerInstance(root, {
      pid: process.pid,
      port,
      token: 'claim-token',
      url: `http://127.0.0.1:${port}/?token=claim-token`,
      rootDir: root,
      startedAt: new Date().toISOString(),
    })

    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise((r) => holder.once('spawn', r))
      writeFileSync(serverClaimPath(root), JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }), 'utf8')

      const res = await appRun(optionalProject(root), { headless: true }, root)
      expect(res.reused).toBe(true)
      expect(res.port).toBe(port)
    } finally {
      holder.kill('SIGKILL')
    }
  })

  it('clears a stale claim with a dead owner during --stop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-claim-stale-'))
    tmpDirs.push(root)
    writeFileSync(
      join(root, 'pluton.yaml'),
      `version: 1\nproject:\n  name: claim-stale\n  repository: .\n  default_branch: main\n`,
      'utf8',
    )
    // Create the run directory, then plant a stale claim with a dead owner.
    claimServerInstance(root)
    writeFileSync(serverClaimPath(root), JSON.stringify({ pid: 999999, startedAt: new Date(0).toISOString() }), 'utf8')

    const stopRes = await appRun(optionalProject(root), { stop: true }, root)
    expect(stopRes.ok).toBe(true)
    expect(readServerClaim(root)).toBeNull()
  })
})
