#!/usr/bin/env node
/**
 * Repeatable public-release gate (docs/RELEASE.md).
 *
 * Verifies, in order:
 *   1. working tree cleanliness (use --allow-dirty for local pre-commit runs)
 *   2. version consistency (package.json === src/version.ts)
 *   3. typecheck + full test suite (`npm run check`)
 *   4. production build (`npm run build`)
 *   5. package contents (`npm pack --dry-run --json`): required runtime assets
 *      present, dev/test/local artifacts absent
 *   6. owner-decision blockers reported honestly (private flag, license field)
 *
 * Exit code 0 only when every automated check passes. Owner decisions are
 * reported as BLOCKER lines and do not silently pass.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowDirty = process.argv.includes('--allow-dirty')

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'BLOCKER'
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function run(command) {
  return execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

console.log(`pluton release gate (repo: ${repoRoot})\n`)

// 1. Working tree cleanliness
try {
  const status = run('git status --porcelain').trim()
  if (status === '') {
    record('working tree clean', true)
  } else if (allowDirty) {
    record('working tree clean', true, 'dirty tree allowed via --allow-dirty (NOT acceptable for a real release)')
  } else {
    const files = status.split('\n').map((l) => l.slice(3))
    record('working tree clean', false, `${files.length} modified/untracked file(s): ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`)
  }
} catch (err) {
  record('working tree clean', false, `git status failed: ${err.message}`)
}

// 2. Version consistency
try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const versionSource = readFileSync(join(repoRoot, 'src', 'version.ts'), 'utf8')
  const match = versionSource.match(/PLUTON_VERSION\s*=\s*'([^']+)'/)
  const sourceVersion = match?.[1]
  if (sourceVersion && pkg.version === sourceVersion) {
    record('version consistency', true, `package.json === src/version.ts === ${pkg.version}`)
  } else {
    record('version consistency', false, `package.json=${pkg.version} vs src/version.ts=${sourceVersion ?? 'not found'}`)
  }

  // Name/bin contract used by README install instructions
  if (pkg.name === 'pluton-harness' && pkg.bin?.pluton === 'bin/pluton.js') {
    record('package name and executable mapping', true, `${pkg.name} → ${pkg.bin.pluton}`)
  } else {
    record('package name and executable mapping', false, `name=${pkg.name} bin.pluton=${pkg.bin?.pluton}`)
  }

  // Owner decisions required before the first public publish
  if (pkg.private === true) {
    record(
      'owner decision: private flag',
      null,
      'package.json has "private": true — npm publish is blocked by design until the owner removes it',
    )
  } else {
    record('owner decision: private flag', true, 'private flag absent (publishable)')
  }
  if (pkg.license === 'UNLICENSED' || pkg.license === undefined) {
    record(
      'owner decision: license',
      null,
      `license is "${pkg.license ?? 'missing'}" — a public release needs an outbound license decision (ADR-0011)`,
    )
  } else {
    record('owner decision: license', true, `license: ${pkg.license}`)
  }
} catch (err) {
  record('version consistency', false, err.message)
}

// 3. Typecheck + tests
try {
  console.log('\n> npm run check\n')
  const out = run('npm run check')
  const tail = out.split('\n').filter((l) => l.includes('Tests') || l.includes('Test Files')).slice(-2).join(' | ')
  record('npm run check (typecheck + tests)', true, tail || 'green')
} catch (err) {
  record('npm run check (typecheck + tests)', false, String(err.stdout ?? err.message).split('\n').filter(Boolean).slice(-6).join(' | '))
}

// 4. Production build
try {
  console.log('\n> npm run build\n')
  run('npm run build')
  record('npm run build', true)
} catch (err) {
  record('npm run build', false, String(err.stdout ?? err.message).split('\n').filter(Boolean).slice(-4).join(' | '))
}

// 5. Package contents (npm pack --dry-run)
try {
  const raw = execSync('npm pack --dry-run --json', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  const manifest = JSON.parse(raw.slice(start, end + 1))
  const files = manifest[0].files.map((f) => f.path)

  const required = [
    'package.json',
    'bin/pluton.js',
    'dist/cli/main.js',
    'dist/server/static-assets.js',
    'docker/worker/Dockerfile',
    'templates/teams/full-stack.yaml',
    'templates/roles/manager.md',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
  ]
  const missing = required.filter((f) => !files.includes(f))
  if (missing.length === 0) {
    record('package contents: required assets', true, `${files.length} files, all required entries present`)
  } else {
    record('package contents: required assets', false, `missing: ${missing.join(', ')}`)
  }

  const forbiddenPattern = /(^|\/)tests?\//i
  const forbiddenExt = /\.(env|sqlite|db|log|tgz)$/i
  const forbidden = files.filter(
    (f) => forbiddenPattern.test(f) || forbiddenExt.test(f) || f.includes('node_modules') || f.startsWith('.pluton/'),
  )
  if (forbidden.length === 0) {
    record('package contents: no dev/local artifacts', true)
  } else {
    record('package contents: no dev/local artifacts', false, `unexpected: ${forbidden.slice(0, 8).join(', ')}`)
  }
} catch (err) {
  record('package contents (npm pack --dry-run)', false, err.message)
}

// Summary
console.log('\n' + '─'.repeat(72))
const failed = results.filter((r) => r.ok === false)
const blocked = results.filter((r) => r.ok === null)
console.log(`checks: ${results.length} | passed: ${results.filter((r) => r.ok === true).length} | failed: ${failed.length} | owner blockers: ${blocked.length}`)
if (blocked.length > 0) {
  console.log('\nOwner decisions required before any public publish:')
  for (const b of blocked) console.log(`  BLOCKER ${b.name}: ${b.detail}`)
}
console.log('\nAutomated gate: ' + (failed.length === 0 ? 'PASS' : 'FAIL'))
process.exitCode = failed.length === 0 ? 0 : 1
