import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldOpenChat } from '../../src/cli/main.ts'

describe('shouldOpenChat pure gate', () => {
  it('returns true only when both isTty and hasProject are true', () => {
    expect(shouldOpenChat({ isTty: true, hasProject: true })).toBe(true)
    expect(shouldOpenChat({ isTty: false, hasProject: true })).toBe(false)
    expect(shouldOpenChat({ isTty: true, hasProject: false })).toBe(false)
    expect(shouldOpenChat({ isTty: false, hasProject: false })).toBe(false)
  })
})

describe('bare pluton CLI execution', () => {
  it('prints help on stdout and exits 0 when invoked non-TTY without args', () => {
    const binPath = join(process.cwd(), 'bin', 'pluton.js')
    const res = spawnSync(process.execPath, [binPath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Pluton-Harness')
    expect(res.stdout).toContain('Usage: pluton')
    expect(res.stdout).toContain('chat [options] [ship]')
  })
})
