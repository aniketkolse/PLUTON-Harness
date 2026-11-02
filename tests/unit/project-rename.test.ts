import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { getProjectRegistry, registerProject } from '../../src/projects/registry.ts'
import { renameProjectEntry, renameProjectIdentity } from '../../src/projects/rename.ts'

/**
 * Project rename composition (PLUTON 4.1 Phase 4).
 *
 * A rename is three durable writes that must agree: `pluton.yaml`
 * (`project.name`), SQLite (`projects.name`), and the user registry
 * (`projects.json` entry name/slug). The filesystem path is identity and must
 * never change. Validation happens before any write so a rejected name cannot
 * leave a half-renamed project.
 */

const CONFIG_TEXT = `# Pluton project config
version: 1
project:
  # The operator-visible name; renaming must preserve this comment
  name: Old Project
  repository: .
  default_branch: main
ships: {}
`

describe('project rename', () => {
  let tempHome: string
  let projectDir: string

  beforeEach(() => {
    tempHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-rename-home-')))
    projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-rename-proj-')))
    writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG_TEXT, 'utf8')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('updates config, SQLite, and registry while preserving root and comments', () => {
    const registered = registerProject(projectDir, tempHome)

    const renamed = renameProjectIdentity(projectDir, '  Renamed Project  ', tempHome)

    expect(renamed.name).toBe('Renamed Project')
    expect(renamed.slug).toBe('renamed-project')
    expect(renamed.rootDir).toBe(registered.rootDir)

    const configText = readFileSync(join(projectDir, 'pluton.yaml'), 'utf8')
    expect(configText).toContain('# Pluton project config')
    expect(configText).toContain('# The operator-visible name; renaming must preserve this comment')
    expect(loadConfig(projectDir).config.project.name).toBe('Renamed Project')

    const { store, projectId } = bootstrapStore(loadConfig(projectDir))
    try {
      const project = store.getProject(projectId)
      expect(project?.name).toBe('Renamed Project')
      expect(project?.rootPath).toBe(registered.rootDir)
    } finally {
      store.close()
    }

    const entry = getProjectRegistry(tempHome).projects[registered.id]
    expect(entry?.name).toBe('Renamed Project')
    expect(entry?.slug).toBe('renamed-project')
    expect(entry?.rootDir).toBe(registered.rootDir)
  })

  it('rejects a blank name before writing anything', () => {
    const registered = registerProject(projectDir, tempHome)
    const configBefore = readFileSync(join(projectDir, 'pluton.yaml'), 'utf8')

    expect(() => renameProjectIdentity(projectDir, '   ', tempHome)).toThrow(/name/i)

    expect(readFileSync(join(projectDir, 'pluton.yaml'), 'utf8')).toBe(configBefore)
    expect(getProjectRegistry(tempHome).projects[registered.id]?.name).toBe(registered.name)

    const { store, projectId } = bootstrapStore(loadConfig(projectDir))
    try {
      expect(store.getProject(projectId)?.name).toBe(registered.name)
    } finally {
      store.close()
    }
  })

  it('renames only the registry entry without touching the project path', () => {
    const registered = registerProject(projectDir, tempHome)

    const renamed = renameProjectEntry(registered.id, 'Registry Only', tempHome)

    expect(renamed.id).toBe(registered.id)
    expect(renamed.name).toBe('Registry Only')
    expect(renamed.slug).toBe('registry-only')
    expect(renamed.rootDir).toBe(registered.rootDir)
    expect(renamed.configPath).toBe(registered.configPath)
    expect(getProjectRegistry(tempHome).projects[registered.id]?.name).toBe('Registry Only')
  })
})
