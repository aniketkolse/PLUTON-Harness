import { spawn } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { PlutonError, ValidationError } from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import {
  HELPER_ABI,
  detectCapabilities,
  helperPathFor,
  helperTargetFor,
  packageRoot,
  verifyHelper,
} from '../execution/capabilities.ts'
import { platformKey } from '../execution/policy.ts'

/**
 * Dedicated verification executor (ADR-0018 boundary).
 *
 * Verification checks are project-configured argv arrays, but they run over
 * worker-controlled content: dependencies, build scripts, test runners and
 * package manifests are all writable by the engine. Running them directly on
 * the host would hand a worker unrestricted code execution, so checks run in a
 * disposable snapshot under the native Landlock helper with `network: none`.
 *
 * There is no silent host fallback. On any platform where the requested
 * controls cannot be proven, the executor reports `available: false` and the
 * verification gate records every check as failed instead of running it.
 *
 * The snapshot excludes `.git` entirely: a check that shells out to Git must
 * not reach the worker's hooks, filters, fsmonitor or merge drivers. Checks
 * that genuinely need Git history fail closed rather than execute metadata.
 */

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'
const HELPER_READY_TIMEOUT_MS = 30_000
const MAX_SNAPSHOT_ENTRIES = 250_000
const MAX_SNAPSHOT_DEPTH = 64
const MAX_COMMAND_ARGS = 256
const MAX_ARG_CHARS = 32_768
const MAX_ENV_VALUE_CHARS = 32_768
const MAX_PATH_CHARS = 16 * 1024
const MAX_PATH_ENTRIES = 64
const SYSTEM_READ_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt']
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TERM'] as const

export class VerificationIsolationUnavailableError extends PlutonError {
  constructor(message: string) {
    super('sandbox_unavailable', message)
    this.name = 'VerificationIsolationUnavailableError'
  }
}

export interface VerificationExecutorAvailability {
  available: boolean
  reason: string | null
}

export interface VerificationExecutionRequest {
  command: string[]
  /** Execution working directory (inside the disposable snapshot). */
  cwd: string
  /** Root of the disposable snapshot; the executor may not escape it for writes. */
  workspaceRoot: string
  /** Explicit environment overrides; the executor still strips unsafe keys. */
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  /** Verification always runs with no network; other values are refused. */
  network: 'none' | 'restricted' | 'open'
}

export interface VerificationExecutionResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  /** Stable identity of the confinement mechanism that ran the check. */
  executor: string
}

