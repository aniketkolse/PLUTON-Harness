import { describe, expect, it } from 'vitest'
import { matchProtectedPath } from '../../src/workspace/protected-paths.ts'

/**
 * Protected-path matcher (integration gate): patterns are repo-relative,
 * case-sensitive, and matched verbatim against repo-relative paths.
 */

describe('matchProtectedPath', () => {
  it('matches an exact file path', () => {
    expect(matchProtectedPath('package.json', 'package.json')).toBe(true)
    expect(matchProtectedPath('package.json', 'package-lock.json')).toBe(false)
    expect(matchProtectedPath('package.json', 'src/package.json')).toBe(false)
  })

  it('treats a plain path as an exact match or a directory prefix', () => {
    expect(matchProtectedPath('src/store', 'src/store')).toBe(true)
    expect(matchProtectedPath('src/store', 'src/store/store.ts')).toBe(true)
    expect(matchProtectedPath('src/store', 'src/store/nested/deep.ts')).toBe(true)
    // Prefix must end on a path boundary: no storefront-style false positives.
    expect(matchProtectedPath('src/store', 'src/storefront/x.ts')).toBe(false)
    expect(matchProtectedPath('src/store', 'src/state/x.ts')).toBe(false)
  })

  it('treats a trailing slash as a directory prefix only', () => {
    expect(matchProtectedPath('secrets/', 'secrets/token.txt')).toBe(true)
    expect(matchProtectedPath('secrets/', 'secrets/nested/token.txt')).toBe(true)
    expect(matchProtectedPath('secrets/', 'secrets')).toBe(false)
    expect(matchProtectedPath('secrets/', 'secretsx/token.txt')).toBe(false)
  })

  it('anchors ** globs to the whole path', () => {
    expect(matchProtectedPath('**/*.env', 'config/prod.env')).toBe(true)
    expect(matchProtectedPath('**/*.env', 'a/b/prod.env')).toBe(true)
    // Anchored: there is no implicit free suffix...
    expect(matchProtectedPath('**/*.env', 'config/prod.env.local')).toBe(false)
    // ...and ** only bridges separators, so the literal / must be present.
    expect(matchProtectedPath('**/*.env', 'prod.env')).toBe(false)
  })

  it('matches directory globs like secrets/**', () => {
    expect(matchProtectedPath('secrets/**', 'secrets/a.txt')).toBe(true)
    expect(matchProtectedPath('secrets/**', 'secrets/nested/a.txt')).toBe(true)
    expect(matchProtectedPath('secrets/**', 'nested/secrets/a.txt')).toBe(false)
  })

  it('supports single-star and question-mark wildcards within one segment', () => {
    expect(matchProtectedPath('src/*.ts', 'src/index.ts')).toBe(true)
    expect(matchProtectedPath('src/*.ts', 'src/deep/index.ts')).toBe(false)
    expect(matchProtectedPath('v?.json', 'v1.json')).toBe(true)
    expect(matchProtectedPath('v?.json', 'v12.json')).toBe(false)
  })

  it('is case-sensitive and matches patterns verbatim', () => {
    expect(matchProtectedPath('README.md', 'README.md')).toBe(true)
    expect(matchProtectedPath('README.md', 'readme.md')).toBe(false)
    expect(matchProtectedPath('SECRETS/', 'SECRETS/a.txt')).toBe(true)
    expect(matchProtectedPath('SECRETS/', 'secrets/a.txt')).toBe(false)
  })

  it('normalizes backslashes and strips a leading ./ from both inputs', () => {
    expect(matchProtectedPath('.\\src\\store', 'src/store/store.ts')).toBe(true)
    expect(matchProtectedPath('src/store', '.\\src\\store\\store.ts')).toBe(true)
    expect(matchProtectedPath('./package.json', 'package.json')).toBe(true)
    expect(matchProtectedPath('package.json', './package.json')).toBe(true)
    expect(matchProtectedPath('./secrets/', './secrets/a.txt')).toBe(true)
  })

  it('never matches with an empty pattern', () => {
    expect(matchProtectedPath('', 'anything.ts')).toBe(false)
    expect(matchProtectedPath('', '')).toBe(false)
    expect(matchProtectedPath('./', 'anything.ts')).toBe(false)
  })
})
