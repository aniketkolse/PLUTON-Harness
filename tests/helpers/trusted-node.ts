import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { packageRoot } from '../../src/execution/capabilities.ts'
import { resolveCommand } from '../../src/verify/executor.ts'

/**
 * Stage the running Node executable into a directory the verification trust
 * boundary accepts.
 *
 * Hosted CI installs Node under a tool cache that is group/other-writable
 * (`/opt/hostedtoolcache/...`), and `resolveCommand()` correctly refuses to run
 * a check from such a directory. The production refusal stays strict; tests
 * that exercise the real confined executor copy the same binary into a
 * user-owned directory with no group/other write permission instead.
 *
 * Non-Linux hosts return `process.execPath` unchanged: verification confinement
 * is Linux-only and those tests skip the real-check paths.
 */
let stagedPath: string | null = null
let stagedDir: string | null = null

function trustCheck(candidate: string): string {
  const euid = process.geteuid !== undefined ? process.geteuid() : -1
  return resolveCommand([candidate], '/nonexistent/pluton-verification-snapshot', [], euid)
}

export function cleanupTrustedNode(): void {
  if (stagedDir !== null) {
    rmSync(stagedDir, { recursive: true, force: true })
    stagedDir = null
    stagedPath = null
  }
}

/** Absolute path to a Node binary that the verification trust boundary accepts. */
export function trustedNodeExecutable(): string {
  if (process.platform !== 'linux') return process.execPath
  if (stagedPath !== null) return stagedPath

  const failures: string[] = []
  for (const base of new Set([homedir(), dirname(packageRoot()), packageRoot()])) {
    let directory: string | null = null
    try {
      directory = mkdtempSync(join(base, '.pluton-trusted-node-'))
      const candidate = join(directory, 'node')
      copyFileSync(process.execPath, candidate)
      // Owner read/execute only: resolveCommand rejects group/other writability.
      chmodSync(candidate, 0o500)
      const accepted = trustCheck(candidate)
      stagedDir = directory
      stagedPath = accepted
      process.once('exit', cleanupTrustedNode)
      return accepted
    } catch (error) {
      if (directory !== null) rmSync(directory, { recursive: true, force: true })
      const reason = error instanceof Error ? error.message : String(error)
      failures.push(`${base}: ${reason}`)
    }
  }
  throw new Error(
    `could not stage a trusted Node executable for verification tests: ${failures.join('; ')}`,
  )
}