export interface VerificationExecutor {
  id: string
  availability?: VerificationExecutorAvailability
  run(request: VerificationExecutionRequest): Promise<VerificationExecutionResult>
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

function existingDirs(paths: readonly string[]): string[] {
  const found: string[] = []
  for (const path of paths) {
    try {
      if (statSync(path).isDirectory()) found.push(path)
    } catch {
      // A missing system root is simply not part of the policy.
    }
  }
  return found
}

function currentEuid(): number | null {
  return typeof process.geteuid === 'function' ? process.geteuid() : null
}

/**
 * Execution-identity policy for verification.
 *
 * Checks execute worker-controlled project code. As root, Landlock still
 * confines writes, but the explicit system read roots (`/etc`, `/usr`, …) are
 * root-readable, so a check could read root-only host files such as
 * `/etc/shadow`, and a compromised check would run with root's DAC. There is
 * no uid drop here: dropping would require chowning every snapshot and the
 * helper startup path, and a half-implemented transition is worse than none.
 * Root verification is therefore refused, not silently downgraded.
 */
export function verificationIdentityRefusal(euid: number | null): string | null {
  if (euid === 0) {
    return 'verification refuses to run as root: checks execute untrusted project code and root would expose root-only host files under the system read roots; run Pluton as an unprivileged user'
  }
  return null
}

export interface RejectedPathEntry {
  entry: string
  reason: string
}

export interface TrustedVerificationPath {
  /** Minimal PATH handed to the check: only accepted runtime directories. */
  path: string
  /** Canonical accepted directories, in PATH order. */
  directories: string[]
  /** Entries dropped from the host PATH, with the reason (diagnostics only). */
  rejected: RejectedPathEntry[]
}

/**
 * Every component of a runtime directory must be root-owned or owned by the
 * invoking user and must not be group/other-writable. This rejects `/tmp`
 * style sticky world-writable roots, other users' home directories and any
 * directory another local principal could write between resolution and exec.
 */
function directoryTrustProblem(directory: string, euid: number): string | null {
  let current = directory
  for (;;) {
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(current)
    } catch {
      return `is no longer readable: ${current}`
    }
    if (!info.isDirectory()) return `is not a directory: ${current}`
    if ((info.mode & 0o022) !== 0) return `is writable by group or other: ${current}`
    if (info.uid !== 0 && info.uid !== euid) {
      return `is owned by uid ${String(info.uid)}, not root or the invoking uid: ${current}`
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Build the executable search path for a verification check.
 *
 * The host PATH is input, not authority: each absolute entry is canonicalized
 * and every ancestor must pass the ownership/writability policy. Entries
 * inside the disposable snapshot are never accepted, so a workspace cannot
 * supply the runtime that executes it. The result is also the exact PATH the
 * check and its children receive, which keeps resolution and execution
 * consistent.
 */
export function sanitizeVerificationPath(
  hostPath: string | undefined,
  snapshotRoot: string,
  euid: number,
): TrustedVerificationPath {
  const snapshot = realOrNull(snapshotRoot) ?? snapshotRoot
  const rejected: RejectedPathEntry[] = []
  const directories: string[] = []
  const seen = new Set<string>()
  const entries = (hostPath === undefined || hostPath === '' ? DEFAULT_PATH : hostPath).split(':')
  let inspected = 0
  for (const entry of entries) {
    if (entry === '') continue
    inspected += 1
    if (inspected > MAX_PATH_ENTRIES) {
      rejected.push({ entry, reason: `PATH has more than ${String(MAX_PATH_ENTRIES)} entries` })
      break
    }
    if (entry.length > MAX_PATH_CHARS) {
      rejected.push({ entry: entry.slice(0, 120), reason: 'PATH entry is too long' })
      continue
    }
    if (!isAbsolute(entry)) {
      rejected.push({ entry, reason: 'is not an absolute path' })
      continue
    }
    const real = realOrNull(entry)
    if (real === null) {
      rejected.push({ entry, reason: 'does not exist' })
      continue
    }
    if (isInside(snapshot, real)) {
      rejected.push({ entry, reason: 'is inside the disposable snapshot' })
      continue
    }
    const problem = directoryTrustProblem(real, euid)
    if (problem !== null) {
      rejected.push({ entry, reason: problem })
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    directories.push(real)
  }
  return { path: directories.join(':'), directories, rejected }
}

/**
 * Provenance checks for the executable itself. Host binaries must be regular
 * files owned by root or the invoking uid, must not be group/other-writable,
 * and must not be setuid/setgid (the helper sets `no_new_privs`, but an
 * unexpected mode is still a refusal, not something to rely on). Snapshot
 * binaries are worker-owned by design; only world-writable files are refused,
 * because another local principal could otherwise swap the content after the
 * snapshot was copied.
 */
export function executableTrustProblem(
  path: string,
  euid: number,
  location: 'host' | 'snapshot',
): string | null {
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(path)
  } catch {
    return 'does not exist'
  }
  if (!info.isFile()) return 'is not a regular file'
  if (location === 'host') {
    if ((info.mode & 0o022) !== 0) return 'is writable by group or other'
    if (info.uid !== 0 && info.uid !== euid) {
      return `is owned by uid ${String(info.uid)}, not root or the invoking uid`
    }
    if ((info.mode & 0o6000) !== 0) return 'is setuid or setgid'
  } else if ((info.mode & 0o002) !== 0) {
    return 'is writable by other users'
  }
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    return 'is not executable'
  }
  return null
}

/**
 * Build the exact environment a verification check receives.
 *
 * There is an allow list, not a deny list: credentials, SSH agents, engine
 * configuration, Pluton state and every other host variable are dropped.
 * HOME/TMPDIR point inside the snapshot so a check cannot write host config.
 */
export function buildVerificationEnvironment(
  snapshotRoot: string,
  baseEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = baseEnv[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  if (env['PATH'] === undefined) env['PATH'] = DEFAULT_PATH
  const home = join(snapshotRoot, 'home')
  const tmp = join(snapshotRoot, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  env['HOME'] = home
  env['TMPDIR'] = tmp
  env['TMP'] = tmp
  env['TEMP'] = tmp
  env['XDG_CONFIG_HOME'] = join(home, '.config')
  env['XDG_CACHE_HOME'] = join(home, '.cache')
  env['XDG_STATE_HOME'] = join(home, '.local', 'state')
  return env
}

interface CopyBudget {
  entries: number
}

function copySnapshotTree(sourceRoot: string, destRoot: string, budget: CopyBudget, depth = 0): void {
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error(`workspace nesting exceeds ${String(MAX_SNAPSHOT_DEPTH)} levels`)
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    // Never copy Git metadata: checks must not be able to execute worker hooks,
    // filters or merge drivers through a nested Git command. Pluton state
    // (database, credentials, other workspaces) is not verification input.
    if (entry.name.toLowerCase() === '.git') continue
    if (depth === 0 && entry.name === '.pluton') continue
    budget.entries += 1
    if (budget.entries > MAX_SNAPSHOT_ENTRIES) {
      throw new Error(`workspace has more than ${String(MAX_SNAPSHOT_ENTRIES)} entries; refusing an unbounded snapshot`)
    }
    const source = join(sourceRoot, entry.name)
    const dest = join(destRoot, entry.name)
    const info = lstatSync(source)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(source)
      const resolved = resolve(dirname(source), target)
      const real = realOrNull(resolved)
      if (real === null || !isInside(sourceRoot, real)) {
        throw new Error(`refusing symlink '${source}' that escapes the workspace`)
      }
      if (realOrNull(sourceRoot) !== null && isInside(real, sourceRoot)) {
        throw new Error(`refusing symlink '${source}' that points at an ancestor`)
      }
      try {
        symlinkSync(target, dest)
      } catch {
        // Windows may forbid symlink creation without privilege; copying the
        // resolved target keeps the snapshot content without a host link.
        const targetInfo = statSync(real)
        if (targetInfo.isFile()) copyFileSync(real, dest)
        else throw new Error(`cannot materialise symlinked directory '${source}' in the snapshot`)
      }
    } else if (info.isDirectory()) {
      mkdirSync(dest, { recursive: true })
      copySnapshotTree(source, dest, budget, depth + 1)
    } else if (info.isFile()) {
      copyFileSync(source, dest)
      if (process.platform !== 'win32') chmodSync(dest, info.mode & 0o777)
    } else {
      throw new Error(`unsupported workspace entry '${source}'`)
    }
  }
}

/** Copy the workspace into a disposable directory and return its root. */
export function createVerificationSnapshot(workspaceRoot: string): string {
  const source = realOrNull(workspaceRoot)
  if (source === null || !statSync(source).isDirectory()) {
    throw new ValidationError(`verification workspace does not exist or is not a directory: ${workspaceRoot}`)
  }
  const snapshot = mkdtempSync(join(tmpdir(), 'pluton-verify-snapshot-'))
  try {
    copySnapshotTree(source, snapshot, { entries: 0 })
    return snapshot
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true })
    throw error
  }
}

