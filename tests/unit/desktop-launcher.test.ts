import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { findAppModeBrowser, launchDesktopApp } from '../../src/desktop/launcher.ts'

describe('desktop launcher', () => {
  it('detects app mode browser or returns null/string', () => {
    const browser = findAppModeBrowser()
    if (browser) {
      expect(typeof browser).toBe('string')
    } else {
      expect(browser).toBeNull()
    }
  })

  it('launches in desktop app mode when supported using mock spawn', () => {
    let spawnedCmd = ''
    let spawnedArgs: string[] = []

    const mockSpawn = ((cmd: string, args: string[]) => {
      spawnedCmd = cmd
      spawnedArgs = args
      return {
        unref: () => {},
      } as unknown as ChildProcess
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
    let spawnedCmd = ''
    let spawnedArgs: string[] = []

    const mockSpawn = ((cmd: string, args: string[]) => {
      spawnedCmd = cmd
      spawnedArgs = args
      return {
        unref: () => {},
      } as unknown as ChildProcess
    }) as unknown as typeof import('node:child_process').spawn

    const res = launchDesktopApp({
      url: 'http://127.0.0.1:4000/?token=abc',
      preferredMode: 'browser',
      spawnFn: mockSpawn,
    })

    expect(res.mode).toBe('browser')
    expect(spawnedArgs).toContain('http://127.0.0.1:4000/?token=abc')
  })
})
