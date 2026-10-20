import { describe, expect, it } from 'vitest'
import {
  buildLeakPatterns,
  evaluatePublication,
  findBrokenRelativeLinks,
  findContentLeaks,
  findForbiddenPackFiles,
  formatErrorDetail,
  parseChangedFiles,
  parsePackManifest,
  renderResultLine,
  sameDepMap,
  scanTextForLeaks,
  summarize,
} from '../../scripts/lib/release-gate.mjs'
import type { GateResult } from '../../scripts/lib/release-gate.mjs'

/**
 * Regression tests for the release-gate helper library. Each case pins a
 * behavior the gate relies on to classify results honestly (PASS / FAIL /
 * BLOCKED / NOT TESTED) and to avoid false negatives on package content.
 */

describe('parsePackManifest', () => {
  it('extracts the file list from npm output surrounded by lifecycle noise', () => {
    const raw = [
      '> pluton-harness@0.1.0 prepack',
      '> npm run build',
      '',
      JSON.stringify([{ name: 'pluton-harness', files: [{ path: 'package.json' }, { path: 'dist/cli/main.js' }] }]),
      'npm notice some trailing notice',
    ].join('\n')
    expect(parsePackManifest(raw).files).toEqual(['package.json', 'dist/cli/main.js'])
  })

  it('throws when no JSON manifest is present', () => {
    expect(() => parsePackManifest('npm error something went wrong')).toThrow(/no JSON manifest/)
  })

  it('throws on an unexpected manifest shape', () => {
    expect(() => parsePackManifest('[]')).toThrow(/unexpected npm pack manifest shape/)
    expect(() => parsePackManifest('[{"name":"x"}]')).toThrow(/unexpected npm pack manifest shape/)
  })
})

describe('parseChangedFiles', () => {
  it('keeps the first character of the first path in untrimmed porcelain output', () => {
    const raw = ' M README.md\n M docs/RELEASE.md\n?? new file.txt\n'
    expect(parseChangedFiles(raw)).toEqual(['README.md', 'docs/RELEASE.md', 'new file.txt'])
  })

  it('tolerates CRLF output, staged entries and rename lines', () => {
    expect(parseChangedFiles('M  a.txt\r\nR  old.txt -> new.txt\r\n')).toEqual(['a.txt', 'old.txt -> new.txt'])
  })

  it('returns an empty list for a clean tree', () => {
    expect(parseChangedFiles('')).toEqual([])
    expect(parseChangedFiles('\n')).toEqual([])
  })
})