export function resolveCommand(
  command: string[],
  snapshotRoot: string,
  trustedDirectories: readonly string[],
  euid: number,
): string {
  const first = command[0]
  if (first === undefined || first === '') throw new ValidationError('verification command is empty')

  const trustedFile = (candidate: string): string => {
    const real = realOrNull(candidate)
    if (real === null) throw new ValidationError(`verification command does not exist: ${candidate}`)
    const location = isInside(snapshotRoot, real) ? 'snapshot' : 'host'
    const problem = executableTrustProblem(real, euid, location)
    if (problem !== null) {
      throw new ValidationError(`verification command '${first}' is not trusted: it ${problem} (${real})`)
    }
    if (location === 'host') {
      const dirProblem = directoryTrustProblem(dirname(real), euid)
      if (dirProblem !== null) {
        throw new ValidationError(
          `verification command '${first}' is not trusted: directory ${dirProblem} (${dirname(real)})`,
        )
      }
    }
    return real
  }

  if (isAbsolute(first)) return trustedFile(first)

  // Explicit relative paths are the deliberate way to run repository tooling:
  // they resolve inside the disposable snapshot only, never on the host.
  if (first.includes('/') || first.includes('\\')) {
    const candidate = resolve(snapshotRoot, first)
    if (!isInside(snapshotRoot, candidate)) {
      throw new ValidationError(`verification command must stay inside the disposable snapshot: ${first}`)
    }
    const real = realOrNull(candidate)
    if (real === null || !isInside(snapshotRoot, real)) {
      throw new ValidationError(`verification command must stay inside the disposable snapshot: ${first}`)
    }
    return trustedFile(candidate)
  }

  let refusal: string | null = null
  for (const directory of trustedDirectories) {
    const probe = join(directory, first)
    if (!existsSync(probe)) continue
    const real = realOrNull(probe)
    if (real === null) continue
    // An untrusted candidate is a refusal, not a reason to keep searching:
    // silently skipping it would hide a shadowing attempt.
    const problem = executableTrustProblem(real, euid, 'host')
    if (problem !== null) {
      refusal = `${probe}: it ${problem}`
      break
    }
    const dirProblem = directoryTrustProblem(dirname(real), euid)
    if (dirProblem !== null) {
      refusal = `${probe}: directory ${dirProblem}`
      break
    }
    return real
  }
  if (refusal !== null) {
    throw new ValidationError(`verification command '${first}' is not trusted: ${refusal}`)
  }
  throw new ValidationError(`verification command '${first}' was not found on the trusted PATH`)
}

