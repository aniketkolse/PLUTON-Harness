/**
 * `pluton app` / default graphical application launcher command (ADR-0014).
 * Launches Pluton's dual desktop + browser workspace application.
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapStore } from '../../bootstrap.ts'
import { findProjectRoot, loadConfig } from '../../config/load.ts'
import { launchDesktopApp, type DesktopLaunchResult } from '../../desktop/launcher.ts'
import { InternalError } from '../../domain/errors.ts'
import {
  checkServerHealth,
  claimServerInstance,
  clearServerInstance,
  isPidAlive,
  readServerClaim,
  readServerInstance,
  releaseServerClaim,
  serverClaimPath,
} from '../../server/instance.ts'
import { startAppServer, type AppServerInstance } from '../../server/server.ts'
import type { ServerInstanceInfo } from '../../server/types.ts'
import type { ProjectContext } from '../context.ts'
import { runInit } from './init.ts'

export interface AppCommandOptions {
  desktop?: boolean
  browser?: boolean
  port?: number
  headless?: boolean
  detach?: boolean
  stop?: boolean
  status?: boolean
  json?: boolean
}

export interface AppRunResult {
  ok: boolean
  mode: 'desktop' | 'browser' | 'headless' | 'status' | 'stop'
  url?: string
  port?: number
  pid?: number
  rootDir: string
  reused?: boolean
  stopped?: boolean
  /** Present when `--stop` deliberately did not signal a live unverified PID. */
  warning?: string
  server?: AppServerInstance
  waitForClose?: () => Promise<void>
}

