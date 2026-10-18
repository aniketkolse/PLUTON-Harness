/**
 * Desktop Application Window Launcher (ADR-0014).
 * Launches Pluton in dedicated app mode via Microsoft Edge or Google Chrome,
 * providing a true standalone graphical desktop window without browser URL chrome.
 * Gracefully falls back to the default system browser if no app-mode browser is found.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface DesktopLaunchResult {
  mode: 'desktop-app' | 'browser'
  browserPath?: string
  process?: ChildProcess
}

export interface LaunchOptions {
  url: string
  preferredMode?: 'desktop' | 'browser'
  width?: number
  height?: number
  spawnFn?: typeof spawn
}

/**
 * Known binary locations for Chromium-based browsers that support `--app=URL` mode.
 * `platform`, `fileExists` and `env` are injectable for tests; defaults match
 * the running process.
 */
export function findAppModeBrowser(
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') {
    const progFiles86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const progFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const localAppData = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData\\Local')

    const candidatePaths = [
      join(progFiles86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(progFiles86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]

    for (const p of candidatePaths) {
      if (fileExists(p)) return p
    }
  } else if (platform === 'darwin') {
    const candidatePaths = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    for (const p of candidatePaths) {
      if (fileExists(p)) return p
    }
  } else {
    // Linux / BSD: probe each PATH directory explicitly — a bare binary name
    // must not be reported as found when it is not installed.
    const binaries = ['microsoft-edge', 'google-chrome', 'chromium-browser', 'chromium']
    const pathDirs = (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')
    for (const bin of binaries) {
      for (const dir of pathDirs) {
        const candidate = join(dir, bin)
        if (fileExists(candidate)) return candidate
      }
    }
  }

  return null
}

/**
 * Launch the URL in dedicated desktop application mode or standard browser.
 */
export function launchDesktopApp(options: LaunchOptions): DesktopLaunchResult {
  const spawnFunc = options.spawnFn ?? spawn
  const width = options.width ?? 1280
  const height = options.height ?? 840

  if (options.preferredMode !== 'browser') {
    const browserPath = findAppModeBrowser()
    if (browserPath) {
      const args = [
        `--app=${options.url}`,
        `--window-size=${width},${height}`,
        '--disable-extensions',
      ]

      const child = spawnFunc(browserPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })

      // Best-effort launch: a missing or failing browser binary must never
      // crash the host with an unhandled 'error' event (spawn ENOENT).
      child.on('error', () => {})
      child.unref()

      return {
        mode: 'desktop-app',
        browserPath,
        process: child,
      }
    }
  }

  // Fallback to default browser
  const platform = process.platform
  let openerCmd = 'xdg-open'
  let openerArgs: string[] = [options.url]

  if (platform === 'win32') {
    openerCmd = 'cmd.exe'
    openerArgs = ['/c', 'start', '', options.url]
  } else if (platform === 'darwin') {
    openerCmd = 'open'
    openerArgs = [options.url]
  }

  const child = spawnFunc(openerCmd, openerArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })

  child.on('error', () => {})
  child.unref()

  return {
    mode: 'browser',
    process: child,
  }
}