function buildHelperRequest(
  request: VerificationExecutionRequest,
  snapshotRoot: string,
  command: string,
  env: Record<string, string>,
  sessionId: string,
): Record<string, unknown> {
  const cwd = realOrNull(request.cwd)
  if (cwd === null || !statSync(cwd).isDirectory() || !isInside(snapshotRoot, cwd)) {
    throw new ValidationError(`verification cwd is outside the disposable snapshot: ${request.cwd}`)
  }
  if (request.network !== 'none') {
    throw new ValidationError(`verification checks require network 'none' (got '${request.network}')`)
  }
  const readRoots = [...new Set([snapshotRoot, ...existingDirs(SYSTEM_READ_ROOTS), dirname(command)])]
  const execRoots = [...new Set([...existingDirs(['/usr', '/bin', '/sbin', '/lib', '/lib64']), dirname(command)])]
  const tmp = join(snapshotRoot, 'tmp')
  mkdirSync(tmp, { recursive: true })
  return {
    helper_abi: HELPER_ABI,
    mode: 'workspace-write',
    network: 'none',
    cwd,
    argv: [command, ...request.command.slice(1)],
    env,
    read_roots: readRoots,
    write_roots: [snapshotRoot, tmp],
    exec_roots: execRoots,
    tmp_dir: tmp,
    // The snapshot must survive the helper's mount namespace. It normally
    // lives under the host temp dir (/tmp on Linux), so mounting a fresh
    // tmpfs over /tmp would hide the workspace before the check execs and the
    // helper would fail closed with no readable snapshot. Verification still
    // confines /tmp through Landlock (it is not a read or write root); only
    // the snapshot's own tmp directory is mounted private.
    private_tmp: false,
    session_id: sessionId,
  }
}

function updatedEnv(
  snapshotRoot: string,
  overrides: Record<string, string>,
): Record<string, string> {
  const env = buildVerificationEnvironment(snapshotRoot, { ...process.env, ...overrides })
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key === 'TMP' || key === 'TEMP') continue
    if (!ENV_ALLOWLIST.includes(key as (typeof ENV_ALLOWLIST)[number])) continue
    if (value.length > MAX_ENV_VALUE_CHARS) throw new ValidationError(`verification environment value '${key}' is too long`)
    env[key] = value
  }
  return env
}

