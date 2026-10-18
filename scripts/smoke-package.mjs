#!/usr/bin/env node
/**
 * Package smoke test: pack → install into a clean temporary prefix whose path
 * contains a space → execute the installed CLI (`--version`, `--help`).
 *
 * Cross-platform (Windows/macOS/Linux) and safe for CI:
 * - never publishes anything; `npm pack` only;
 * - prints no tokenized server URLs (no server is started);
 * - removes only the temp directory it created (in a finally block).
 *
 * Usage: npm run smoke:package
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function npm(args) {
  const cmd = ['npm', ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')
  return execSync(cmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  })
}

function pass(label, detail) {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`)
}

// A space in the working directory is deliberate: installs and CLI entry
// resolution must survive paths with spaces on every platform.
const workDir = mkdtempSync(join(tmpdir(), 'pluton smoke-'))

try {
  console.log(`pluton package smoke (temp: ${workDir})\n`)

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

  const packOut = npm(['pack', '--pack-destination', workDir]).trim()
  const tarball = packOut.split(/\r?\n/).filter(Boolean).pop()
  if (!tarball || !existsSync(join(workDir, tarball))) {
    throw new Error(`npm pack did not produce a tarball (output: ${packOut.slice(-300)})`)
  }
  pass('npm pack', tarball)

  const prefix = join(workDir, 'consumer')
  npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', join(workDir, tarball)])

  const pkgDir = join(prefix, 'node_modules', 'pluton-harness')
  const entry = join(pkgDir, 'bin', 'pluton.js')
  if (!existsSync(entry)) throw new Error(`installed entry missing: ${entry}`)
  if (!existsSync(join(pkgDir, 'dist', 'cli', 'main.js'))) {
    throw new Error('installed package has no dist/cli/main.js (packaging is broken)')
  }
  if (existsSync(join(pkgDir, 'src'))) {
    throw new Error('installed package unexpectedly contains src/ (files whitelist regression)')
  }
  pass('clean install', 'bin/pluton.js + dist/cli/main.js present, src/ absent')

  const binShim = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'pluton.cmd' : 'pluton')
  if (!existsSync(binShim)) throw new Error(`bin shim missing: ${binShim}`)
  pass('bin mapping', binShim)

  const version = execFileSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim()
  if (version !== pkg.version) throw new Error(`--version printed "${version}", expected "${pkg.version}"`)
  pass('pluton --version', version)

  execFileSync(process.execPath, [entry, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
  pass('pluton --help', 'exit 0')

  console.log('\npackage smoke: PASS')
} catch (err) {
  const detail = [err?.stdout, err?.stderr]
    .filter(Boolean)
    .map((b) => String(b).trim().split(/\r?\n/).slice(-8).join(' | '))
    .join(' || ')
  console.error(`\npackage smoke: FAIL — ${detail || err.message}`)
  process.exitCode = 1
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