export async function resolveOrInitProject(targetPath: string): Promise<ProjectContext> {
  const absPath = resolve(targetPath)
  let root = findProjectRoot(absPath)
  if (!root) {
    // Auto-initialize workspace if not yet a Pluton project
    await runInit({ cwd: absPath, team: 'full-stack' })
    root = findProjectRoot(absPath) ?? absPath
  }
  const loaded = loadConfig(root)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

/**
 * Wait up to `timeoutMs` for the server that holds this workspace's claim to
 * become healthy. Returns its instance info, or null when no healthy server
 * appears in time (caller then decides between takeover and an honest error).
 */
async function waitForClaimedServer(rootDir: string, timeoutMs: number): Promise<ServerInstanceInfo | null> {
  const start = Date.now()
  for (;;) {
    const inst = readServerInstance(rootDir)
    if (inst && (await checkServerHealth(inst, 500))) return inst
    if (Date.now() - start >= timeoutMs) return null
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function appRun(
  projectOrNull: ProjectContext | null,
  opts: AppCommandOptions = {},
  targetPath = '.',
): Promise<AppRunResult> {
  const project = projectOrNull ?? (await resolveOrInitProject(targetPath))
  const rootDir = project.rootDir

  // 1. Status query
  if (opts.status) {
    const existing = readServerInstance(rootDir)
    if (existing) {
      const isAlive = await checkServerHealth(existing)
      if (isAlive) {
        return {
          ok: true,
          mode: 'status',
          url: existing.url,
          port: existing.port,
          pid: existing.pid,
          rootDir,
          reused: true,
        }
      }
      clearServerInstance(rootDir)
    }
    return {
      ok: true,
      mode: 'status',
      rootDir,
      stopped: true,
    }
  }

  // 2. Stop command
  if (opts.stop) {
    const existing = readServerInstance(rootDir)
    if (existing) {
      // Only signal a process this instance file provably describes: the authenticated
      // health check succeeds only for a live Pluton server for THIS workspace. A stale
      // file whose PID was recycled by an unrelated process must never be signalled.
      const verified = await checkServerHealth(existing)
      let warning: string | undefined
      let force = false
      if (verified && existing.pid !== process.pid) {
        try {
          process.kill(existing.pid, 'SIGTERM')
        } catch {
          // Ignore kill error; the file is cleared either way.
        }
        // A verified server is safe to fully release, even if it is mid-shutdown.
        force = true
      } else if (!verified && isPidAlive(existing.pid) && existing.pid !== process.pid) {
        warning = `instance file referenced live PID ${existing.pid} that is not this workspace's server (stale or recycled PID); it was NOT signalled — stop it manually if it is yours`
      }
      clearServerInstance(rootDir)
      releaseServerClaim(rootDir, force)
      return {
        ok: true,
        mode: 'stop',
        rootDir,
        stopped: true,
        ...(warning ? { warning } : {}),
      }
    }
    // No readable instance file (absent or malformed): still remove it so a corrupt
    // file cannot outlive `--stop`. Clear a stale claim (dead owner) but leave a
    // live one alone — an unverified live PID is never signalled or discarded.
    clearServerInstance(rootDir)
    const claim = readServerClaim(rootDir)
    if (!claim || !isPidAlive(claim.pid)) {
      releaseServerClaim(rootDir, true)
    } else if (claim.pid !== process.pid) {
      return {
        ok: true,
        mode: 'stop',
        rootDir,
        stopped: false,
        warning: `workspace server slot is held by live PID ${String(claim.pid)} (no verifiable instance file); it was NOT signalled — stop it manually if it is yours`,
      }
    }
    return {
      ok: true,
      mode: 'stop',
      rootDir,
      stopped: false,
    }
  }

  // 3. Check for existing healthy server
  const existing = readServerInstance(rootDir)
  if (existing) {
    const isHealthy = await checkServerHealth(existing)
    if (isHealthy) {
      const preferredMode = opts.browser ? 'browser' : 'desktop'
      let launchRes: DesktopLaunchResult | undefined

      if (!opts.headless) {
        launchRes = launchDesktopApp({
          url: existing.url,
          preferredMode,
        })
      }

      return {
        ok: true,
        mode: opts.headless ? 'headless' : launchRes?.mode === 'desktop-app' ? 'desktop' : 'browser',
        url: existing.url,
        port: existing.port,
        pid: existing.pid,
        rootDir,
        reused: true,
      }
    }
    // Clean up stale instance file
    clearServerInstance(rootDir)
  }

  // 4. Detached background daemon spawn
  if (opts.detach) {
    const binPath = fileURLToPath(new URL('../../../bin/pluton.js', import.meta.url))
    const childArgs = ['app', targetPath, '--headless']
    if (opts.port) childArgs.push('--port', String(opts.port))

    const logDir = join(rootDir, '.pluton', 'run')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'server.log')
    // Owner-only: the detached child's stdout carries the tokenized workspace URL.
    const logFd = openSync(logPath, 'a', 0o600)

    const child = spawn(process.execPath, [binPath, ...childArgs], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })
    try {
      closeSync(logFd)
    } catch {
      // Ignore
    }
    child.unref()

    // Poll until healthy (up to 5s)
    const startTime = Date.now()
    while (Date.now() - startTime < 5000) {
      await new Promise((r) => setTimeout(r, 100))
      const inst = readServerInstance(rootDir)
      if (inst && (await checkServerHealth(inst, 500))) {
        let launchRes: DesktopLaunchResult | undefined
        if (!opts.headless) {
          launchRes = launchDesktopApp({
            url: inst.url,
            preferredMode: opts.browser ? 'browser' : 'desktop',
          })
        }
        return {
          ok: true,
          mode: opts.headless ? 'headless' : launchRes?.mode === 'desktop-app' ? 'desktop' : 'browser',
          url: inst.url,
          port: inst.port,
          pid: inst.pid,
          rootDir,
          reused: false,
        }
      }
    }
    let detail = ''
    try {
      if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
        detail = lines.slice(-3).join('; ')
      }
    } catch {
      // Ignore
    }
    throw new InternalError(`detached app server failed to become ready within 5 seconds${detail ? `: ${detail}` : ''}`)
  }

  // 5. In-process server execution — claim the workspace slot first so two
  // simultaneous launches cannot both bind separate ports for one workspace.
  if (!claimServerInstance(rootDir)) {
    const claim = readServerClaim(rootDir)
    const ownerAlive = claim !== null && isPidAlive(claim.pid) && claim.pid !== process.pid

    if (ownerAlive) {
      // Another launch is starting or running. A healthy server always wins.
      const claimed = await waitForClaimedServer(rootDir, 5000)
      if (claimed) {
        const preferredMode = opts.browser ? 'browser' : 'desktop'
        let launchRes: DesktopLaunchResult | undefined
        if (!opts.headless) {
          launchRes = launchDesktopApp({ url: claimed.url, preferredMode })
        }
        return {
          ok: true,
          mode: opts.headless ? 'headless' : launchRes?.mode === 'desktop-app' ? 'desktop' : 'browser',
          url: claimed.url,
          port: claimed.port,
          pid: claimed.pid,
          rootDir,
          reused: true,
        }
      }
      if (isPidAlive(claim.pid)) {
        throw new InternalError(
          `another Pluton process (PID ${String(claim.pid)}) holds this workspace's server slot but is not responding to health checks; ` +
            'stop that process (or remove .pluton/run/server.claim if it is gone) and retry',
          { details: { pid: claim.pid, claimPath: serverClaimPath(rootDir) } },
        )
      }
    }

    // Stale claim (dead owner), or a claim we already own: take it over once.
    releaseServerClaim(rootDir, true)
    if (!claimServerInstance(rootDir)) {
      throw new InternalError(
        'could not claim the workspace server slot (.pluton/run/server.claim); retry, or remove it if no Pluton process is running',
        { details: { claimPath: serverClaimPath(rootDir) } },
      )
    }
  }

  const bootstrapped = bootstrapStore(project.loaded)
  let appServer: AppServerInstance
  try {
    appServer = await startAppServer({
      store: bootstrapped.store,
      projectId: bootstrapped.projectId,
      loaded: project.loaded,
      port: opts.port,
    })
  } catch (err) {
    // A failed startup (e.g. requested port taken) must not leave this
    // workspace claimed or the store handle open.
    bootstrapped.store.close()
    releaseServerClaim(rootDir, true)
    throw err
  }

  const preferredMode = opts.browser ? 'browser' : 'desktop'
  let launchRes: DesktopLaunchResult | undefined

  if (!opts.headless) {
    launchRes = launchDesktopApp({
      url: appServer.url,
      preferredMode,
    })
  }

  const resultMode = opts.headless
    ? 'headless'
    : launchRes?.mode === 'desktop-app'
      ? 'desktop'
      : 'browser'

  const waitForClose = (): Promise<void> =>
    new Promise<void>((resolveExit) => {
      const handleSignal = async (): Promise<void> => {
        process.removeListener('SIGINT', handleSignal)
        process.removeListener('SIGTERM', handleSignal)
        await appServer.close()
        releaseServerClaim(rootDir)
        resolveExit()
      }
      process.once('SIGINT', handleSignal)
      process.once('SIGTERM', handleSignal)
    })

  return {
    ok: true,
    mode: resultMode,
    url: appServer.url,
    port: appServer.port,
    pid: appServer.info.pid,
    rootDir,
    reused: false,
    server: appServer,
    waitForClose,
  }
}