interface CapturedOutput {
  text: string
  truncated: boolean
}

function captureStream(stream: Readable | null, maxBytes: number): { result: () => CapturedOutput } {
  let bytes = 0
  let truncated = false
  const chunks: Buffer[] = []
  stream?.on('data', (chunk: Buffer) => {
    if (bytes >= maxBytes) {
      truncated = true
      return
    }
    const remaining = maxBytes - bytes
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining))
      bytes += remaining
      truncated = true
    } else {
      chunks.push(chunk)
      bytes += chunk.length
    }
  })
  return {
    result: () => ({
      text: Buffer.concat(chunks).toString('utf8'),
      truncated,
    }),
  }
}

function readReadyLine(stream: Readable, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`verification helper did not report readiness within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        cleanup()
        resolvePromise(buffer.slice(0, newline))
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('verification helper closed its readiness pipe before reporting readiness'))
    }
    function cleanup(): void {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('end', onEnd)
  })
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
    else process.kill(pid, 'SIGKILL')
  } catch {
    // The process already exited.
  }
}

class LandlockVerificationExecutor implements VerificationExecutor {
  readonly id: string
  readonly availability: VerificationExecutorAvailability
  private readonly helperPath: string
  private readonly root: string
  private readonly arch: string

  constructor(opts: { id: string; helperPath: string; root: string; arch: string }) {
    this.id = opts.id
    this.helperPath = opts.helperPath
    this.root = opts.root
    this.arch = opts.arch
    const capability = detectCapabilities({ root: this.root, platform: 'linux', arch: this.arch })
    const missing: string[] = []
    const identity = verificationIdentityRefusal(currentEuid())
    if (identity !== null) missing.push(identity)
    if (!capability.helper.available) missing.push(capability.helper.detail ?? 'native helper is unavailable')
    if (capability.landlockAbi === null) missing.push('Landlock ABI is unavailable')
    if (!capability.networkNamespaces) missing.push('network namespaces are unavailable')
    if (!capability.mountNamespaces) missing.push('mount namespaces are unavailable (private tmp cannot be proven)')
    if (!capability.pidNamespaces) missing.push('PID namespaces are unavailable')
    this.availability =
      missing.length === 0
        ? { available: true, reason: null }
        : { available: false, reason: missing.join('; ') }
  }

  async run(request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
    if (!this.availability.available) {
      throw new VerificationIsolationUnavailableError(
        `verification isolation is unavailable: ${this.availability.reason ?? 'unknown platform limitation'}`,
      )
    }
    if (request.command.length === 0) throw new ValidationError('verification command is empty')
    if (request.command.length > MAX_COMMAND_ARGS) {
      throw new ValidationError(`verification command has more than ${String(MAX_COMMAND_ARGS)} arguments`)
    }
    for (const arg of request.command) {
      if (arg.includes('\0')) throw new ValidationError('verification command contains NUL')
      if (arg.length > MAX_ARG_CHARS) throw new ValidationError('verification command argument is too long')
    }

    const snapshotRoot = realOrNull(request.workspaceRoot)
    if (snapshotRoot === null) throw new ValidationError(`verification snapshot is missing: ${request.workspaceRoot}`)
    const euid = currentEuid()
    if (euid === null) {
      throw new VerificationIsolationUnavailableError(
        'verification refuses to run without a verifiable effective uid',
      )
    }
    const identityProblem = verificationIdentityRefusal(euid)
    if (identityProblem !== null) throw new VerificationIsolationUnavailableError(identityProblem)
    const env = updatedEnv(snapshotRoot, request.env)
    const trustedPath = sanitizeVerificationPath(env['PATH'], snapshotRoot, euid)
    if (trustedPath.directories.length === 0) {
      throw new ValidationError(
        'no trusted runtime directories remain on PATH; verification requires absolute, non-group/world-writable runtime directories owned by root or the invoking user',
      )
    }
    env['PATH'] = trustedPath.path
    const command = resolveCommand(request.command, snapshotRoot, trustedPath.directories, euid)
    const sessionId = newId('verification')
    const helperRequest = buildHelperRequest(request, snapshotRoot, command, env, sessionId)
    const requestPath = join(snapshotRoot, 'tmp', `request-${sessionId}.json`)
    writeFileSync(requestPath, JSON.stringify(helperRequest), { encoding: 'utf8', mode: 0o600 })

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.helperPath, ['run', requestPath], {
        cwd: snapshotRoot,
        env: { PATH: DEFAULT_PATH, HOME: join(snapshotRoot, 'home'), TMPDIR: join(snapshotRoot, 'tmp') },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      rmSync(requestPath, { force: true })
      throw new VerificationIsolationUnavailableError(
        `verification helper could not start: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const stdout = captureStream(child.stdout, request.maxOutputBytes)
    const stderr = captureStream(child.stderr, request.maxOutputBytes)
    const readyStream = child.stdio[3] as Readable | null
    let timedOut = false
    let exitCode: number | null = null
    const exitPromise = new Promise<void>((resolvePromise, reject) => {
      child.on('error', (error) => reject(new Error(`verification helper failed: ${error.message}`)))
      child.on('exit', (code) => {
        exitCode = code
        resolvePromise()
      })
    })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, request.timeoutMs)

    try {
      if (readyStream === null) {
        throw new VerificationIsolationUnavailableError('verification helper did not expose a readiness pipe')
      }
      const line = await readReadyLine(readyStream, HELPER_READY_TIMEOUT_MS)
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed['ready'] !== true) {
        throw new VerificationIsolationUnavailableError(
          `verification helper refused to start: ${String(parsed['error'] ?? 'unknown error')}`,
        )
      }
      if (parsed['helperAbi'] !== HELPER_ABI || parsed['sessionId'] !== sessionId) {
        throw new VerificationIsolationUnavailableError('verification helper readiness identity mismatch')
      }
      await exitPromise
    } catch (error) {
      killTree(child.pid)
      throw error instanceof VerificationIsolationUnavailableError
        ? error
        : new VerificationIsolationUnavailableError(
            `verification helper failed before confinement was proven: ${error instanceof Error ? error.message : String(error)}`,
          )
    } finally {
      clearTimeout(timer)
      rmSync(requestPath, { force: true })
    }

    const out = stdout.result()
    const err = stderr.result()
    return {
      exitCode: timedOut ? null : exitCode,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      truncated: out.truncated || err.truncated,
      executor: this.id,
    }
  }
}

