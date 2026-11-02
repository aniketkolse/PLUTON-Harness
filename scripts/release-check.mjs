#!/usr/bin/env node
/**
 * Repeatable public-release gate (docs/RELEASE.md).
 *
 * Technical validation, in order:
 *   1. working tree cleanliness (use --allow-dirty for local pre-commit runs;
 *      the override keeps publication blocked)
 *   2. version consistency (package.json === src/version.ts)
 *   3. package identity (name + bin mapping)
 *   4. engine requirement declared and satisfied by the running Node
 *   5. lockfile consistency (package-lock.json vs package.json)
 *   6. documentation integrity (README / THIRD_PARTY_NOTICES relative links
 *      plus the full README + docs/ tree link gate)
 *   7. typecheck + full test suite (`npm run check`)
 *   8. production build (`npm run build`)
 *   9. package contents via `npm pack --dry-run --json`:
 *      required runtime assets present, dev/local artifacts absent,
 *      no host-local paths or credential-looking strings in shipped files
 *  10. production dependency audit (NOT TESTED when the registry is unreachable)
 *  11. POSIX permission enforcement (NOT TESTED on Windows; runs in CI)
 *
 * Owner decisions (private flag, outbound license) are reported as BLOCKED.
 *
 * Result states (see scripts/lib/release-gate.mjs):
 *   PASS / FAIL / NOT TESTED / BLOCKED.
 * Exit code is 0 only when no check FAILED; NOT TESTED and BLOCKED never
 * silently pass — they are printed with reasons and remediation, and the
 * publication line stays blocked while owner decisions are unresolved or a
 * dirty-tree --allow-dirty override is in effect.
 *
 * This script never publishes, tags, pushes, deletes repository files or
 * mutates package metadata. Its filesystem writes are build output under the
 * gitignored dist/ directory (check 8 and the prepack hook) plus, on POSIX,
 * one throwaway permission-probe directory under the OS temp dir, removed in
 * a finally block.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STATUS,
  buildLeakPatterns,
  evaluatePublication,
  findBrokenRelativeLinks,
  findContentLeaks,
  findForbiddenPackFiles,
  formatErrorDetail,
  formatFailureTail,
  parseChangedFiles,
  parsePackManifest,
  renderResultLine,
  sameDepMap,
  summarize,
  REQUIRED_PACK_FILES,
} from './lib/release-gate.mjs'

const { PASS, FAIL, NOT_TESTED, BLOCKED } = STATUS

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowDirty = process.argv.includes('--allow-dirty')

// Set only when --allow-dirty actually lets validation continue on a dirty
// tree; a clean tree with the flag is not an override and stays eligible.
let dirtyOverride = false

const results = []

function record(id, label, status, detail, fix) {
  results.push({ id, label, status, detail, fix })
  console.log(renderResultLine({ label, status, detail, fix }))
}

function run(command, timeoutMs = 600_000) {
  return execSync(command, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
}

console.log(`pluton release gate (repo: ${repoRoot})\n`)

let pkg
try {
  pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
} catch (err) {
  console.error(`fatal: cannot read package.json: ${formatErrorDetail(err, 2)}`)
  process.exit(1)
}

// 1. Working tree cleanliness
try {
  const status = run('git status --porcelain')
  if (status.trim() === '') {
    record('worktree', 'working tree clean', PASS)
  } else if (allowDirty) {
    dirtyOverride = true
    record('worktree', 'working tree clean', PASS, 'dirty tree allowed via --allow-dirty (NOT acceptable for a real release)')
  } else {
    const files = parseChangedFiles(status)
    record(
      'worktree',
      'working tree clean',
      FAIL,
      `${files.length} modified/untracked file(s): ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`,
      'commit or stash the changes (or re-run with --allow-dirty for a local pre-commit check only)',
    )
  }
} catch (err) {
  record(
    'worktree',
    'working tree clean',
    BLOCKED,
    `git status failed: ${formatErrorDetail(err, 2)}`,
    'run inside a git checkout with git installed',
  )
}

// 2. Version consistency
try {
  const versionSource = readFileSync(join(repoRoot, 'src', 'version.ts'), 'utf8')
  const match = versionSource.match(/PLUTON_VERSION\s*=\s*'([^']+)'/)
  const sourceVersion = match?.[1]
  if (sourceVersion && pkg.version === sourceVersion) {
    record('version', 'version consistency', PASS, `package.json === src/version.ts === ${pkg.version}`)
  } else {
    record(
      'version',
      'version consistency',
      FAIL,
      `package.json=${pkg.version} vs src/version.ts=${sourceVersion ?? 'not found'}`,
      'make src/version.ts and package.json agree',
    )
  }
} catch (err) {
  record('version', 'version consistency', FAIL, formatErrorDetail(err, 2), 'restore src/version.ts')
}

// 3. Package identity
if (pkg.name === 'pluton-harness' && pkg.bin?.pluton === 'bin/pluton.js') {
  record('identity', 'package name and executable mapping', PASS, `${pkg.name} → ${pkg.bin.pluton}`)
} else {
  record(
    'identity',
    'package name and executable mapping',
    FAIL,
    `name=${pkg.name} bin.pluton=${pkg.bin?.pluton}`,
    'restore the documented name/bin contract (README install instructions depend on it)',
  )
}

// 4. Engine requirement
{
  const range = pkg.engines?.node
  const required = typeof range === 'string' ? range.match(/>=\s*(\d+)/) : null
  const running = process.versions.node
  if (typeof range !== 'string') {
    record('engines', 'engine requirement declared', FAIL, 'package.json has no engines.node', 'declare "engines": { "node": ">=24.0.0" }')
  } else if (!required) {
    record(
      'engines',
      'engine requirement declared',
      FAIL,
      `unrecognized engines.node range "${range}"`,
      'use a simple ">=<major>.0.0" range so the gate can verify it',
    )
  } else if (Number(running.split('.')[0]) < Number(required[1])) {
    record(
      'engines',
      'engine requirement declared',
      FAIL,
      `running Node v${running} does not satisfy engines.node ${range}`,
      `run the gate on Node ${range}`,
    )
  } else {
    record('engines', 'engine requirement declared', PASS, `engines.node ${range} (running v${running})`)
  }
}

// 5. Lockfile consistency
try {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const root = lock.packages?.['']
  const problems = []
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 3) {
    problems.push(`lockfileVersion ${lock.lockfileVersion}`)
  }
  if (root?.name !== pkg.name) problems.push(`name ${root?.name}`)
  if (root?.version !== pkg.version) problems.push(`version ${root?.version}`)
  if (!sameDepMap(pkg.dependencies, root?.dependencies)) problems.push('dependencies differ')
  if (!sameDepMap(pkg.devDependencies, root?.devDependencies)) problems.push('devDependencies differ')
  if (problems.length === 0) {
    record('lockfile', 'lockfile consistency', PASS, `lockfileVersion ${lock.lockfileVersion}, name/version/dependencies match package.json`)
  } else {
    record(
      'lockfile',
      'lockfile consistency',
      FAIL,
      problems.join(', '),
      'run `npm install` to regenerate package-lock.json and commit the result',
    )
  }
} catch (err) {
  record('lockfile', 'lockfile consistency', FAIL, formatErrorDetail(err, 2), 'restore package-lock.json (npm ci depends on it)')
}

// 6. Documentation integrity
try {
  const missing = []
  for (const doc of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
    const text = readFileSync(join(repoRoot, doc), 'utf8')
    missing.push(...findBrokenRelativeLinks(text, (t) => existsSync(join(repoRoot, t))).map((t) => `${doc} → ${t}`))
  }
  if (missing.length === 0) {
    record('docs-links', 'documentation links resolve', PASS, 'README.md and THIRD_PARTY_NOTICES.md relative links all exist')
  } else {
    record(
      'docs-links',
      'documentation links resolve',
      FAIL,
      `missing targets: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}`,
      'fix the link targets (dead docs links undermine the release)',
    )
  }
} catch (err) {
  record('docs-links', 'documentation links resolve', FAIL, formatErrorDetail(err, 2), 'restore README.md / THIRD_PARTY_NOTICES.md')
}

// 6b. Documentation tree integrity (README + docs/**/*.md)
try {
  const out = run('node scripts/verify-docs.mjs')
  const summary = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('doc links:'))
    .pop()
  record('docs-tree', 'documentation tree links resolve', PASS, summary ?? 'green')
} catch (err) {
  record(
    'docs-tree',
    'documentation tree links resolve',
    FAIL,
    formatErrorDetail(err, 8),
    'fix the dead relative links listed above (npm run verify:docs)',
  )
}