describe('formatErrorDetail', () => {
  it('includes stderr so npm errors are not swallowed', () => {
    const err = { stdout: 'partial stdout\n', stderr: 'npm error code ELIFECYCLE\nnpm error failed' }
    const detail = formatErrorDetail(err)
    expect(detail).toContain('partial stdout')
    expect(detail).toContain('npm error failed')
  })

  it('falls back to the error message and bounds the line count', () => {
    expect(formatErrorDetail(new Error('boom'))).toBe('boom')
    const many = { stdout: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') }
    const detail = formatErrorDetail(many, 3)
    expect(detail.split(' | ')).toHaveLength(3)
    expect(detail).toContain('line 19')
  })
})

describe('findForbiddenPackFiles', () => {
  it('flags tests, local state, databases, logs and tarballs', () => {
    const flagged = findForbiddenPackFiles([
      'tests/unit/x.test.ts',
      'test/foo.js',
      'coverage/lcov.info',
      '.pluton/run/instance.json',
      'node_modules/dep/index.js',
      '.env',
      '.env.local',
      'data/pluton.sqlite',
      'data/pluton.db',
      'server.log',
      'pluton-harness-0.1.0.tgz',
    ])
    expect(flagged).toHaveLength(11)
  })

  it('keeps legitimate runtime assets', () => {
    expect(
      findForbiddenPackFiles([
        'package.json',
        'bin/pluton.js',
        'dist/cli/main.js',
        'dist/cli/main.js.map',
        'docker/worker/Dockerfile',
        'templates/teams/full-stack.yaml',
        'README.md',
        'THIRD_PARTY_NOTICES.md',
      ]),
    ).toEqual([])
  })
})

describe('leak scanning', () => {
  const patterns = buildLeakPatterns({
    homeDir: 'Y:\\Pluton',
    repoRoot: 'Y:\\Pluton',
    platform: 'win32',
  })

  it('finds host-local paths and credential-looking strings', () => {
    expect(scanTextForLeaks('path = "C:\\Users\\Asus\\Documents\\notes.txt"', patterns)).toContain(
      'Windows user-profile path',
    )
    expect(scanTextForLeaks('open /Users/alice/projects/thing', patterns)).toContain('macOS user-home path')
    expect(scanTextForLeaks('built in Y:\\Pluton\\dist', patterns)).toContain('local checkout path')
    expect(scanTextForLeaks(`token = 'sk-${'a'.repeat(32)}'`, patterns)).toContain('OpenAI-style API key')
    expect(scanTextForLeaks(`ghp_${'A'.repeat(36)}`, patterns)).toContain('GitHub token')
    expect(scanTextForLeaks('AKIAABCDEFGHIJKLMNOP', patterns)).toContain('AWS access key id')
    expect(scanTextForLeaks('-----BEGIN RSA PRIVATE KEY-----', patterns)).toContain('private key block')
  })

  it('also matches source-escaped path separators in shipped code', () => {
    const escapedPatterns = buildLeakPatterns({
      homeDir: 'C:\\Users\\Asus',
      repoRoot: 'Y:\\Pluton',
      platform: 'win32',
    })
    expect(scanTextForLeaks(String.raw`const p = 'C:\\Users\\Asus\\x'`, escapedPatterns)).toContain(
      'Windows user-profile path',
    )
    expect(scanTextForLeaks(String.raw`const h = 'C:\\Users\\Asus\\AppData'`, escapedPatterns)).toContain(
      'local home directory',
    )
    expect(scanTextForLeaks(String.raw`// built in Y:\\Pluton\\dist`, escapedPatterns)).toContain(
      'local checkout path',
    )
    expect(scanTextForLeaks(String.raw`const h = 'C:/Users/Asus/AppData'`, escapedPatterns)).toContain(
      'local home directory',
    )
  })

  it('does not flag documentation placeholders or clean text', () => {
    expect(scanTextForLeaks('install to C:\\Users\\you\\tools or /Users/you/pluton', patterns)).toEqual([])
    expect(scanTextForLeaks('const x = 1 // plain code, container path /home/pluton', patterns)).toEqual([])
    // OS-default profiles are legitimate runtime fallbacks, not developer leaks.
    expect(scanTextForLeaks("env.USERPROFILE ?? 'C:\\\\Users\\\\Default'", patterns)).toEqual([])
    expect(scanTextForLeaks('C:\\Users\\Public\\Desktop', patterns)).toEqual([])
  })

  it('findContentLeaks reports per-file findings and skips unreadable files', () => {
    const findings = findContentLeaks({
      files: ['dist/a.js', 'dist/missing.js'],
      readFile: (f) => {
        if (f === 'dist/missing.js') throw new Error('ENOENT')
        return 'const home = "/Users/alice/proj"'
      },
      patterns,
    })
    expect(findings).toEqual([{ file: 'dist/a.js', label: 'macOS user-home path' }])
  })
})

describe('findBrokenRelativeLinks', () => {
  it('checks repository-relative targets including fragments and images', () => {
    const text = [
      '[gate](docs/RELEASE.md)',
      '[staged](docs/RELEASE.md#current-owner-decisions)',
      '![logo](assets/logo.png)',
      '[web](https://example.com/nope)',
      '[mail](mailto:someone@example.com)',
      '[anchor](#top)',
      '[missing](docs/DOES-NOT-EXIST.md)',
    ].join('\n')
    const missing = findBrokenRelativeLinks(text, (t) => t !== 'docs/DOES-NOT-EXIST.md' && t !== 'assets/logo.png')
    expect(missing).toEqual(['assets/logo.png', 'docs/DOES-NOT-EXIST.md'])
  })

  it('returns nothing when every target exists', () => {
    expect(findBrokenRelativeLinks('[a](a.md) [b](b/c.md)', () => true)).toEqual([])
  })
})

describe('sameDepMap', () => {
  it('compares dependency maps order-insensitively', () => {
    expect(sameDepMap({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true)
    expect(sameDepMap({ a: '1' }, { a: '2' })).toBe(false)
    expect(sameDepMap(undefined, {})).toBe(true)
  })
})

describe('summarize', () => {
  const r = (status: GateResult['status']): GateResult => ({ label: status, status })

  it('reports technical PASS with exit 0 when nothing failed', () => {
    const s = summarize([r('pass'), r('pass'), r('not-tested'), r('blocked')])
    expect(s).toMatchObject({ total: 4, passed: 2, failed: 0, notTested: 1, blocked: 1, technical: 'PASS', exitCode: 0 })
  })

  it('reports technical FAIL with exit 1 when any check failed', () => {
    const s = summarize([r('pass'), r('fail')])
    expect(s).toMatchObject({ failed: 1, technical: 'FAIL', exitCode: 1 })
  })
})

describe('renderResultLine', () => {
  it('renders every status distinctly and appends remediation', () => {
    expect(renderResultLine({ label: 'a', status: 'pass', detail: 'ok' })).toBe('[PASS] a — ok')
    expect(renderResultLine({ label: 'b', status: 'not-tested', detail: 'no network', fix: 'run online' })).toBe(
      '[NOT TESTED] b — no network\n        fix: run online',
    )
    expect(renderResultLine({ label: 'c', status: 'blocked', detail: 'owner decision' })).toBe(
      '[BLOCKED] c — owner decision',
    )
    expect(renderResultLine({ label: 'd', status: 'fail' })).toBe('[FAIL] d')
  })
})

describe('evaluatePublication', () => {
  it('grants eligibility only when validation is green, no blockers remain and no dirty override is active', () => {
    const decision = evaluatePublication({ failed: 0, blocked: 0, dirtyOverride: false })
    expect(decision.eligible).toBe(true)
    expect(decision.reason).toContain('human approval')
  })

  it('blocks eligibility when a technical check failed (dirty tree without --allow-dirty)', () => {
    const decision = evaluatePublication({ failed: 1, blocked: 0, dirtyOverride: false })
    expect(decision.eligible).toBe(false)
    expect(decision.reason).toContain('1 technical check(s) failed')
  })

  it('blocks eligibility while the dirty-tree override is active', () => {
    const decision = evaluatePublication({ failed: 0, blocked: 0, dirtyOverride: true })
    expect(decision.eligible).toBe(false)
    expect(decision.reason).toContain('--allow-dirty override in effect')
    expect(decision.reason).toContain('re-run on the committed release tree')
  })

  it('keeps owner blockers blocking eligibility with and without the dirty override', () => {
    const ownersOnly = evaluatePublication({ failed: 0, blocked: 2, dirtyOverride: false })
    expect(ownersOnly.eligible).toBe(false)
    expect(ownersOnly.reason).toContain('2 owner/infrastructure blocker(s) unresolved')

    const combined = evaluatePublication({ failed: 0, blocked: 2, dirtyOverride: true })
    expect(combined.eligible).toBe(false)
    expect(combined.reason).toContain('--allow-dirty override in effect')
    expect(combined.reason).toContain('2 owner/infrastructure blocker(s) unresolved')
  })

  it('never reports eligibility while any condition is unmet and names every active condition', () => {
    for (const failed of [0, 1]) {
      for (const blocked of [0, 2]) {
        for (const dirtyOverride of [false, true]) {
          const decision = evaluatePublication({ failed, blocked, dirtyOverride })
          expect(decision.eligible).toBe(failed === 0 && blocked === 0 && !dirtyOverride)
          if (failed > 0) expect(decision.reason).toContain('technical check(s) failed')
          if (blocked > 0) expect(decision.reason).toContain('owner/infrastructure blocker(s)')
          if (dirtyOverride) expect(decision.reason).toContain('--allow-dirty override in effect')
        }
      }
    }
  })

  it('defaults to eligibility when nothing is known to be wrong (previous behavior preserved)', () => {
    const decision = evaluatePublication({})
    expect(decision.eligible).toBe(true)
  })
})