export interface CreateVerificationExecutorOptions {
  platform?: NodeJS.Platform
  arch?: string
  root?: string
}

function unavailableExecutor(platform: string, reason: string): VerificationExecutor {
  return {
    id: `unavailable:${platform}`,
    availability: { available: false, reason },
    async run() {
      throw new VerificationIsolationUnavailableError(`verification isolation is unavailable: ${reason}`)
    },
  }
}

/**
 * Build the real verification executor. No platform fallback: non-Linux hosts
 * get an executor that refuses every check, because Pluton cannot prove
 * filesystem or network containment there.
 */
export function createVerificationExecutor(options: CreateVerificationExecutorOptions = {}): VerificationExecutor {
  const platform = platformKey(options.platform ?? process.platform)
  const arch = options.arch ?? process.arch
  const root = options.root ?? packageRoot()
  if (platform !== 'linux') {
    return unavailableExecutor(
      platform,
      `verification confinement requires Linux Landlock and namespaces; ${platform} has no supported sandbox`,
    )
  }
  const target = helperTargetFor('linux', arch)
  if (target === null) {
    return unavailableExecutor(platform, `no native verification helper is built for linux/${arch}`)
  }
  const helper = verifyHelper({ root, platform: 'linux', arch })
  if (!helper.available) {
    return unavailableExecutor(platform, helper.detail ?? 'native verification helper is unavailable')
  }
  const helperPath = helperPathFor(target, root)
  const id = `landlock:${helper.version ?? 'unknown'}:${(helper.sha256 ?? '').slice(0, 12) || basename(helperPath)}`
  return new LandlockVerificationExecutor({ id, helperPath, root, arch })
}
