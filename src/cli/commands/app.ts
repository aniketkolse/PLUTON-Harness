/**
 * `pluton app` / default graphical application launcher command (ADR-0014).
 * Launches Pluton's dual desktop + browser workspace application.
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrapStore } from '../../bootstrap.ts'
import { findProjectRoot, loadConfig } from '../../config/load.ts'
import { launchDesktopApp, type DesktopLaunchResult } from '../../desktop/launcher.ts'
import { InternalError } from '../../domain/errors.ts'
import { checkServerHealth, clearServerInstance, isPidAlive, readServerInstance } from '../../server/instance.ts'
import { startAppServer, type AppServerInstance } from '../../server/server.ts'
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
      if (isPidAlive(existing.pid) && existing.pid !== process.pid) {
        try {
          process.kill(existing.pid, 'SIGTERM')
        } catch {
          // Ignore kill error
        }
      }
      clearServerInstance(rootDir)
      return {
        ok: true,
        mode: 'stop',
        rootDir,
        stopped: true,
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
    const child = spawn(process.execPath, [binPath, ...childArgs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
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
    throw new InternalError('detached app server failed to become ready within 5 seconds')
  }

  // 5. In-process server execution
  const bootstrapped = bootstrapStore(project.loaded)
  const appServer: AppServerInstance = await startAppServer({
    store: bootstrapped.store,
    projectId: bootstrapped.projectId,
    loaded: project.loaded,
    port: opts.port,
  })

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
