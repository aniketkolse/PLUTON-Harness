import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWorkspaceFiles } from '../../src/server/routes.ts'

describe('searchWorkspaceFiles', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-search-test-')))
    // Create folders and files
    mkdirSync(join(rootDir, 'src', 'server', 'views'), { recursive: true })
    mkdirSync(join(rootDir, 'src', 'client', 'components'), { recursive: true })
    mkdirSync(join(rootDir, 'tests', 'integration'), { recursive: true })
    mkdirSync(join(rootDir, '.git'), { recursive: true })
    mkdirSync(join(rootDir, 'node_modules', 'dep'), { recursive: true })

    writeFileSync(join(rootDir, 'src', 'server', 'routes.ts'), 'export {}')
    writeFileSync(join(rootDir, 'src', 'server', 'activity.ts'), 'export {}')
    writeFileSync(join(rootDir, 'src', 'client', 'components', 'Button.tsx'), 'export const Button = null')
    writeFileSync(join(rootDir, 'tests', 'integration', 'server-routes.test.ts'), 'export {}')
    writeFileSync(join(rootDir, '.git', 'config'), 'git config')
    writeFileSync(join(rootDir, 'node_modules', 'dep', 'index.js'), 'export {}')
    writeFileSync(join(rootDir, '.env'), 'SECRET=123')
    writeFileSync(join(rootDir, '.env.local'), 'SECRET=456')
  })

  afterEach(() => {
    try { rmSync(rootDir, { recursive: true, force: true }) } catch {}
  })

  it('finds files matching substring query in name or relative path', () => {
    const res = searchWorkspaceFiles(rootDir, 'routes', 10)
    expect(res.matches.length).toBeGreaterThanOrEqual(2)
    const paths = res.matches.map((m) => m.path.replace(/\\/g, '/'))
    expect(paths).toContain('src/server/routes.ts')
    expect(paths).toContain('tests/integration/server-routes.test.ts')
    expect(res.truncated).toBe(false)
  })

  it('matches directory names in search', () => {
    const res = searchWorkspaceFiles(rootDir, 'views', 10)
    const dirMatch = res.matches.find((m) => m.name === 'views')
    expect(dirMatch).toBeDefined()
    expect(dirMatch?.type).toBe('dir')
  })

  it('ignores protected directories and secret files', () => {
    const resGit = searchWorkspaceFiles(rootDir, 'config', 10)
    const gitPaths = resGit.matches.map((m) => m.path)
    expect(gitPaths).not.toContain('.git/config')

    const resModules = searchWorkspaceFiles(rootDir, 'dep', 10)
    expect(resModules.matches).toHaveLength(0)

    const resSecret = searchWorkspaceFiles(rootDir, '.env', 10)
    expect(resSecret.matches).toHaveLength(0)
  })

  it('caps matches at limit and sets truncated flag', () => {
    mkdirSync(join(rootDir, 'generated'), { recursive: true })
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(rootDir, 'generated', `gen-${i}.txt`), `Content ${i}`)
    }
    const res = searchWorkspaceFiles(rootDir, 'gen-', 5)
    expect(res.matches).toHaveLength(5)
    expect(res.truncated).toBe(true)
  })
})
