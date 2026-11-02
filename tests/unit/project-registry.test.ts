import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  getProjectRegistry,
  registerProject,
  unregisterProject,
  setActiveProject,
  getActiveProjectId,
  type ProjectRegistry,
} from '../../src/projects/registry.ts'

describe('Project Registry', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-test-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-a-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-b-')))

    // Setup minimal pluton.yaml in project A
    writeFileSync(
      join(projectDirA, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Project Alpha\n  repository: .\n  default_branch: main\nships: {}\n`,
      'utf8',
    )

    // Setup minimal pluton.yaml in project B
    writeFileSync(
      join(projectDirB, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Project Beta\n  repository: .\n  default_branch: develop\nships: {}\n`,
      'utf8',
    )
  })

  afterEach(() => {
    for (const dir of [tempHome, projectDirA, projectDirB]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows file locks cleanup tolerance
      }
    }
  })

  it('initializes empty registry when projects.json does not exist', () => {
    const reg = getProjectRegistry(tempHome)
    expect(reg.version).toBe(1)
    expect(reg.activeProjectId).toBeNull()
    expect(reg.projects).toEqual({})
  })

  it('registers projects atomically and mirrors active project pointer', () => {
    const entryA = registerProject(projectDirA, tempHome)
    expect(entryA.name).toBe('Project Alpha')
    expect(entryA.rootDir).toBe(projectDirA)
    expect(entryA.defaultBranch).toBe('main')
    expect(entryA.id).toMatch(/^project_/)

    // Registry persists to disk
    const reg1 = getProjectRegistry(tempHome)
    expect(reg1.projects[entryA.id]).toBeDefined()
    expect(reg1.projects[entryA.id]?.name).toBe('Project Alpha')

    // First registered project automatically becomes active
    expect(reg1.activeProjectId).toBe(entryA.id)
    expect(getActiveProjectId(tempHome)).toBe(entryA.id)

    // Register second project
    const entryB = registerProject(projectDirB, tempHome)
    expect(entryB.name).toBe('Project Beta')
    expect(entryB.rootDir).toBe(projectDirB)

    const reg2 = getProjectRegistry(tempHome)
    expect(Object.keys(reg2.projects)).toHaveLength(2)
    // Registering second does not override active unless explicitly set
    expect(reg2.activeProjectId).toBe(entryA.id)

    // Explicitly switch active
    setActiveProject(entryB.id, tempHome)
    expect(getActiveProjectId(tempHome)).toBe(entryB.id)

    // active-project file exists and matches
    const activeFile = join(tempHome, 'active-project')
    expect(existsSync(activeFile)).toBe(true)
    expect(readFileSync(activeFile, 'utf8').trim()).toBe(entryB.id)
  })

  it('allows switching by slug or project name', () => {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)

    // Switch by slug
    const switched = setActiveProject(entryB.slug, tempHome)
    expect(switched.id).toBe(entryB.id)
    expect(getActiveProjectId(tempHome)).toBe(entryB.id)
  })

  it('unregisters project cleanly and reassigns active pointer if active project is removed', () => {
    const entryA = registerProject(projectDirA, tempHome)
    const entryB = registerProject(projectDirB, tempHome)
    setActiveProject(entryA.id, tempHome)

    const removed = unregisterProject(entryA.id, tempHome)
    expect(removed).toBe(true)

    const reg = getProjectRegistry(tempHome)
    expect(reg.projects[entryA.id]).toBeUndefined()
    expect(reg.projects[entryB.id]).toBeDefined()
    // Switched to remaining project
    expect(reg.activeProjectId).toBe(entryB.id)
  })
})