// 7. Typecheck + tests
try {
  console.log('\n> npm run check\n')
  const out = run('npm run check')
  const tail = out.split('\n').filter((l) => l.includes('Tests') || l.includes('Test Files')).slice(-2).join(' | ')
  record('check', 'npm run check (typecheck + tests)', PASS, tail || 'green')
} catch (err) {
  // The recorded detail is one bounded line; print the full captured tail so a
  // stack trace (e.g. an unhandled rejection reported after the final test)
  // survives into CI logs and can be diagnosed instead of guessed at.
  const tail = formatFailureTail(err, 160)
  if (tail.length > 0) {
    console.error('\n--- npm run check captured output (tail) ---')
    console.error(tail.join('\n'))
    console.error('--- end captured output ---\n')
  }
  record(
    'check',
    'npm run check (typecheck + tests)',
    FAIL,
    formatErrorDetail(err, 12),
    'fix the failing test/typecheck before any release attempt',
  )
}

// 8. Production build
try {
  console.log('\n> npm run build\n')
  run('npm run build')
  record('build', 'npm run build', PASS)
} catch (err) {
  record('build', 'npm run build', FAIL, formatErrorDetail(err), 'fix the build errors')
}

// 9. Package contents (npm pack --dry-run)
let packFiles = null
try {
  const raw = execSync('npm pack --dry-run --json', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  })
  packFiles = parsePackManifest(raw).files
} catch (err) {
  record(
    'pack-manifest',
    'package manifest (npm pack --dry-run)',
    FAIL,
    formatErrorDetail(err),
    'run `npm pack --dry-run --json` manually and fix the reported problem',
  )
}

