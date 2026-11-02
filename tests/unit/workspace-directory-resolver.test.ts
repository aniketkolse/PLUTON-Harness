import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspaceDir } from '../../src/server/routes.ts'

describe('resolveWorkspaceDir', () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(() => {
    rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-dir-res-root-')))
    outsideDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-dir-res-out-')))
    mkdirSync(join(rootDir, 'src', 'server'), { recursive: true })
    writeFileSync(join(rootDir, 'src', 'server', 'routes.ts'), 'export {}')
    writeFileSync(join(rootDir, 'sample.txt'), 'hello')
  })

  afterEach(() => {
    try { rmSync(rootDir, { recursive: true, force: true }) } catch {}
    try { rmSync(outsideDir, { recursive: true, force: true }) } catch {}
  })

  it('resolves root directory when target is empty or dot', () => {
    const resEmpty = resolveWorkspaceDir(rootDir, '')
    expect(resEmpty.ok).toBe(true)
    if (resEmpty.ok) {
      expect(resEmpty.canonical).toBe(rootDir)
      expect(resEmpty.canonicalRel).toBe('')
    }

    const resDot = resolveWorkspaceDir(rootDir, '.')
    expect(resDot.ok).toBe(true)
    if (resDot.ok) {
      expect(resDot.canonical).toBe(rootDir)
      expect(resDot.canonicalRel).toBe('')
    }
  })

  it('resolves valid nested subdirectory', () => {
    const res = resolveWorkspaceDir(rootDir, 'src/server')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.canonical).toBe(join(rootDir, 'src', 'server'))
      expect(res.canonicalRel.replace(/\\/g, '/')).toBe('src/server')
    }
  })

  it('rejects lexical traversal outside workspace', () => {
    const res = resolveWorkspaceDir(rootDir, '../outside')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.error).toContain('outside workspace')
    }
  })

  it('rejects protected workspace segments', () => {
    mkdirSync(join(rootDir, '.git'), { recursive: true })
    const resGit = resolveWorkspaceDir(rootDir, '.git')
    expect(resGit.ok).toBe(false)
    if (!resGit.ok) {
      expect(resGit.status).toBe(403)
      expect(resGit.error).toContain('protected workspace path')
    }

    mkdirSync(join(rootDir, 'node_modules'), { recursive: true })
    const resNodeModules = resolveWorkspaceDir(rootDir, 'node_modules')
    expect(resNodeModules.ok).toBe(false)
    if (!resNodeModules.ok) {
      expect(resNodeModules.status).toBe(403)
    }
  })

  it('rejects symlinks that point outside workspace', () => {
    const linkedOutside = join(rootDir, 'linked-outside')
    try {
      symlinkSync(outsideDir, linkedOutside, 'junction')
    } catch {
      // Junctions or symlinks might require privileges on older Windows versions
      return
    }
    const res = resolveWorkspaceDir(rootDir, 'linked-outside')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.error).toContain('outside workspace')
    }
  })

  it('rejects targets that are files instead of directories', () => {
    const res = resolveWorkspaceDir(rootDir, 'sample.txt')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(404)
    }
  })

  it('returns 404 for non-existent directories', () => {
    const res = resolveWorkspaceDir(rootDir, 'does/not/exist')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(404)
    }
  })
})
