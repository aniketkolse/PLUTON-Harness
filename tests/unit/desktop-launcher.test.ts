import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { findAppModeBrowser, launchDesktopApp } from '../../src/desktop/launcher.ts'

/** Minimal fake child accepted by the launcher's `spawnFn` seam. */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  child.unref = () => {}
  return child
}

describe('desktop launcher', () => {
  it('detects app mode browser or returns null/string', () => {
    const browser = findAppModeBrowser()
    if (browser) {
      expect(typeof browser).toBe('string')
    } else {
      expect(browser).toBeNull()
    }
  })

  it('resolves Linux binaries from PATH instead of reporting the first name unconditionally', () => {
    const usrBin = join('/usr', 'bin')
    const usrLocalBin = join('/usr', 'local', 'bin')

    expect(findAppModeBrowser('linux', () => false, { PATH: [usrBin, join('/bin')].join(delimiter) })).toBeNull()

    const onlyChromium = (p: string): boolean => p === join(usrLocalBin, 'chromium')
    expect(findAppModeBrowser('linux', onlyChromium, { PATH: [usrLocalBin, usrBin].join(delimiter) })).toBe(
      join(usrLocalBin, 'chromium'),
    )

    // Priority: google-chrome wins over chromium when both are installed.
    const both = (p: string): boolean => p === join(usrBin, 'google-chrome') || p === join(usrBin, 'chromium')
    expect(findAppModeBrowser('linux', both, { PATH: usrBin })).toBe(join(usrBin, 'google-chrome'))

    // A binary name on PATH that the probe rejects must not be reported.
    const rejectsEdge = (p: string): boolean => p === join(usrBin, 'chromium')
    expect(findAppModeBrowser('linux', rejectsEdge, { PATH: usrBin })).toBe(join(usrBin, 'chromium'))
  })

  it('resolves macOS app bundles and Windows install paths via the injected probe', () => {
    const macProbe = (p: string): boolean => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(findAppModeBrowser('darwin', macProbe, {})).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
    expect(findAppModeBrowser('darwin', () => false, {})).toBeNull()

    const edge = join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    const winProbe = (p: string): boolean => p === edge
    expect(
      findAppModeBrowser('win32', winProbe, { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }),
    ).toBe(edge)
  })

  it('launches in desktop app mode when supported using mock spawn', () => {
    let spawnedArgs: string[] = []

    const mockSpawn = ((cmd: string, args: string[]) => {
      void cmd
      spawnedArgs = args
      return fakeChild()
    }) as unknown as typeof import('node:child_process').spawn

    const res = launchDesktopApp({
      url: 'http://127.0.0.1:4000/?token=abc',
      preferredMode: 'desktop',
      spawnFn: mockSpawn,
      width: 1400,
      height: 900,
    })

    if (res.mode === 'desktop-app') {
      expect(spawnedArgs).toContain('--app=http://127.0.0.1:4000/?token=abc')
      expect(spawnedArgs).toContain('--window-size=1400,900')
    } else {
      expect(res.mode).toBe('browser')
    }
  })

  it('launches in browser mode when preferredMode is browser', () => {
    let spawnedArgs: string[] = []

    const mockSpawn = ((cmd: string, args: string[]) => {
      void cmd
      spawnedArgs = args
      return fakeChild()
    }) as unknown as typeof import('node:child_process').spawn

    const res = launchDesktopApp({
      url: 'http://127.0.0.1:4000/?token=abc',
      preferredMode: 'browser',
      spawnFn: mockSpawn,
    })

    expect(res.mode).toBe('browser')
    expect(spawnedArgs).toContain('http://127.0.0.1:4000/?token=abc')
  })

  it('does not crash when the spawned browser/opener emits an error event', () => {
    // Node emits 'error' on a failed spawn (ENOENT). Without a listener that
    // is an uncaught exception; the launcher must swallow it (best-effort).
    const fake = fakeChild()
    const mockSpawn = (() => fake) as unknown as typeof import('node:child_process').spawn

    launchDesktopApp({
      url: 'http://127.0.0.1:4000/?token=abc',
      preferredMode: 'browser',
      spawnFn: mockSpawn,
    })

    expect(() => fake.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow()
  })
})