if (packFiles) {
  const missing = REQUIRED_PACK_FILES.filter((f) => !packFiles.includes(f))
  if (missing.length === 0) {
    record('pack-required', 'package contents: required assets', PASS, `${packFiles.length} files, all required entries present`)
  } else {
    record(
      'pack-required',
      'package contents: required assets',
      FAIL,
      `missing: ${missing.join(', ')}`,
      'check the "files" whitelist in package.json and the build output',
    )
  }

  const forbidden = findForbiddenPackFiles(packFiles)
  if (forbidden.length === 0) {
    record('pack-forbidden', 'package contents: no dev/local artifacts', PASS)
  } else {
    record(
      'pack-forbidden',
      'package contents: no dev/local artifacts',
      FAIL,
      `unexpected: ${forbidden.slice(0, 8).join(', ')}`,
      'remove these paths from the published set (files whitelist / build output)',
    )
  }

  const patterns = buildLeakPatterns({ homeDir: homedir(), repoRoot, platform: process.platform })
  const findings = findContentLeaks({
    files: packFiles,
    readFile: (f) => {
      const buf = readFileSync(join(repoRoot, f))
      if (buf.subarray(0, 4096).includes(0)) return '' // binary: no text leaks to find
      return buf.toString('utf8')
    },
    patterns,
  })
  if (findings.length === 0) {
    record('pack-content', 'package contents: no local paths or credentials', PASS, `${packFiles.length} files scanned`)
  } else {
    record(
      'pack-content',
      'package contents: no local paths or credentials',
      FAIL,
      findings.slice(0, 6).map((f) => `${f.file} (${f.label})`).join(', '),
      'remove host-local paths/credentials from the shipped files or their build inputs',
    )
  }
}

// 9b. Package size
{
  let packSize = 0
  try {
    const raw = execSync('npm pack --dry-run --json', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    })
    const manifest = JSON.parse(raw)
    let files = []
    if (Array.isArray(manifest) && manifest.length > 0 && Array.isArray(manifest[0].files)) {
      files = manifest[0].files
    } else if (manifest && Array.isArray(manifest.files)) {
      files = manifest.files
    }
    packSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  } catch {
    packSize = -1
  }
  const maxSize = 50 * 1024 * 1024 // 50 MB
  const sizeMb = (packSize / 1024 / 1024).toFixed(2)
  if (packSize >= 0 && packSize <= maxSize) {
    record('pack-size', 'package size bounded', PASS, `${sizeMb} MB (max ${maxSize / 1024 / 1024} MB)`)
  } else if (packSize < 0) {
    record(
      'pack-size',
      'package size bounded',
      NOT_TESTED,
      'could not compute package size',
      'run `npm pack --dry-run --json` manually',
    )
  } else {
    record(
      'pack-size',
      'package size bounded',
      FAIL,
      `${sizeMb} MB exceeds ${maxSize / 1024 / 1024} MB maximum`,
      'reduce the "files" whitelist or remove large assets',
    )
  }
}

