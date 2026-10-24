import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * O5 doc-drift gate: `scripts/verify-docs.mjs` must pass on the repository and
 * must fail, naming the target, on a tree with a dead relative link. The repo
 * run is the real gate; the fixture proves the gate is not vacuous.
 */

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-docs.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const fixtures: string[] = []

afterAll(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runGate(root?: string): { status: number; stdout: string; stderr: string } {
  const args = root === undefined ? [SCRIPT] : [SCRIPT, '--root', root]
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number }
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-doc-links-'))
  fixtures.push(dir)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(dir, relative)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return dir
}

describe('documentation link gate', () => {
  it('passes on the repository (README + docs tree)', () => {
    const result = runGate(REPO_ROOT)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/doc links: \d+ file\(s\), \d+ link\(s\) checked, 0 broken/)
  })

  it('fails, names the dead target, and ignores external/anchor/code links', () => {
    const dir = makeFixture({
      'README.md': [
        '# Fixture',
        '',
        '[good](docs/present.md)',
        '[encoded](docs/with%20space.md)',
        '[external](https://example.com/missing)',
        '[anchor](#section)',
        '`[inline](docs/not-a-link.md)`',
        '',
        '```md',
        '[fenced](docs/not-a-link-either.md)',
        '```',
        '',
        '[bad](docs/missing.md)',
        '',
      ].join('\n'),
      'docs/present.md': '# Present\n',
      'docs/with space.md': '# Space\n',
    })
    const result = runGate(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('README.md:13: docs/missing.md')
    expect(result.stderr).not.toContain('docs/present.md')
    expect(result.stderr).not.toContain('example.com')
    expect(result.stderr).not.toContain('not-a-link')
    expect(result.stdout).toContain('1 broken')
  })

  it('checks nested docs files relative to their own directory', () => {
    const dir = makeFixture({
      'README.md': '# Fixture\n',
      'docs/guide/start.md': '[up](../architecture.md) [dead](./nope.md)\n',
      'docs/architecture.md': '# Architecture\n',
    })
    const result = runGate(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('docs/guide/start.md:1: ./nope.md')
    expect(result.stderr).not.toContain('architecture.md')
  })
})
