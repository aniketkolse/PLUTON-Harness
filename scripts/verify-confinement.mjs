#!/usr/bin/env node
/**
 * Standalone Linux Confinement & Adversarial Security Gate
 *
 * Exercises the real verification executor and native helper on Linux,
 * validating each required security invariant against the actual kernel
 * boundary (Landlock, namespaces, seccomp, trusted-Git, evidence binding).
 *
 * Usage:
 *   node scripts/verify-confinement.mjs              # Run all unprivileged checks
 *   node scripts/verify-confinement.mjs --root-only  # Run root-refusal check as root
 *   node scripts/verify-confinement.mjs --all        # Run both (detects or uses sudo)
 *
 * Exit code:
 *   0: All mandatory security invariants PASSED
 *   1: At least one invariant FAILED or required isolation was unavailable
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createVerificationExecutor,
  createVerificationSnapshot,
  executableTrustProblem,
  resolveCommand,
  sanitizeVerificationPath,
  verificationIdentityRefusal,
  VerificationIsolationUnavailableError,
} from '../src/verify/executor.ts'
import { detectCapabilities } from '../src/execution/capabilities.ts'
import { ValidationError } from '../src/domain/errors.ts'
import {
  captureRawSnapshot,
  commitRaw,
} from '../src/workspace/trusted-git.ts'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const SCRATCH_BASE =
  process.env.PLUTON_CONFINEMENT_SCRATCH ||
  join('/var/tmp', `pluton-confinement-gate-${process.geteuid ? process.geteuid() : process.pid}`)
let NODE = process.execPath
const results = []

const STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_TESTED: 'NOT TESTED',
  BLOCKED: 'BLOCKED',
}

function record(id, label, status, detail) {
  results.push({ id, label, status, detail })
  const tag = `[${status}]`.padEnd(12)
  console.log(`${tag} ${label}`)
  if (detail && status !== STATUS.PASS) {
    console.log(`             ${detail}`)
  }
}

/**
 * Print the confinement-gate summary and exit non-zero if any mandatory
 * invariant failed. Must be reached by every code path so a failed or
 * unavailable invariant can never be reported as a successful run.
 */