// 10. Production dependency audit
{
  let raw = ''
  let failure = ''
  try {
    raw = execSync('npm audit --omit=dev --json', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    })
  } catch (err) {
    raw = err?.stdout ? String(err.stdout) : ''
    failure = formatErrorDetail(err, 2)
  }
  let audit = null
  try {
    audit = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {
    audit = null
  }
  const total = audit?.metadata?.vulnerabilities?.total
  if (typeof total !== 'number') {
    record(
      'audit',
      'dependency audit (production)',
      NOT_TESTED,
      `npm registry unreachable or audit output unparsable${failure ? ` (${failure})` : ''}`,
      'run `npm audit --omit=dev` when the registry is reachable',
    )
  } else if (total === 0) {
    record('audit', 'dependency audit (production)', PASS, '0 vulnerabilities in production dependencies')
  } else {
    const names = Object.keys(audit.vulnerabilities ?? {}).slice(0, 5).join(', ')
    record(
      'audit',
      'dependency audit (production)',
      FAIL,
      `${total} vulnerability/ies: ${names}${Object.keys(audit.vulnerabilities ?? {}).length > 5 ? ', …' : ''}`,
      'review `npm audit --omit=dev` and update or document each finding before release',
    )
  }
}

// 11. POSIX permission enforcement
if (process.platform === 'win32') {
  record(
    'posix-perms',
    'file permission enforcement (POSIX 0600)',
    NOT_TESTED,
    'Windows does not enforce POSIX mode bits',
    'runs automatically on the Linux/macOS CI jobs (ubuntu-latest, macos-latest)',
  )
} else {
  const probeDir = mkdtempSync(join(tmpdir(), 'pluton-gate-perms-'))
  try {
    const probeFile = join(probeDir, 'probe')
    writeFileSync(probeFile, 'x', { mode: 0o600 })
    const mode = statSync(probeFile).mode & 0o777
    if (mode === 0o600) {
      record('posix-perms', 'file permission enforcement (POSIX 0600)', PASS, 'created with mode 0600 and observed 0600')
    } else {
      record(
        'posix-perms',
        'file permission enforcement (POSIX 0600)',
        FAIL,
        `expected 0600, observed 0${mode.toString(8)}`,
        'check the umask and filesystem mount options (token/instance files rely on 0600)',
      )
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

// Owner decisions required before the first public publish
if (pkg.private === true) {
  record(
    'owner-private',
    'owner decision: private flag',
    BLOCKED,
    'package.json has "private": true — npm publish is blocked by design until the owner removes it',
    'owner removes "private": true in the release commit (docs/RELEASE.md)',
  )
} else {
  record('owner-private', 'owner decision: private flag', PASS, 'private flag absent (publishable)')
}
if (pkg.license === 'UNLICENSED' || pkg.license === undefined) {
  record(
    'owner-license',
    'owner decision: license',
    BLOCKED,
    `license is "${pkg.license ?? 'missing'}" — a public release needs an outbound license decision (ADR-0011)`,
    'owner chooses a license, adds LICENSE, and updates package.json + THIRD_PARTY_NOTICES.md',
  )
} else {
  record('owner-license', 'owner decision: license', PASS, `license: ${pkg.license}`)
}

// Summary
console.log('\n' + '─'.repeat(72))
const summary = summarize(results)
console.log(
  `checks: ${summary.total} | passed: ${summary.passed} | failed: ${summary.failed} | not tested: ${summary.notTested} | owner blockers: ${summary.blocked}`,
)

const attention = results.filter((r) => r.status !== PASS && r.fix)
if (attention.length > 0) {
  console.log('\nItems needing attention:')
  for (const r of attention) console.log(`  ${renderResultLine(r)}`)
}

console.log(`\nTECHNICAL VALIDATION: ${summary.technical}`)
const publication = evaluatePublication({
  failed: summary.failed,
  blocked: summary.blocked,
  dirtyOverride,
})
console.log(`PUBLICATION: ${publication.eligible ? 'ELIGIBLE' : 'BLOCKED'} — ${publication.reason}`)

process.exitCode = summary.exitCode
