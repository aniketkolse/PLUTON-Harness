import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { describeWorkspace, resolveWorkspaceRoot } from '../../src/server/workspace.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-workspace-unit-')))
  tmpDirs.push(dir)
  return dir
}

describe('resolveWorkspaceRoot', () => {
  it('rejects a blank or relative path', () => {
    expect(() => resolveWorkspaceRoot('')).toThrow(ValidationError)
    expect(() => resolveWorkspaceRoot('   ')).toThrow(/workspace path is required/)
    expect(() => resolveWorkspaceRoot('relative/dir')).toThrow(/workspace path must be absolute/)
  })

  it('rejects a missing path', () => {
    const dir = tempDir()
    expect(() => resolveWorkspaceRoot(join(dir, 'missing'))).toThrow(/workspace folder does not exist/)
  })

  it('rejects a file', () => {
    const dir = tempDir()
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x', 'utf8')
    expect(() => resolveWorkspaceRoot(file)).toThrow(/workspace path is not a directory/)
  })

  it('returns the canonical absolute directory', () => {
    const dir = tempDir()
    const nested = join(dir, 'nested')
    mkdirSync(nested)
    expect(resolveWorkspaceRoot(nested)).toBe(resolve(nested))
    expect(resolveWorkspaceRoot(`  ${nested}  `)).toBe(resolve(nested))
  })
})

describe('describeWorkspace', () => {
  it('uses the directory basename and marks session overrides', () => {
    const dir = tempDir()
    expect(describeWorkspace(dir, dir)).toEqual({
      rootDir: dir,
      name: dir.split(/[\\/]/).filter(Boolean).at(-1),
      sessionScoped: false,
    })

    const other = join(dir, 'other')
    expect(describeWorkspace(other, dir)).toEqual({
      rootDir: other,
      name: 'other',
      sessionScoped: true,
    })
  })
})
