import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { projectList, projectSwitch, projectCurrent, projectAdd, projectRemove, projectRename } from '../../src/cli/commands/project.ts'

describe('CLI Project Commands', () => {
  let tempHome: string
  let projectDirA: string
  let projectDirB: string

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-home-cli-')))
    projectDirA = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-ca-')))
    projectDirB = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-proj-cb-')))

    writeFileSync(
      join(projectDirA, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Cli Alpha\n  repository: .\n  default_branch: main\nships: {}\n`,
      'utf8',
    )

    writeFileSync(
      join(projectDirB, 'pluton.yaml'),
      `version: 1\nproject:\n  name: Cli Beta\n  repository: .\n  default_branch: develop\nships: {}\n`,
      'utf8',
    )
  })

  afterEach(() => {
    for (const dir of [tempHome, projectDirA, projectDirB]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Tolerated
      }
    }
  })

  it('adds projects and lists them with active and CWD markers', () => {
    // 1. Add project A
    const addedA = projectAdd(projectDirA, tempHome)
    expect(addedA.name).toBe('Cli Alpha')
    expect(addedA.rootDir).toBe(projectDirA)

    // 2. Add project B
    const addedB = projectAdd(projectDirB, tempHome)
    expect(addedB.name).toBe('Cli Beta')
    expect(addedB.rootDir).toBe(projectDirB)

    // 3. List projects when CWD is projectDirB
    const list = projectList(projectDirB, { json: true }, tempHome)
    expect(list.projects).toHaveLength(2)

    const itemA = list.projects.find((p) => p.name === 'Cli Alpha')
    const itemB = list.projects.find((p) => p.name === 'Cli Beta')
    expect(itemA).toBeDefined()
    expect(itemB).toBeDefined()

    // B is CWD
    expect(itemB?.isCwd).toBe(true)
    expect(itemA?.isCwd).toBe(false)
  })

  it('switches the global active project', () => {
    projectAdd(projectDirA, tempHome)
    const addedB = projectAdd(projectDirB, tempHome)

    // Switch to B
    const switched = projectSwitch(addedB.id, tempHome)
    expect(switched.id).toBe(addedB.id)

    // Check current when outside
    const current = projectCurrent(tempHome, undefined, tempHome)
    expect(current.id).toBe(addedB.id)
    expect(current.source).toBe('global-active')
  })

  it('removes project from registry', () => {
    const addedA = projectAdd(projectDirA, tempHome)
    projectAdd(projectDirB, tempHome)

    const res = projectRemove(addedA.id, tempHome)
    expect(res.removed).toBe(true)

    const list = projectList(projectDirB, { json: true }, tempHome)
    expect(list.projects).toHaveLength(1)
    expect(list.projects[0]?.name).toBe('Cli Beta')
  })

  it('renames a registered project without moving its directory', () => {
    const addedA = projectAdd(projectDirA, tempHome)

    const renamed = projectRename(addedA.id, 'Renamed Alpha', tempHome)
    expect(renamed.name).toBe('Renamed Alpha')
    expect(renamed.slug).toBe('renamed-alpha')
    expect(renamed.rootDir).toBe(projectDirA)

    const current = projectCurrent(projectDirA, undefined, tempHome)
    expect(current.name).toBe('Renamed Alpha')
  })
})