function finish() {
  const failed = results.filter((r) => r.status === STATUS.FAIL)
  console.log(
    `\n────────────────────────────────────────────────────────────────────────\nconfinement gate: ${results.length} checks | passed: ${results.length - failed.length} | failed: ${failed.length}`,
  )
  if (failed.length > 0) {
    console.error('\nFAILURE: One or more mandatory confinement invariants failed:')
    for (const f of failed) {
      console.error(`  - ${f.label}: ${f.detail}`)
    }
    process.exit(1)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function safeRm(p) {
  try {
    rmSync(p, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Hosted CI installs Node under `/opt/hostedtoolcache`, which is group/other
 * writable. The verification trust boundary correctly refuses to execute a
 * host binary from such a directory, so the gate stages the same runtime into a
 * user-owned 0700 directory with a 0500 file before exercising the real
 * executor. The production refusal is unchanged: this only removes the
 * runner's tool-cache layout from the equation.
 */
function stageTrustedNode() {
  if (process.platform !== 'linux') return process.execPath
  const euid = process.geteuid ? process.geteuid() : -1
  const failures = []
  const bases = [process.env.HOME, homedir(), SCRATCH_BASE].filter(
    (base) => typeof base === 'string' && base.length > 0,
  )
  for (const base of new Set(bases)) {
    let dir = null
    try {
      mkdirSync(base, { recursive: true })
      dir = mkdtempSync(join(base, '.pluton-confinement-node-'))
      chmodSync(dir, 0o700)
      const candidate = join(dir, 'node')
      copyFileSync(process.execPath, candidate)
      chmodSync(candidate, 0o500)
      const accepted = resolveCommand(
        [candidate],
        '/nonexistent/pluton-confinement-snapshot',
        [],
        euid,
      )
      const staged = dir
      process.once('exit', () => safeRm(staged))
      return accepted
    } catch (error) {
      if (dir !== null) safeRm(dir)
      failures.push(`${base}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `could not stage a trusted Node runtime for the confinement gate: ${failures.join('; ')}`,
  )
}

function initRepo(path) {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path })
  writeFileSync(join(path, 'app.txt'), 'seed\n')
  execFileSync('git', ['add', '.'], { cwd: path })
  execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@pluton.local', 'commit', '-q', '-m', 'seed'], {
    cwd: path,
  })
  return path
}

async function testInvariant(id, label, fn) {
  try {
    const detail = await fn()
    record(id, label, STATUS.PASS, detail)
  } catch (error) {
    record(id, label, STATUS.FAIL, error instanceof Error ? error.stack || error.message : String(error))
  }
}

async function runRootRefusal() {
  const isRoot = process.geteuid ? process.geteuid() === 0 : false
  if (!isRoot) {
    record(
      'root-refusal',
      'Invariant 9: Root invocation unconditionally refused (fail-closed)',
      STATUS.BLOCKED,
      'Process is not running with euid 0; re-run with sudo or --root-only',
    )
    return
  }

  await testInvariant(
    'root-refusal',
    'Invariant 9: Root invocation unconditionally refused (fail-closed)',
    async () => {
      const refusal = verificationIdentityRefusal(0)
      assert(refusal !== null, 'refusal reason must not be null for root')
      assert(/refuses to run as root/i.test(refusal), `unexpected refusal message: ${refusal}`)

      const executor = createVerificationExecutor()
      assert(executor.availability.available === false, 'executor must report available: false when running as root')

      const repo = initRepo(join(SCRATCH_BASE, 'root-repo'))
      const snapshot = createVerificationSnapshot(repo)
      let threw = null
      try {
        await executor.run({
          command: [NODE, '-e', 'process.exit(0)'],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 10_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
      } catch (err) {
        threw = err
      } finally {
        safeRm(snapshot)
        safeRm(repo)
      }

      assert(
        threw instanceof VerificationIsolationUnavailableError,
        `expected VerificationIsolationUnavailableError, got ${threw}`,
      )
      assert(/refuses to run as root/i.test(threw.message), `unexpected error: ${threw.message}`)
      return { refused: threw.message }
    },
  )

  finish()
}

async function runUnprivilegedInvariants() {
  const isRoot = process.geteuid ? process.geteuid() === 0 : false
  if (isRoot) {
    console.log('Running as root: executing root refusal invariant...')
    await runRootRefusal()
    finish()
    return
  }

  const caps = detectCapabilities({ root: ROOT_DIR, platform: 'linux', arch: process.arch })
  console.log(`\nPluton Linux Confinement Gate (uid=${process.geteuid()}, Landlock ABI=${caps.landlockAbi})\n`)

  if (!caps.helper.available) {
    record('helper-precheck', 'Native confinement helper availability', STATUS.FAIL, caps.helper.detail)
    finish()
    return
  }

  safeRm(SCRATCH_BASE)
  mkdirSync(SCRATCH_BASE, { recursive: true })
  NODE = stageTrustedNode()
  const baseRepo = initRepo(join(SCRATCH_BASE, 'fixture-repo'))

  // Invariant 1: Filesystem read/write confinement
  await testInvariant(
    'fs-confinement',
    'Invariant 1: Filesystem read/write confinement (Landlock enforces boundary)',
    async () => {
      const outsideCanary = join(SCRATCH_BASE, 'outside-canary.txt')
      writeFileSync(outsideCanary, 'HOST_SECRET_DATA\n')

      const snapshot = createVerificationSnapshot(baseRepo)
      try {
        const executor = createVerificationExecutor()
        assert(executor.availability.available, `executor unavailable: ${executor.availability.reason}`)

        // Check 1a: Attempt to read outside canary must fail
        const readOutside = await executor.run({
          command: [
            NODE,
            '-e',
            `try { require('node:fs').readFileSync(${JSON.stringify(outsideCanary)}); process.exit(0); } catch (e) { process.exit(99); }`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        assert(readOutside.exitCode === 99, `reading outside file should have failed, got exit ${readOutside.exitCode}`)

        // Check 1b: Attempt to write outside snapshot must fail
        const outsideTarget = join(SCRATCH_BASE, 'should-not-exist.txt')
        const writeOutside = await executor.run({
          command: [
            NODE,
            '-e',
            `try { require('node:fs').writeFileSync(${JSON.stringify(outsideTarget)}, 'leak'); process.exit(0); } catch (e) { process.exit(98); }`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        assert(!existsSync(outsideTarget), 'file was written outside snapshot!')
        assert(writeOutside.exitCode === 98, `writing outside should have failed, got exit ${writeOutside.exitCode}`)

        // Check 1c: Write inside snapshot succeeds
        const insideTarget = join(snapshot, 'inside-target.txt')
        const writeInside = await executor.run({
          command: [
            NODE,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(insideTarget)}, 'ok'); process.exit(0);`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        assert(writeInside.exitCode === 0, `write inside failed: ${writeInside.stderr}`)
        assert(existsSync(insideTarget), 'file inside snapshot was not written')

        return { readDenied: true, outsideWriteDenied: true, insideWriteAllowed: true }
      } finally {
        safeRm(snapshot)
      }
    },
  )

  // Invariant 2: Snapshot and symlink containment
  await testInvariant(
    'symlink-containment',
    'Invariant 2: Snapshot and symlink containment (escaping symlinks refused)',
    async () => {
      const hostileRepo = join(SCRATCH_BASE, 'hostile-symlink-repo')
      initRepo(hostileRepo)
      symlinkSync('/etc', join(hostileRepo, 'escape-link'))

      let snapshotThrew = null
      try {
        createVerificationSnapshot(hostileRepo)
      } catch (err) {
        snapshotThrew = err
      }
      assert(snapshotThrew !== null, 'snapshot creation must fail on escaping symlink')
      assert(/refusing symlink.*that escapes/i.test(snapshotThrew.message), `unexpected error: ${snapshotThrew.message}`)

      // Relative path escaping snapshot in execution
      const snapshot = createVerificationSnapshot(baseRepo)
      try {
        const executor = createVerificationExecutor()
        let execThrew = null
        try {
          await executor.run({
            command: ['../outside.sh'],
            cwd: snapshot,
            workspaceRoot: snapshot,
            env: {},
            timeoutMs: 10_000,
            maxOutputBytes: 4096,
            network: 'none',
          })
        } catch (err) {
          execThrew = err
        }
        assert(execThrew instanceof ValidationError, `expected ValidationError, got ${execThrew}`)
        assert(/must stay inside the disposable snapshot/i.test(execThrew.message))

        return { escapingSymlinkBlocked: true, escapingRelativeCommandBlocked: true }
      } finally {
        safeRm(snapshot)
      }
    },
  )

  // Invariant 3: Environment allowlisting
  await testInvariant(
    'env-allowlisting',
    'Invariant 3: Environment allowlisting (host secrets stripped, HOME/TMPDIR isolated)',
    async () => {
      const snapshot = createVerificationSnapshot(baseRepo)
      try {
        const executor = createVerificationExecutor()
        const result = await executor.run({
          command: [
            NODE,
            '-e',
            'console.log(JSON.stringify({ env: process.env, home: process.env.HOME, tmp: process.env.TMPDIR }))',
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {
            AWS_SECRET_ACCESS_KEY: 'LEAKED_KEY_123',
            GITHUB_TOKEN: 'ghp_LEAKED_TOKEN',
            CUSTOM_HOST_SECRET: 'FORBIDDEN',
          },
          timeoutMs: 30_000,
          maxOutputBytes: 16384,
          network: 'none',
        })
        assert(result.exitCode === 0, `exec failed: ${result.stderr}`)
        const parsed = JSON.parse(result.stdout)
        assert(!parsed.env.AWS_SECRET_ACCESS_KEY, 'AWS secret leaked!')
        assert(!parsed.env.GITHUB_TOKEN, 'GitHub token leaked!')
        assert(!parsed.env.CUSTOM_HOST_SECRET, 'Custom host secret leaked!')
        assert(parsed.home.startsWith(snapshot), `HOME outside snapshot: ${parsed.home}`)
        assert(parsed.tmp.startsWith(snapshot), `TMPDIR outside snapshot: ${parsed.tmp}`)

        return { secretsStripped: true, homeIsolated: parsed.home }
      } finally {
        safeRm(snapshot)
      }
    },
  )

  // Invariant 4: Network and AF_UNIX restrictions
  await testInvariant(
    'network-afunix-restrictions',
    'Invariant 4: Network and AF_UNIX restrictions (loopback denied, seccomp blocks AF_UNIX)',
    async () => {
      const snapshot = createVerificationSnapshot(baseRepo)
      const socketPath = join(tmpdir(), `pluton-gate-unix-${process.pid}-${Date.now()}.sock`)
      const server = createServer((s) => s.end('HOST_IPC_LEAK'))
      await new Promise((res, rej) => {
        server.once('error', rej)
        server.listen(socketPath, res)
      })

      try {
        const executor = createVerificationExecutor()

        // 4a: AF_UNIX connection must be blocked by seccomp
        const afUnixResult = await executor.run({
          command: [
            NODE,
            '-e',
            `const net = require('node:net');
             const s = net.connect(${JSON.stringify(socketPath)});
             s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
             s.on('error', (e) => { console.log('AF_UNIX_ERR:' + e.code); process.exit(97); });`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        assert(afUnixResult.exitCode === 97, `AF_UNIX should have failed, got exit ${afUnixResult.exitCode}`)
        assert(
          afUnixResult.stdout.includes('AF_UNIX_ERR:EPERM') || afUnixResult.stdout.includes('AF_UNIX_ERR:EACCES'),
          `expected EPERM/EACCES, got: ${afUnixResult.stdout}`,
        )

        // 4b: Network none: external network unreachable
        const extNetResult = await executor.run({
          command: [
            NODE,
            '-e',
            `const net = require('node:net');
             const s = net.connect({ host: '1.1.1.1', port: 80, timeout: 1000 });
             s.on('connect', () => { process.exit(0); });
             s.on('error', () => { process.exit(96); });
             s.on('timeout', () => { process.exit(96); });`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        assert(extNetResult.exitCode === 96, `external net should have failed, got ${extNetResult.exitCode}`)

        return { afUnixBlocked: true, externalNetBlocked: true }
      } finally {
        server.close()
        safeRm(socketPath)
        safeRm(snapshot)
      }
    },
  )

  // Invariant 5: Process timeout and descendant termination
  await testInvariant(
    'process-termination',
    'Invariant 5: Process timeout and descendant termination (tree killed on timeout)',
    async () => {
      const snapshot = createVerificationSnapshot(baseRepo)
      try {
        const executor = createVerificationExecutor()
        const start = Date.now()
        const result = await executor.run({
          command: [
            NODE,
            '-e',
            // Spawn a detached descendant process that tries to survive
            `const { spawn } = require('node:child_process');
             const sub = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
             sub.unref();
             while(true) {}`,
          ],
          cwd: snapshot,
          workspaceRoot: snapshot,
          env: {},
          timeoutMs: 2_000,
          maxOutputBytes: 4096,
          network: 'none',
        })
        const duration = Date.now() - start
        assert(result.timedOut, 'execution should have timed out')
        assert(duration < 15_000, `timeout took too long: ${duration}ms`)

        return { timedOut: true, durationMs: duration }
      } finally {
        safeRm(snapshot)
      }
    },
  )

  // Invariant 6: Hostile Git hooks and filters neutralized
  await testInvariant(
    'hostile-git-neutralized',
    'Invariant 6: Hostile Git hooks and filters neutralized (trusted-git snapshot)',
    async () => {
      const hostileRepo = join(SCRATCH_BASE, 'hostile-git-repo')
      initRepo(hostileRepo)

      // Plant hostile hooks and config
      const marker = join(SCRATCH_BASE, 'git-hook-ran.txt')
      const hooksDir = join(hostileRepo, '.git', 'hooks')
      mkdirSync(hooksDir, { recursive: true })
      writeFileSync(join(hooksDir, 'pre-commit'), `#!/bin/sh\necho LEAK > ${marker}\nexit 0\n`)
      chmodSync(join(hooksDir, 'pre-commit'), 0o755)

      // Hostile attributes and filters
      writeFileSync(join(hostileRepo, '.gitattributes'), '* filter=exploit diff=exploit\n')
      execFileSync('git', ['config', 'filter.exploit.clean', `sh -c 'echo CLEAN_LEAK > ${marker}'`], {
        cwd: hostileRepo,
      })
      execFileSync('git', ['config', 'filter.exploit.smudge', `sh -c 'echo SMUDGE_LEAK > ${marker}'`], {
        cwd: hostileRepo,
      })

      // Create snapshot using trusted-git
      const snapshot = createVerificationSnapshot(hostileRepo)
      try {
        assert(!existsSync(join(snapshot, '.git')), '.git metadata leaked into verification snapshot!')
        assert(!existsSync(marker), 'Hostile git hook was executed during snapshot!')

        return { gitMetadataExcluded: true, hookExecuted: false }
      } finally {
        safeRm(snapshot)
        safeRm(hostileRepo)
        safeRm(marker)
      }
    },
  )

  // Invariant 7: Evidence binding and fail-closed verdicts
  await testInvariant(
    'evidence-binding',
    'Invariant 7: Evidence binding and fail-closed verdicts (no evidence, no green)',
    async () => {
      const snapshot = createVerificationSnapshot(baseRepo)
      try {
        const executor = createVerificationExecutor()
        // Missing command fails closed
        let threw = null
        try {
          await executor.run({
            command: ['nonexistent-tool-must-fail-12345'],
            cwd: snapshot,
            workspaceRoot: snapshot,
            env: {},
            timeoutMs: 5_000,
            maxOutputBytes: 4096,
            network: 'none',
          })
        } catch (err) {
          threw = err
        }
        assert(threw instanceof ValidationError, `expected ValidationError, got ${threw}`)
        assert(/not found on the trusted PATH/i.test(threw.message))

        return { failedClosedOnMissingTool: true }
      } finally {
        safeRm(snapshot)
      }
    },
  )

  // Invariant 8: Verification fingerprint mismatch blocks integration
  await testInvariant(
    'fingerprint-mismatch',
    'Invariant 8: Verification fingerprint mismatch blocks integration',
    async () => {
      const snap = await captureRawSnapshot(baseRepo)
      assert(snap.fingerprint && snap.fingerprint.length === 64, 'raw snapshot must provide 64-char hex fingerprint')

      // Commit with matching fingerprint is authorized
      writeFileSync(join(baseRepo, 'new-file.txt'), 'clean edit\n')
      const updatedSnap = await captureRawSnapshot(baseRepo)

      // Commit with stale/mismatched fingerprint fails
      let mismatchThrew = null
      try {
        await commitRaw(baseRepo, 'unauthorized commit', { expectedFingerprint: snap.fingerprint })
      } catch (err) {
        mismatchThrew = err
      }
      assert(mismatchThrew !== null, 'commitRaw must refuse mismatched fingerprint')
      assert(/refusing to commit unverified content/i.test(mismatchThrew.message))

      // Commit with matching fingerprint succeeds
      const commitRes = await commitRaw(baseRepo, 'verified commit', {
        expectedFingerprint: updatedSnap.fingerprint,
      })
      assert(commitRes.commit !== null, 'commit with matching fingerprint should succeed')

      return { staleFingerprintRefused: true, matchingFingerprintCommitted: commitRes.commit }
    },
  )

  // Invariant 9: Root refusal (executed via sudo if available, else noted)
  const canSudo = spawnSync('sudo', ['-n', 'true']).status === 0
  if (canSudo) {
    await testInvariant(
      'root-refusal',
      'Invariant 9: Root invocation unconditionally refused (fail-closed via sudo)',
      async () => {
        const out = execFileSync('sudo', [NODE, fileURLToPath(import.meta.url), '--root-only'], {
          encoding: 'utf8',
        })
        assert(out.includes('[PASS]'), `root check failed: ${out}`)
        return { rootRefusalVerifiedViaSudo: true }
      },
    )
  } else {
    record(
      'root-refusal',
      'Invariant 9: Root invocation unconditionally refused (fail-closed)',
      STATUS.NOT_TESTED,
      'Passwordless sudo unavailable in this shell; verify with --root-only under root/sudo',
    )
  }

  // Invariant 10: PATH sanitization, executable provenance, and TOCTOU prevention
  await testInvariant(
    'path-provenance-toctou',
    'Invariant 10: PATH sanitization, executable provenance, and TOCTOU prevention',
    async () => {
      const snapshot = createVerificationSnapshot(baseRepo)
      const trustedDir = join(process.env.HOME || '/home/plutonprobe', 'confinement-gate-trusted')
      mkdirSync(trustedDir, { recursive: true })
      chmodSync(trustedDir, 0o755)

      const untrustedDir = join(SCRATCH_BASE, 'untrusted-bin')
      mkdirSync(untrustedDir, { recursive: true })
      chmodSync(untrustedDir, 0o777) // world writable

      try {
        const uid = process.geteuid()

        // 10a: Writable directory on PATH is stripped
        const pathResult = sanitizeVerificationPath(`${untrustedDir}:/usr/bin:/bin`, snapshot, uid)
        assert(!pathResult.directories.includes(untrustedDir), 'writable directory was not stripped from PATH')

        // 10b: Writable executable is rejected
        const badBin = join(trustedDir, 'bad-executable')
        writeFileSync(badBin, '#!/bin/sh\nexit 0\n')
        chmodSync(badBin, 0o777)
        expectTrustProblem: {
          const prob = executableTrustProblem(badBin, uid, 'host')
          assert(prob && prob.includes('writable by group or other'), `expected writable refusal, got: ${prob}`)
        }

        // 10c: TOCTOU - Absolute path in writable directory is rejected
        const untrustedBinary = join(untrustedDir, 'fake-tool')
        writeFileSync(untrustedBinary, '#!/bin/sh\nexit 0\n')
        chmodSync(untrustedBinary, 0o755)
        let absThrew = null
        try {
          resolveCommand([untrustedBinary], snapshot, [], uid)
        } catch (err) {
          absThrew = err
        }
        assert(absThrew instanceof ValidationError, `expected ValidationError on untrusted absolute path, got ${absThrew}`)
        assert(/is writable by group or other/i.test(absThrew.message), `unexpected error: ${absThrew.message}`)

        // 10d: TOCTOU - Symlink on PATH pointing to untrusted directory is rejected
        const symlinkTool = join(trustedDir, 'symlink-tool')
        safeRm(symlinkTool)
        symlinkSync(untrustedBinary, symlinkTool)
        let symThrew = null
        try {
          resolveCommand(['symlink-tool'], snapshot, [trustedDir], uid)
        } catch (err) {
          symThrew = err
        }
        assert(symThrew instanceof ValidationError, `expected ValidationError on symlink to untrusted dir, got ${symThrew}`)
        assert(/directory is writable by group or other/i.test(symThrew.message), `unexpected error: ${symThrew.message}`)

        // 10e: TOCTOU - Relative path in snapshot resolving to outside file is rejected
        const escapingSymlink = join(snapshot, 'escape-bin.sh')
        safeRm(escapingSymlink)
        symlinkSync('/bin/sh', escapingSymlink)
        let relEscapeThrew = null
        try {
          resolveCommand(['./escape-bin.sh'], snapshot, [], uid)
        } catch (err) {
          relEscapeThrew = err
        }
        assert(
          relEscapeThrew instanceof ValidationError,
          `expected ValidationError on escaping relative symlink, got ${relEscapeThrew}`,
        )
        assert(/must stay inside the disposable snapshot/i.test(relEscapeThrew.message))

        return {
          writableDirDropped: true,
          writableBinRejected: true,
          untrustedAbsoluteRejected: true,
          untrustedSymlinkRejected: true,
          escapingRelativeRejected: true,
        }
      } finally {
        safeRm(snapshot)
        safeRm(trustedDir)
        safeRm(untrustedDir)
      }
    },
  )

  // Summary
  safeRm(SCRATCH_BASE)
  finish()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--root-only')) {
    await runRootRefusal()
  } else {
    await runUnprivilegedInvariants()
  }
}

main().catch((err) => {
  console.error(`Fatal error in confinement gate: ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
