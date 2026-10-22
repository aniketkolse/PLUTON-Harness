import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { runInit, type TeamTemplate } from '../../src/cli/commands/init.ts'
import { findManager, loadConfig, validateConfig } from '../../src/config/load.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Team templates are product surface: `pluton init --team <t>` must always
 * produce a schema-valid, OpenCode-only config. This suite existed after a real
 * bug: bugfix.yaml had `network_policy` nested under `sandbox:` while the
 * schema is strict and expects it under `runtime:` — validation caught it at
 * init time (fail-closed, nothing written) but no test guarded the templates.
 */

const TEAMS: readonly TeamTemplate[] = ['full-stack', 'bugfix', 'repository-analysis']
const tmpDirs: string[] = []

function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pluton-init-${name}-`))
  tmpDirs.push(dir)
  return dir
}

function templateText(team: TeamTemplate): string {
  const url = new URL(`../../templates/teams/${team}.yaml`, import.meta.url)
  return readFileSync(url, 'utf8').replaceAll('__PROJECT_NAME__', 'tmpl').replaceAll('__DEFAULT_BRANCH__', 'main')
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('team templates', () => {
  it.each(TEAMS)('%s validates against the strict config schema', (team) => {
    const root = tmpDir(team)
    const loaded = validateConfig(parseYaml(templateText(team)), root, join(root, 'pluton.yaml'))
    expect(Object.keys(loaded.config.muses).length).toBeGreaterThan(0)
    expect(findManager(loaded.config)).not.toBeNull()
  })

  it.each(TEAMS)('%s uses the supported OpenCode engine for every Muse', (team) => {
    const root = tmpDir(`${team}-engine`)
    const loaded = validateConfig(parseYaml(templateText(team)), root, join(root, 'pluton.yaml'))
    const muses = Object.values(loaded.config.muses)
    expect(muses.length).toBeGreaterThan(0)
    for (const muse of muses) {
      expect(muse.engine, `template ${team} muse ${muse.display_name}`).toBe('opencode')
      expect(muse.model).toMatch(/^opencode\//)
    }
  })
})

describe('runInit', () => {
  it('writes a loadable config and never overwrites an existing one', async () => {
    const dir = tmpDir('write')
    const git = await run(['git', 'init', '--quiet', dir], { timeoutMs: 30_000 })
    expect(git.exitCode).toBe(0)

    const result = await runInit({ cwd: dir, team: 'bugfix' })
    expect(result.createdFiles).toContain('pluton.yaml')
    const loaded = loadConfig(dir)
    expect(loaded.config.project.name).toBeTruthy()
    expect(findManager(loaded.config)).not.toBeNull()

    await expect(runInit({ cwd: dir, team: 'bugfix' })).rejects.toThrow(/already exists/)
  }, 60_000)

  it('gitignores the workspaces attic (archived checkouts enter the repo tree)', async () => {
    const dir = tmpDir('attic')
    const git = await run(['git', 'init', '--quiet', dir], { timeoutMs: 30_000 })
    expect(git.exitCode).toBe(0)

    await runInit({ cwd: dir, team: 'full-stack' })

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.pluton/workspaces-attic/')
  }, 60_000)
})
