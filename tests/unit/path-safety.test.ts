import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizePathWithin,
  protectedWorkspaceSegment,
  reservedPathSegment,
  shortNameAliasSegment,
  unstableWindowsSegment,
} from '../../src/util/path-safety.ts'

/**
 * Platform path identity. The lexical spelling of a path is not the path the
 * host opens: Win32 folds case and strips trailing dots/spaces, both Windows
 * and macOS resolve case variants, 8.3 names alias long directories, and a
 * junction/symlink can leave the workspace entirely.
 */

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const RESERVED = new Set(['.git', '.pluton'])

describe('path segment normalization', () => {
  it('recognizes case variants on win32 and darwin but not linux', () => {
    expect(protectedWorkspaceSegment('.GIT/config', 'win32')).toBe('.GIT')
    expect(protectedWorkspaceSegment('.GIT/config', 'darwin')).toBe('.GIT')
    expect(protectedWorkspaceSegment('.GIT/config', 'linux')).toBeNull()
    expect(protectedWorkspaceSegment('.git/config', 'linux')).toBe('.git')
  })

  it('strips Win32 trailing dots/spaces before comparing', () => {
    expect(protectedWorkspaceSegment('.git./config', 'win32')).toBe('.git.')
    expect(protectedWorkspaceSegment('.pluton /state', 'win32')).toBe('.pluton ')
    expect(unstableWindowsSegment('.git./config', 'win32')).toBe('.git.')
    expect(unstableWindowsSegment('.git./config', 'linux')).toBeNull()
  })

  it('flags Win32 8.3 aliases instead of guessing their target', () => {
    expect(shortNameAliasSegment('PLUTON~1/state', 'win32')).toBe('PLUTON~1')
    expect(shortNameAliasSegment('src/app.ts', 'win32')).toBeNull()
    expect(shortNameAliasSegment('PLUTON~1/state', 'linux')).toBeNull()
  })

  it('applies the same reserved-segment rules to engine control directories', () => {
    expect(reservedPathSegment('.GIT/hooks/pre-commit', RESERVED, 'win32')).toBe('.GIT')
    expect(reservedPathSegment('.git./hooks/pre-commit', RESERVED, 'win32')).toBe('.git.')
    expect(reservedPathSegment('.git/hooks/pre-commit', RESERVED, 'linux')).toBe('.git')
    expect(reservedPathSegment('.GIT/hooks/pre-commit', RESERVED, 'linux')).toBeNull()
  })
})

describe('canonicalizePathWithin', () => {
  it('accepts a contained relative path and returns a canonical absolute form', () => {
    const root = tmp('pluton-path-root-')
    const result = canonicalizePathWithin(root, join('src', 'new-file.ts'), process.platform)
    expect(result.ok).toBe(true)
    expect(result.path).toBeTruthy()
    expect(result.root).toBeTruthy()
  })

  it('rejects lexical traversal', () => {
    const root = tmp('pluton-path-root-')
    const result = canonicalizePathWithin(root, join('..', 'outside.txt'), process.platform)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('outside')
  })

  it('rejects an absolute path outside the root', () => {
    const root = tmp('pluton-path-root-')
    const outside = tmp('pluton-path-outside-')
    const result = canonicalizePathWithin(root, join(outside, 'secret.txt'), process.platform)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('outside')
  })

  it('rejects an existing symlink/junction that escapes the root', () => {
    const root = tmp('pluton-path-root-')
    const outside = tmp('pluton-path-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    try {
      symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // Creating links is not permitted in every CI sandbox. The lexical
      // checks above still run; this case is covered where links are allowed.
      return
    }
    const result = canonicalizePathWithin(root, join('link', 'secret.txt'), process.platform)
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('outside')
  })

  it('rejects Win32-unstable and 8.3 spellings before touching the filesystem', () => {
    const root = tmp('pluton-path-root-')
    expect(canonicalizePathWithin(root, '.git./config', 'win32').problem).toBe('unstable-segment')
    expect(canonicalizePathWithin(root, 'PLUTON~1/state', 'win32').problem).toBe('short-name-alias')
    expect(canonicalizePathWithin(root, '.GIT/config', 'win32').ok).toBe(true)
  })
})
