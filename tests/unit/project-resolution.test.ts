import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { registerProject, setActiveProject } from '../../src/projects/registry.ts'
import { resolveProjectContext, ProjectRequiredError } from '../../src/projects/resolution.ts'

describe('Hybrid Project Resolution', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string
  let outsideDir: string

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-res-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-ra-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-rb-')))
    outsideDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-outside-')))

    writeFileSync(
      join(projectDirA, 'pluton.yaml'),
      `version: 1\nproject:\n  name: App Alpha\n  repository: .\n  default_branch: main\nships: {}\n`,
      'utf8',
    )

    writeFileSync(
      join(projectDirB, 'pluton.yaml'),
      `version: 1\nproject:\n  name: App Beta\n  repository: .\n  default_branch: dev\nships: {}\n`,
      'utf8',
    )
  })

  afterEach(() => {
    for (const dir of [tempHome, projectDirA, projectDirB, outsideDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Tolerated
      }
    }
  })

  it('resolves explicit project argument with Priority 1 regardless of CWD', () => {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)
    setActiveProject(entryA.id, tempHome)

    // Running inside project A with explicit --project pointing to project B
    const resolved = resolveProjectContext(projectDirA, entryB.id, tempHome)
    expect(resolved.id).toBe(entryB.id)
    expect(resolved.name).toBe('App Beta')
    expect(resolved.rootDir).toBe(projectDirB)
    expect(resolved.source).toBe('explicit')

    // Also supports slug or name in explicit argument
    const resolvedSlug = resolveProjectContext(projectDirA, entryB.slug, tempHome)
    expect(resolvedSlug.id).toBe(entryB.id)
    expect(resolvedSlug.source).toBe('explicit')
  })

  it('resolves CWD with Priority 2 when inside a registered project without explicit argument', () => {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)
    // Global active is Project B
    setActiveProject(entryB.id, tempHome)

    // In terminal inside Project A: CWD takes precedence over global active!
    const resolved = resolveProjectContext(projectDirA, undefined, tempHome)
    expect(resolved.id).toBe(entryA.id)
    expect(resolved.name).toBe('App Alpha')
    expect(resolved.rootDir).toBe(projectDirA)
    expect(resolved.source).toBe('cwd')
  })

  it('auto-registers and resolves CWD when inside a new Pluton project directory', () => {
    // Neither registered yet, CWD has pluton.yaml
    const resolved = resolveProjectContext(projectDirA, undefined, tempHome)
    expect(resolved.name).toBe('App Alpha')
    expect(resolved.rootDir).toBe(projectDirA)
    expect(resolved.source).toBe('cwd')
  })

  it('falls back to global active project with Priority 3 when outside project directories', () => {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)
    setActiveProject(entryB.id, tempHome)

    // CWD is outside any project
    const resolved = resolveProjectContext(outsideDir, undefined, tempHome)
    expect(resolved.id).toBe(entryB.id)
    expect(resolved.name).toBe('App Beta')
    expect(resolved.rootDir).toBe(projectDirB)
    expect(resolved.source).toBe('global-active')
  })

  it('throws ProjectRequiredError with Priority 4 when outside project directories and no active project exists', () => {
    // No projects registered and CWD is outside
    expect(() => {
      resolveProjectContext(outsideDir, undefined, tempHome)
    }).toThrowError(ProjectRequiredError)
  })
})
