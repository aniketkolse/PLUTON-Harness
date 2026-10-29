import { spawn as nodeSpawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import {
  ExecutionClosedError,
  ExecutionTimeoutError,
  PolicyDeniedError,
  SandboxUnavailableError,
  ValidationError,
} from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import { PLATFORM_ENV_KEEP } from '../engines/acp/env.ts'
import type { AcpChild } from '../engines/acp/client.ts'
import type { RunResult } from '../util/exec.ts'
import { HELPER_ABI, detectCapabilities, helperPathFor, helperTargetFor } from './capabilities.ts'
import {
  assertPolicySupported,
  enforcementFor,
  platformKey,
  type EffectiveExecutionPolicy,
  type EnforcementReport,
  type HelperCapability,
  type NativeCapabilities,
  type PlatformKey,
} from './policy.ts'

/**
 * Native execution provider (host processes, no Docker).
 *
 * Two backends share the same lifecycle surface:
 *
 * - `landlock` (Linux, confined modes): every process is created by the
 *   verified `landlock-run` helper. The helper applies a Landlock filesystem
 *   allowlist, a private mount namespace with a per-session tmpfs, a private
 *   network namespace for `restricted`/`none`, and a PID namespace where the
 *   engine is PID 1. For `restricted`, a trusted proxy on loopback forwards to
 *   the host tool bridge over AF_UNIX.
 * - `unconfined`: direct host spawn, permitted only with mode `unconfined` and
 *   network `open`, and only after an explicit operator acknowledgement.
 *
 * The provider never downgrades a policy. A missing helper, missing namespace
 * support, unsupported platform or absent bridge fails before a process exists.
 * Landlock confines filesystem access only; network isolation is the network
 * namespace, never Landlock.
 */

export type ExecutionProviderKind = 'native'
export type ExecutionBackend = 'landlock' | 'unconfined' | 'unavailable'
export type { ExecutionMode, ExecutionNetworkPolicy } from './policy.ts'

import type { ExecutionMode, ExecutionNetworkPolicy } from './policy.ts'

export interface ExecutionLimits {
  cpus: number
  memoryMb: number
  pids: number
}

/** Host tool-bridge endpoint used by a `restricted` session. */
export interface ExecutionBridgeSpec {
  /** Absolute AF_UNIX socket path the in-namespace proxy connects to. */
  unixPath: string
  /** Host bridge port, reused on loopback inside the session network namespace. */
  port: number
}

export interface ExecutionSessionSpec {
  projectId: string
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
  engineKind: string
  /** Absolute host working directory for the engine process. */
  hostWorkdir: string
  /** Absolute Pluton-owned engine home (private config/state dir). */
  hostEngineHome: string
  /** Every cwd must be inside one of these absolute roots. */
  allowedRoots: string[]
  mode: ExecutionMode
  network: ExecutionNetworkPolicy
  /** Explicit environment values (allowlisted by the caller), never full host env. */
  env: Record<string, string>
  limits: ExecutionLimits
  /** Required for `restricted`; must be absent for `open` and `none`. */
  bridge?: ExecutionBridgeSpec
}

export interface ExecutionProbe {
  available: boolean
  provider: ExecutionProviderKind
  platform: PlatformKey
  backend: ExecutionBackend
  enforcement: 'os-confinement' | 'unconfined' | 'unavailable'
  detail: string
  fix?: string
  capabilities: {
    processTreeKill: boolean
    outputBounds: boolean
    filesystemConfinement: boolean
    networkConfinement: boolean
    resourceLimits: boolean
    terminal: boolean
    landlockAbi: number | null
    helper: HelperCapability
  }
}

export interface ExecutionSessionFacts {
  provider: ExecutionProviderKind
  platform: PlatformKey
  backend: ExecutionBackend
  enforcement: EnforcementReport
  sessionId: string
  projectId: string
  shipId: string | null
  engineKind: string
  /** Confined engine PID when known, otherwise the direct child PID. */
  pid: number | null
  pids: number[]
  workdir: string
  engineHome: string
  tmpDir: string
  mode: ExecutionMode
  network: ExecutionNetworkPolicy
  bridgePort: number | null
  startedAt: string
  limitations: string[]
}

export type ExecutionEventType =
  | 'execution.session_prepared'
  | 'execution.session_started'
  | 'execution.session_exited'
  | 'execution.session_error'
  | 'execution.session_timeout'
  | 'execution.session_closed'
  | 'execution.denied'
  | 'execution.env_filtered'

export interface ExecutionEvent {
  type: ExecutionEventType
  at: string
  provider: ExecutionProviderKind
  sessionId: string
  projectId: string
  shipId: string | null
  engineKind: string
  pid?: number
  code?: number | null
  signal?: NodeJS.Signals | null
  detail?: string
  /** Environment variable NAMES that were dropped; never values. */
  names?: string[]
}

export interface ExecutionProcess extends AcpChild {
  readonly sessionId: string
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface ExecutionExecOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  input?: string
}

export interface ExecutionSession {
  readonly id: string
  readonly spec: ExecutionSessionSpec
  facts(): ExecutionSessionFacts
  spawn(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): ExecutionProcess
  exec(argv: string[], options?: ExecutionExecOptions): Promise<RunResult>
  close(): Promise<void>
}

export interface ExecutionProvider {
  readonly kind: ExecutionProviderKind
  probe(): Promise<ExecutionProbe>
  prepare(spec: ExecutionSessionSpec): Promise<ExecutionSession>
  listSessions(): ExecutionSessionFacts[]
  close(): Promise<void>
}

export type NativeSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    stdio: 'pipe'
    windowsHide: boolean
    detached: boolean
  },
) => AcpChild

/** Test seam for the helper process; production always uses the verified binary. */
export type HelperSpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    windowsHide: boolean
    detached: boolean
  },
) => AcpChild & { stdio?: Array<Readable | null> }

export interface NativeExecutionProviderOptions {
  rootDir: string
  /**
   * Additional canonical super-roots that session allowed roots may live under
   * (used for session workspaces outside the project root). The provider root
   * itself is always allowed; only these are added.
   */
  extraRoots?: string[]
  hostEnv?: Record<string, string | undefined>
  onEvent?: (event: ExecutionEvent) => void
  /** Direct-spawn seam for the `unconfined` backend. */
  spawnFn?: NativeSpawnFn
  /** Helper seam for the `landlock` backend. */
  helperSpawnFn?: HelperSpawnFn
  /** Test seam: precomputed capability report. */
  capabilities?: NativeCapabilities
  /** Test seam: explicit helper binary path. */
  helperPath?: string
  /** Test seam: replaces the platform process-tree killer. */
  killTreeFn?: (pid: number, signal: NodeJS.Signals) => Promise<void>
  now?: () => Date
  maxOutputBytes?: number
  /** Grace between SIGTERM and SIGKILL. Default 2s. */
  terminateGraceMs?: number
  /** Wall-clock bound for the whole execution session; 0 disables it. */
  sessionTimeoutMs?: number
  /** Bound on helper startup readiness. Default 15s. */
  helperReadyTimeoutMs?: number
  /** Host directory for per-session scratch/home state. */
  tmpRoot?: string
}

interface HelperRequest {
  helper_abi: number
  mode: 'read-only' | 'workspace-write'
  network: ExecutionNetworkPolicy
  cwd: string
  argv: string[]
  env: Record<string, string>
  read_roots: string[]
  write_roots: string[]
  exec_roots: string[]
  tmp_dir: string
  private_tmp: boolean
  bridge?: { unix_path: string; port: number }
  session_id: string
}

interface HelperReady {
  ready: boolean
  helperAbi?: number
  version?: string
  sessionId?: string
  pid?: number
  bridgePort?: number | null
  error?: string
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_TERMINATE_GRACE_MS = 2_000
const DEFAULT_HELPER_READY_TIMEOUT_MS = 15_000
const MAX_EVENT_DETAIL_CHARS = 1_000
const MAX_READY_LINE_BYTES = 64 * 1024

/** Platform/runtime variables a Node CLI needs; never credentials. */
const SAFE_ENV_KEYS: ReadonlySet<string> = new Set([
  ...PLATFORM_ENV_KEEP,
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'COLORTERM',
  'TERM_PROGRAM',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read-only system locations a process needs to load libraries, resolve
 * locales and execute standard tools. These are read/execute roots only; they
 * are never writable.
 */
const SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/opt',
  '/sys',
  '/run',
  '/nix/store',
  '/snap',
] as const

const SYSTEM_EXEC_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/opt',
  '/nix/store',
] as const

function bounded(text: string, max = MAX_EVENT_DETAIL_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Node engine overrides (.js/.mjs/.cjs) are read, not executed, by the
 * runtime. Their imports can live anywhere in the containing package, so the
 * nearest package root is the smallest root that keeps the engine loadable.
 * Falls back to the script's own directory when no package.json exists.
 */
function engineScriptRoot(script: string): string {
  const entryDir = dirname(realExisting(script))
  let candidate = entryDir
  for (;;) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return entryDir
    candidate = parent
  }
}

/**
 * Decode captured bytes without allowing UTF-8 replacement characters to
 * expand the result past the configured byte cap. When the cap cuts a
 * multibyte sequence, trim the partial sequence before decoding; the fallback
 * also bounds malformed child output that decodes with replacement characters.
 */
function decodeUtf8Bounded(chunks: Buffer[], maxBytes: number): string {
  const buffer = Buffer.concat(chunks)
  let cut = Math.min(buffer.length, maxBytes)
  if (cut > 0) {
    let start = cut - 1
    while (start > 0 && ((buffer[start] as number) & 0xc0) === 0x80) start -= 1
    const lead = buffer[start] as number
    const sequenceBytes = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
    if (start + sequenceBytes > cut) cut = start
  }
  const decoded = buffer.subarray(0, cut).toString('utf8')
  if (Buffer.byteLength(decoded, 'utf8') <= maxBytes) return decoded

  let bytes = 0
  let end = 0
  for (const char of decoded) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += char.length
  }
  return decoded.slice(0, end)
}

function realExisting(path: string): string {
  return realpathSync.native(path)
}

function ensureDir(path: string, mode?: number): void {
  mkdirSync(path, { recursive: true, ...(mode !== undefined ? { mode } : {}) })
  if (!statSync(path).isDirectory()) {
    throw new PolicyDeniedError(`native execution path is not a directory: ${path}`)
  }
}

function existingDirs(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  })
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function defaultSpawn(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    stdio: 'pipe'
    windowsHide: boolean
    detached: boolean
  },
): AcpChild {
  return nodeSpawn(command, args, options) as unknown as AcpChild
}

function defaultHelperSpawn(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string>
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    windowsHide: boolean
    detached: boolean
  },
): AcpChild & { stdio?: Array<Readable | null> } {
  return nodeSpawn(command, args, options) as unknown as AcpChild & { stdio?: Array<Readable | null> }
}

async function defaultKillTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') {
    // taskkill /T is the only reliable tree kill available without a native
    // addon; /F is intentional because Windows has no meaningful SIGTERM.
    await new Promise<void>((resolveKill) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolveKill()
      }
      const child = nodeSpawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Best effort; the direct-child fallback below still runs.
        }
        finish()
      }, 4_000)
      timer.unref()
      child.once('error', finish)
      child.once('exit', finish)
    })
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The parent may already be gone; that is the desired state.
    }
    return
  }
  // POSIX: detached sessions are process-group leaders, so negative pid
  // reaches every descendant that stayed in the group.
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

interface ProcessRecord {
  child: AcpChild & { stdio?: Array<Readable | null> }
  /** PID used for group termination: helper process or direct child. */
  killPid: number | undefined
  /** PID reported to callers: confined engine when ready, else the child. */
  reportPid: number | undefined
  finished: boolean
  ready: boolean
  readySettled: boolean
  errorMessage: string | null
  escalationTimer: NodeJS.Timeout | null
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  resolveExit: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
  requestPath: string | null
  bridgePort: number | null
}

class NativeProcessHandle implements ExecutionProcess {
  readonly sessionId: string
  private readonly record: ProcessRecord
  private readonly session: NativeExecutionSession

  constructor(record: ProcessRecord, session: NativeExecutionSession) {
    this.record = record
    this.session = session
    this.sessionId = session.id
  }

  get pid(): number | undefined {
    return this.record.reportPid ?? this.record.killPid
  }

  get stdin() {
    return this.record.child.stdin
  }

  get stdout() {
    return this.record.child.stdout
  }

  get stderr() {
    return this.record.child.stderr
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    return this.session.killRecord(this.record, signal)
  }

  on(event: 'spawn', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: string, listener: (...args: never[]) => void): unknown {
    return (this.record.child.on as (event: string, listener: (...args: never[]) => void) => unknown)(
      event,
      listener,
    )
  }

  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.record.exitPromise
  }

  /** @internal */
  processRecord(): ProcessRecord {
    return this.record
  }
}

export class NativeExecutionProvider implements ExecutionProvider {
  readonly kind = 'native' as const
  private readonly opts: NativeExecutionProviderOptions
  private readonly rootReal: string
  /** Canonical super-roots every allowed root must be inside of. */
  private readonly allowedRootReals: string[]
  private readonly hostEnv: Record<string, string | undefined>
  private readonly sessions = new Set<NativeExecutionSession>()
  private readonly maxOutputBytes: number
  private readonly terminateGraceMs: number
  private readonly sessionTimeoutMs: number
  private readonly helperReadyTimeoutMs: number
  private readonly platform: PlatformKey
  private readonly tmpRoot: string
  private capabilitiesCache: NativeCapabilities | null = null
  private closed = false

  constructor(opts: NativeExecutionProviderOptions) {
    this.opts = opts
    this.platform = platformKey()
    if (!existsSync(opts.rootDir) || !statSync(opts.rootDir).isDirectory()) {
      throw new PolicyDeniedError(`native execution root is not an existing directory: ${opts.rootDir}`)
    }
    this.rootReal = realExisting(opts.rootDir)
    this.allowedRootReals = [this.rootReal]
    if (opts.extraRoots !== undefined) {
      for (const extra of opts.extraRoots) {
        if (!existsSync(extra) || !statSync(extra).isDirectory()) {
          throw new PolicyDeniedError(`native execution extra root is not an existing directory: ${extra}`)
        }
        const canonical = realExisting(extra)
        if (!this.allowedRootReals.includes(canonical)) this.allowedRootReals.push(canonical)
      }
    }
    this.hostEnv = opts.hostEnv ?? (process.env as Record<string, string | undefined>)
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.terminateGraceMs = opts.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 0
    this.helperReadyTimeoutMs = opts.helperReadyTimeoutMs ?? DEFAULT_HELPER_READY_TIMEOUT_MS
    this.tmpRoot = resolve(opts.tmpRoot ?? join(this.rootReal, '.pluton', 'tmp', 'sessions'))
    if (!Number.isFinite(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new ValidationError('native maxOutputBytes must be positive')
    }
    if (!Number.isFinite(this.terminateGraceMs) || this.terminateGraceMs < 0) {
      throw new ValidationError('native terminateGraceMs must be >= 0')
    }
    if (!Number.isFinite(this.sessionTimeoutMs) || this.sessionTimeoutMs < 0) {
      throw new ValidationError('native sessionTimeoutMs must be >= 0')
    }
    if (!Number.isFinite(this.helperReadyTimeoutMs) || this.helperReadyTimeoutMs <= 0) {
      throw new ValidationError('native helperReadyTimeoutMs must be positive')
    }
    ensureDir(this.tmpRoot, 0o700)
    const tmpReal = realExisting(this.tmpRoot)
    if (!isInside(this.rootReal, tmpReal)) {
      throw new PolicyDeniedError(
        `native tmp root '${tmpReal}' is outside the provider root '${this.rootReal}'`,
      )
    }
    this.tmpRoot = tmpReal
  }

  /** Detect once; helper probing spawns a short-lived process. */
  capabilities(): NativeCapabilities {
    if (this.capabilitiesCache === null) {
      this.capabilitiesCache = this.opts.capabilities ?? detectCapabilities()
    }
    return this.capabilitiesCache
  }

  private helperPath(): string | null {
    if (this.platform !== 'linux') return null
    if (this.opts.helperPath !== undefined) return this.opts.helperPath
    const target = helperTargetFor(this.platform, process.arch)
    if (target === null) return null
    return helperPathFor(target)
  }

  async probe(): Promise<ExecutionProbe> {
    const caps = this.capabilities()
    const helper = caps.helper
    // `prepare()` refuses confined modes unless user, mount and PID namespaces
    // are proven. The probe must not claim more than prepare can deliver: a
    // helper with no namespaces is not OS confinement.
    const namespaceConfinement =
      caps.userNamespaces && caps.mountNamespaces && caps.pidNamespaces
    const confined =
      this.platform === 'linux' &&
      helper.available &&
      (caps.landlockAbi ?? 0) >= 3 &&
      namespaceConfinement
    // Network confinement is a separate capability: `open` policies do not
    // need a network namespace, and a host may prove filesystem confinement
    // without proving `unshare -Urn`.
    const networkConfinement = confined && caps.networkNamespaces
    const backend: ExecutionBackend = this.closed ? 'unavailable' : confined ? 'landlock' : 'unconfined'
    let detail: string
    let fix: string | undefined
    if (this.closed) {
      detail = 'native execution provider is closed'
      fix = 'create a new native execution provider'
    } else if (this.platform === 'linux' && confined) {
      detail =
        `native Linux confinement: verified landlock-run ${String(helper.version)} (Landlock ABI ${String(caps.landlockAbi)}) ` +
        'enforces filesystem access and private mount/PID namespaces with a per-session tmpfs; ' +
        (networkConfinement
          ? 'network namespaces are available for restricted/none policies; '
          : 'network namespaces are unavailable, so network access is never confined; ') +
        'CPU/memory limits are recorded but not cgroup-enforced'
    } else if (this.platform === 'linux') {
      const reasons: string[] = []
      if (!helper.available) reasons.push(helper.detail ?? 'the verified native helper is unavailable')
      if ((caps.landlockAbi ?? 0) < 3) {
        reasons.push(`Landlock ABI 3 or newer is required (reported: ${String(caps.landlockAbi)})`)
      }
      if (!namespaceConfinement) {
        reasons.push('unprivileged user, mount and PID namespaces are unavailable')
      }
      detail =
        `native Linux confinement is unavailable (${reasons.join('; ')}); ` +
        'only mode unconfined with network_policy open can run, and confined policies fail closed'
      fix =
        'install the verified landlock-run helper for this architecture, enable unprivileged ' +
        'namespaces, or explicitly choose unconfined'
    } else {
      detail =
        `native execution on ${this.platform} supports only mode unconfined with network_policy open; ` +
        'no verified filesystem or network confinement implementation exists for this platform'
      fix = 'run confined work on Linux, or acknowledge_unconfined for desktop development'
    }
    return {
      available: !this.closed,
      provider: 'native',
      platform: this.platform,
      backend,
      enforcement: this.closed ? 'unavailable' : confined ? 'os-confinement' : 'unconfined',
      detail,
      ...(fix !== undefined ? { fix } : {}),
      capabilities: {
        processTreeKill: true,
        outputBounds: true,
        filesystemConfinement: confined,
        networkConfinement,
        resourceLimits: false,
        terminal: false,
        landlockAbi: caps.landlockAbi,
        helper,
      },
    }
  }

  async prepare(spec: ExecutionSessionSpec): Promise<NativeExecutionSession> {
    this.assertOpen()
    const normalized = this.validateSpec(spec)
    const policy: EffectiveExecutionPolicy = {
      platform: this.platform,
      mode: normalized.mode,
      network: normalized.network,
    }
    const caps = this.capabilities()
    assertPolicySupported(policy, caps)

    if (normalized.mode !== 'unconfined') {
      if (!caps.mountNamespaces || !caps.userNamespaces || !caps.pidNamespaces) {
        throw new SandboxUnavailableError(
          'native confinement requires unprivileged user, mount and PID namespaces on this host',
          { fix: 'enable unprivileged namespaces, or explicitly choose mode unconfined' },
        )
      }
      const path = this.helperPath()
      if (path === null || !existsSync(path)) {
        throw new SandboxUnavailableError(
          `native helper is not available at ${path ?? '(no target)'}`,
          { fix: 'install the verified landlock-run helper for this platform/architecture' },
        )
      }
      if (normalized.network === 'restricted') {
        const bridge = normalized.bridge
        if (bridge === undefined) {
          throw new PolicyDeniedError(
            `native network_policy 'restricted' for ship '${normalized.shipId ?? '(none)'}' requires ` +
              'the session tool bridge AF_UNIX endpoint; refusing to start without a loopback bridge',
          )
        }
        if (!existsSync(bridge.unixPath)) {
          throw new PolicyDeniedError(`native bridge socket does not exist: ${bridge.unixPath}`)
        }
        let mode: number
        try {
          mode = statSync(bridge.unixPath).mode
        } catch (error) {
          throw new PolicyDeniedError(
            `native bridge socket is unreadable: ${bridge.unixPath}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if ((mode & 0o170000) !== 0o140000) {
          throw new PolicyDeniedError(`native bridge endpoint is not a socket: ${bridge.unixPath}`)
        }
      }
    } else if (normalized.bridge !== undefined) {
      throw new PolicyDeniedError('unconfined native sessions cannot use a restricted loopback bridge')
    }

    const session = new NativeExecutionSession(this, normalized)
    this.sessions.add(session)
    session.emit({
      type: 'execution.session_prepared',
      detail: `mode=${normalized.mode}; network=${normalized.network}; backend=${session.backend}`,
    })
    return session
  }

  listSessions(): ExecutionSessionFacts[] {
    return [...this.sessions].map((session) => session.facts())
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const sessions = [...this.sessions]
    await Promise.allSettled(sessions.map((session) => session.close()))
    this.sessions.clear()
  }

  /** @internal used by a session when it closes itself. */
  forget(session: NativeExecutionSession): void {
    this.sessions.delete(session)
  }

  /** @internal */
  emit(event: Omit<ExecutionEvent, 'at' | 'provider'> & Partial<Pick<ExecutionEvent, 'at' | 'provider'>>): void {
    const full: ExecutionEvent = {
      at: (this.opts.now ?? (() => new Date()))().toISOString(),
      provider: 'native',
      ...event,
    }
    try {
      this.opts.onEvent?.(full)
    } catch {
      // Observers are diagnostics; they must never break execution.
    }
  }

  /** @internal */
  spawnDirect(command: string, args: string[], cwd: string, env: Record<string, string>): AcpChild {
    const spawnFn = this.opts.spawnFn ?? defaultSpawn
    return spawnFn(command, args, {
      cwd,
      env,
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
  }

  /** @internal */
  spawnHelper(command: string, args: string[], cwd: string): AcpChild & { stdio?: Array<Readable | null> } {
    const spawnFn = this.opts.helperSpawnFn ?? defaultHelperSpawn
    // The helper is a static binary. It receives no host environment: every
    // value the engine needs travels in the signed request document.
    return spawnFn(command, args, {
      cwd,
      env: {},
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
  }

  /** @internal */
  killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
    if (this.opts.killTreeFn !== undefined) return this.opts.killTreeFn(pid, signal)
    return defaultKillTree(pid, signal)
  }

  /** @internal */
  get graceMs(): number {
    return this.terminateGraceMs
  }

  /** @internal */
  get defaultMaxOutputBytes(): number {
    return this.maxOutputBytes
  }

  /** @internal */
  get configuredSessionTimeoutMs(): number {
    return this.sessionTimeoutMs
  }

  /** @internal */
  get helperReadyMs(): number {
    return this.helperReadyTimeoutMs
  }

  /** @internal */
  get rootRealPath(): string {
    return this.rootReal
  }

  /** @internal */
  get environment(): Record<string, string | undefined> {
    return this.hostEnv
  }

  /** @internal */
  get platformKey(): PlatformKey {
    return this.platform
  }

  /** @internal */
  get scratchRoot(): string {
    return this.tmpRoot
  }

  /** @internal */
  helperBinaryPath(): string | null {
    return this.helperPath()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ExecutionClosedError('provider')
    }
  }

  private validateSpec(spec: ExecutionSessionSpec): ExecutionSessionSpec {
    if (spec.allowedRoots.length === 0) {
      throw new PolicyDeniedError('native execution requires at least one allowed root')
    }
    if (spec.mode !== 'read-only' && spec.mode !== 'workspace-write' && spec.mode !== 'unconfined') {
      throw new ValidationError(`native execution mode '${String(spec.mode)}' is not supported`)
    }
    if (spec.network !== 'open' && spec.network !== 'restricted' && spec.network !== 'none') {
      throw new ValidationError(`native network policy '${String(spec.network)}' is not supported`)
    }
    if (spec.mode === 'unconfined' && spec.network !== 'open') {
      throw new PolicyDeniedError(
        `native execution mode 'unconfined' cannot enforce network_policy '${spec.network}': ` +
          'an unconfined process shares the host network. Use network_policy: open explicitly.',
      )
    }
    if (!Number.isFinite(spec.limits.cpus) || spec.limits.cpus <= 0) {
      throw new ValidationError('native execution limits.cpus must be positive')
    }
    if (!Number.isInteger(spec.limits.memoryMb) || spec.limits.memoryMb <= 0) {
      throw new ValidationError('native execution limits.memoryMb must be a positive integer')
    }
    if (!Number.isInteger(spec.limits.pids) || spec.limits.pids <= 0) {
      throw new ValidationError('native execution limits.pids must be a positive integer')
    }

    const roots: string[] = []
    for (const root of spec.allowedRoots) {
      if (!isAbsolute(root)) throw new PolicyDeniedError(`native allowed root must be absolute: ${root}`)
      const abs = resolve(root)
      if (abs === parse(abs).root) {
        throw new PolicyDeniedError(`native allowed root must not be a filesystem root: ${abs}`)
      }
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        throw new PolicyDeniedError(`native allowed root does not exist: ${abs}`)
      }
      const real = realExisting(abs)
      if (!this.allowedRootReals.some((root) => isInside(root, real))) {
        throw new PolicyDeniedError(
          `native allowed root '${real}' is outside the provider roots [${this.allowedRootReals.join(', ')}]`,
        )
      }
      roots.push(real)
    }

    if (!isAbsolute(spec.hostWorkdir)) {
      throw new PolicyDeniedError(`native workdir must be absolute: ${spec.hostWorkdir}`)
    }
    const workdirAbs = resolve(spec.hostWorkdir)
    if (!existsSync(workdirAbs) || !statSync(workdirAbs).isDirectory()) {
      throw new PolicyDeniedError(`native workdir does not exist: ${workdirAbs}`)
    }
    const workdir = realExisting(workdirAbs)
    if (!roots.some((root) => isInside(root, workdir))) {
      throw new PolicyDeniedError(
        `native workdir '${workdir}' is outside the allowed roots [${roots.join(', ')}]`,
      )
    }

    if (!isAbsolute(spec.hostEngineHome)) {
      throw new PolicyDeniedError(`native engine home must be absolute: ${spec.hostEngineHome}`)
    }
    ensureDir(spec.hostEngineHome)
    const engineHome = realExisting(spec.hostEngineHome)
    if (!roots.some((root) => isInside(root, engineHome))) {
      throw new PolicyDeniedError(
        `native engine home '${engineHome}' is outside the allowed roots [${roots.join(', ')}]`,
      )
    }

    for (const [key, value] of Object.entries(spec.env)) {
      if (!ENV_NAME_RE.test(key)) throw new ValidationError(`invalid native env name '${key}'`)
      if (value.includes('\u0000')) throw new ValidationError(`native env '${key}' contains NUL`)
    }

    return {
      ...spec,
      shipId: spec.shipId !== undefined ? spec.shipId : (spec.museId ?? null),
      hostWorkdir: workdir,
      hostEngineHome: engineHome,
      allowedRoots: roots,
      env: { ...spec.env },
      ...(spec.bridge !== undefined
        ? {
            bridge: {
              unixPath: resolve(spec.bridge.unixPath),
              port: spec.bridge.port,
            },
          }
        : {}),
    }
  }
}

class NativeExecutionSession implements ExecutionSession {
  readonly id: string
  readonly spec: ExecutionSessionSpec
  readonly backend: Exclude<ExecutionBackend, 'unavailable'>
  private readonly provider: NativeExecutionProvider
  private readonly records = new Set<ProcessRecord>()
  private readonly startedAt: string
  private readonly tmpDir: string
  private readonly enforcement: EnforcementReport
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private timedOut = false

  constructor(provider: NativeExecutionProvider, spec: ExecutionSessionSpec) {
    this.provider = provider
    this.id = newId('session')
    this.spec = spec
    this.startedAt = new Date().toISOString()
    this.backend = spec.mode === 'unconfined' ? 'unconfined' : 'landlock'
    this.tmpDir = join(provider.scratchRoot, this.id)
    ensureDir(this.tmpDir, 0o700)
    this.enforcement = enforcementFor(
      { platform: provider.platformKey, mode: spec.mode, network: spec.network },
      provider.capabilities(),
    )
  }

  facts(): ExecutionSessionFacts {
    const pids = [...this.records]
      .filter((record) => !record.finished)
      .map((record) => record.reportPid ?? record.killPid)
      .filter((pid): pid is number => pid !== undefined)
    return {
      provider: 'native',
      platform: this.provider.platformKey,
      backend: this.backend,
      enforcement: this.enforcement,
      sessionId: this.id,
      projectId: this.spec.projectId,
      shipId: this.spec.shipId ?? null,
      engineKind: this.spec.engineKind,
      pid: pids[0] ?? null,
      pids,
      workdir: this.spec.hostWorkdir,
      engineHome: this.spec.hostEngineHome,
      tmpDir: this.tmpDir,
      mode: this.spec.mode,
      network: this.spec.network,
      bridgePort: this.spec.bridge?.port ?? null,
      startedAt: this.startedAt,
      limitations: [...this.enforcement.limitations],
    }
  }

  spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): ExecutionProcess {
    return this.start(command, args, options).handle
  }

  async exec(argv: string[], options: ExecutionExecOptions = {}): Promise<RunResult> {
    if (argv.length === 0) throw new ValidationError('native exec requires a non-empty argv')
    const maxOutputBytes = options.maxOutputBytes ?? this.provider.defaultMaxOutputBytes
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new ValidationError('native exec maxOutputBytes must be a positive integer')
    }
    const started = Date.now()
    const { handle, record } = this.start(argv[0] as string, argv.slice(1), {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const capture = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
      if (currentBytes >= maxOutputBytes) {
        truncated = true
        return currentBytes
      }
      const remaining = maxOutputBytes - currentBytes
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        return currentBytes + chunk.length
      }
      chunks.push(chunk.subarray(0, remaining))
      truncated = true
      return maxOutputBytes
    }

    const resultPromise = new Promise<RunResult>((resolveResult) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        if (timeout !== null) clearTimeout(timeout)
        if (forceFinish !== null) clearTimeout(forceFinish)
        let stdout = decodeUtf8Bounded(stdoutChunks, maxOutputBytes)
        let stderr = decodeUtf8Bounded(stderrChunks, maxOutputBytes)
        if (record.errorMessage !== null) {
          stderr = stderr === '' ? record.errorMessage : `${stderr}\n${record.errorMessage}`
        }
        if (timedOut) {
          stderr = stderr === '' ? 'native exec timed out' : `${stderr}\nnative exec timed out`
        }
        resolveResult({
          argv: [...argv],
          exitCode: code,
          timedOut,
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - started,
        })
      }

      let timeout: NodeJS.Timeout | null = null
      let forceFinish: NodeJS.Timeout | null = null
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true
          this.emit({
            type: 'execution.session_timeout',
            detail: `exec timed out after ${String(options.timeoutMs)}ms`,
          })
          void this.terminate(record, 'SIGKILL')
          forceFinish = setTimeout(() => finish(null, null), 2_000)
          forceFinish.unref()
        }, options.timeoutMs)
        timeout.unref()
      }

      const stdoutStream = handle.stdout
      const stderrStream = handle.stderr
      stdoutStream?.on('data', (chunk: Buffer | string) => {
        stdoutBytes = capture(stdoutChunks, stdoutBytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stderrStream?.on('data', (chunk: Buffer | string) => {
        stderrBytes = capture(stderrChunks, stderrBytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })

      void handle.waitForExit().then((exit) => finish(exit.code, exit.signal))

      if (handle.stdin !== null) {
        if (options.input !== undefined) handle.stdin.write(options.input)
        handle.stdin.end()
      }
    })

    return resultPromise
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const live = [...this.records].filter((record) => !record.finished)
    await Promise.all(live.map((record) => this.terminate(record, 'SIGTERM')))
    await this.waitForRecords(live, this.provider.graceMs + 250)
    const survivors = live.filter((record) => !record.finished)
    await Promise.all(survivors.map((record) => this.terminate(record, 'SIGKILL')))
    await this.waitForRecords(survivors, 2_000)
    this.records.clear()
    try {
      rmSync(this.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Best-effort cleanup on platforms where process termination takes extra time to release locks.
    }
    this.emit({ type: 'execution.session_closed', detail: 'session closed; live process trees terminated' })
    this.provider.forget(this)
  }

  /** @internal */
  killRecord(record: ProcessRecord, signal?: NodeJS.Signals | number): boolean {
    if (record.finished) return false
    if (typeof signal === 'number') {
      try {
        record.child.kill(signal)
      } catch {
        // Already gone.
      }
      return true
    }
    void this.terminate(record, signal ?? 'SIGTERM')
    return true
  }

  /** @internal */
  emit(event: Omit<ExecutionEvent, 'at' | 'provider' | 'sessionId' | 'projectId' | 'shipId' | 'engineKind'>): void {
    this.provider.emit({
      ...event,
      sessionId: this.id,
      projectId: this.spec.projectId,
      shipId: this.spec.shipId ?? null,
      engineKind: this.spec.engineKind,
    })
  }

  private assertUsable(): void {
    if (this.closed) throw new ExecutionClosedError(this.id)
    if (this.timedOut) {
      throw new ExecutionTimeoutError(this.id, this.provider.configuredSessionTimeoutMs)
    }
  }

  private start(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> },
  ): { handle: NativeProcessHandle; record: ProcessRecord } {
    this.assertUsable()
    if (typeof command !== 'string' || command.trim() === '') {
      throw new ValidationError('native spawn requires a non-empty command')
    }
    if (!isAbsolute(command)) {
      throw new PolicyDeniedError(
        `native spawn requires an absolute command path (got '${command}'): ` +
          'PATH lookup is not performed so the confined binary is unambiguous',
      )
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new ValidationError('native spawn requires an argv array of strings')
    }
    const cwd = this.validateCwd(options.cwd ?? this.spec.hostWorkdir)
    const env = this.resolveEnv(options.env ?? {})

    let child: AcpChild & { stdio?: Array<Readable | null> }
    let requestPath: string | null = null
    try {
      if (this.backend === 'landlock') {
        const request = this.buildHelperRequest(command, args, cwd, env)
        requestPath = join(this.tmpDir, `request-${newId('request')}.json`)
        writeFileSync(requestPath, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 })
        const binary = this.provider.helperBinaryPath()
        if (binary === null) {
          throw new PolicyDeniedError('native helper binary is missing; refusing to spawn')
        }
        child = this.provider.spawnHelper(binary, ['run', requestPath], this.spec.hostWorkdir)
      } else {
        child = this.provider.spawnDirect(command, args, cwd, env) as AcpChild & {
          stdio?: Array<Readable | null>
        }
      }
    } catch (error) {
      if (requestPath !== null) rmSync(requestPath, { force: true })
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'execution.session_error', detail: bounded(message) })
      throw error
    }

    let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        resolveExit = resolvePromise
      },
    )
    const record: ProcessRecord = {
      child,
      killPid: child.pid,
      reportPid: this.backend === 'unconfined' ? child.pid : undefined,
      finished: false,
      ready: this.backend === 'unconfined',
      readySettled: this.backend === 'unconfined',
      errorMessage: null,
      escalationTimer: null,
      exitPromise,
      resolveExit,
      requestPath,
      bridgePort: this.backend === 'unconfined' ? (this.spec.bridge?.port ?? null) : null,
    }
    this.records.add(record)
    this.armTimer()

    child.on('spawn', () => {
      record.killPid = child.pid ?? record.killPid
      if (this.backend === 'unconfined') {
        record.reportPid = child.pid ?? record.reportPid
        this.emit({
          type: 'execution.session_started',
          ...(record.reportPid !== undefined ? { pid: record.reportPid } : {}),
          ...(child.pid !== undefined ? { detail: `backend=unconfined; network=host` } : {}),
        })
      }
    })
    child.on('error', (error) => {
      record.errorMessage = error.message
      this.emit({ type: 'execution.session_error', detail: bounded(error.message) })
      this.finishRecord(record, null, null)
    })
    child.on('exit', (code, signal) => {
      this.finishRecord(record, code, signal)
    })

    if (this.backend === 'landlock') {
      void this.watchHelperReadiness(record)
    }

    return { handle: new NativeProcessHandle(record, this), record }
  }

  private async watchHelperReadiness(record: ProcessRecord): Promise<void> {
    const stream = record.child.stdio?.[3] ?? null
    if (stream === null) {
      this.recordHelperFailure(record, 'native helper did not provide a readiness pipe on fd 3')
      return
    }
    let line: string
    try {
      line = await readLineWithTimeout(stream, this.provider.helperReadyMs)
    } catch (error) {
      this.recordHelperFailure(record, error instanceof Error ? error.message : String(error))
      return
    }
    if (record.finished || record.readySettled) return
    let parsed: HelperReady
    try {
      parsed = JSON.parse(line) as HelperReady
    } catch {
      this.recordHelperFailure(record, `native helper wrote an invalid readiness line: ${bounded(line, 200)}`)
      return
    }
    if (parsed.ready !== true) {
      this.recordHelperFailure(record, parsed.error ?? 'native helper refused to start the confined process')
      return
    }
    if (parsed.helperAbi !== HELPER_ABI) {
      this.recordHelperFailure(
        record,
        `native helper ABI ${String(parsed.helperAbi)} is not supported (expected ${String(HELPER_ABI)})`,
      )
      return
    }
    if (parsed.sessionId !== this.id) {
      this.recordHelperFailure(
        record,
        `native helper readiness session mismatch: got '${String(parsed.sessionId)}', expected '${this.id}'`,
      )
      return
    }
    if (typeof parsed.pid !== 'number' || parsed.pid <= 0) {
      this.recordHelperFailure(record, 'native helper reported no confined engine pid')
      return
    }
    const expectedBridge = this.spec.bridge?.port ?? null
    const reportedBridge = parsed.bridgePort ?? null
    if (expectedBridge !== reportedBridge) {
      this.recordHelperFailure(
        record,
        `native bridge readiness mismatch: expected port ${String(expectedBridge)}, got ${String(reportedBridge)}`,
      )
      return
    }
    record.readySettled = true
    record.ready = true
    record.bridgePort = reportedBridge
    this.cleanupRequest(record)
    // The helper's readiness PID is in the host PID namespace, even though the
    // engine itself is PID 1 inside its own PID namespace.
    record.reportPid = parsed.pid
    this.emit({
      type: 'execution.session_started',
      pid: parsed.pid,
      detail:
        `backend=landlock; helper=${String(parsed.version ?? 'unknown')}; ` +
        `mode=${this.spec.mode}; network=${this.spec.network}` +
        (reportedBridge !== null ? `; bridge=127.0.0.1:${String(reportedBridge)}` : ''),
    })
  }

  private recordHelperFailure(record: ProcessRecord, message: string): void {
    if (record.readySettled) return
    record.readySettled = true
    record.errorMessage = message
    this.cleanupRequest(record)
    this.emit({ type: 'execution.session_error', detail: bounded(message) })
  }

  private cleanupRequest(record: ProcessRecord): void {
    if (record.requestPath === null) return
    const path = record.requestPath
    record.requestPath = null
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort: the session tmp directory is removed on close.
    }
  }

  private buildHelperRequest(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): HelperRequest {
    const caps = this.provider.capabilities()
    const systemRead = existingDirs(SYSTEM_READ_ROOTS)
    const systemExec = existingDirs(SYSTEM_EXEC_ROOTS)
    const commandDir = existsSync(command) ? dirname(realExisting(command)) : dirname(resolve(command))
    // A .js/.mjs/.cjs engine override is executed by Node with the script as
    // argv[0]; the confined runtime must be able to read the script and its
    // package imports. Only this trusted engine entry is added, never
    // arbitrary argument paths.
    const scriptArg = args[0]
    const entryRoot =
      scriptArg !== undefined &&
      isAbsolute(scriptArg) &&
      /\.(?:m?js|cjs)$/i.test(scriptArg) &&
      existsSync(scriptArg) &&
      statSync(scriptArg).isFile()
        ? engineScriptRoot(scriptArg)
        : null

    const readRoots = dedupe([
      ...this.spec.allowedRoots,
      ...caps.runtimeRoots.filter((root) => existsSync(root)),
      ...systemRead,
      ...(entryRoot !== null ? [entryRoot] : []),
    ])
    const execRoots = dedupe([
      ...systemExec,
      ...caps.runtimeRoots.filter((root) => existsSync(root)),
      commandDir,
      this.spec.hostEngineHome,
    ])
    const writeRoots =
      this.spec.mode === 'workspace-write'
        ? dedupe([this.spec.hostWorkdir, this.spec.hostEngineHome, this.tmpDir])
        : [this.tmpDir]

    // A private tmpfs over /tmp would hide any session path that legitimately
    // lives there (e.g. a project created under the system temp directory).
    // Landlock still grants no access to /tmp paths outside the declared
    // roots; deferring the tmpfs mount only avoids hiding allowed content.
    const sessionPaths = dedupe([cwd, ...readRoots, ...writeRoots])
    const privateTmp =
      caps.mountNamespaces &&
      this.spec.mode !== 'unconfined' &&
      !sessionPaths.some((root) => isInside('/tmp', root))

    return {
      helper_abi: HELPER_ABI,
      mode: this.spec.mode === 'read-only' ? 'read-only' : 'workspace-write',
      network: this.spec.network,
      cwd,
      argv: [command, ...args],
      env,
      read_roots: readRoots,
      write_roots: writeRoots,
      exec_roots: execRoots,
      tmp_dir: this.tmpDir,
      private_tmp: privateTmp,
      ...(this.spec.network === 'restricted' && this.spec.bridge !== undefined
        ? { bridge: { unix_path: this.spec.bridge.unixPath, port: this.spec.bridge.port } }
        : {}),
      session_id: this.id,
    }
  }

  private validateCwd(candidate: string): string {
    if (!isAbsolute(candidate)) {
      throw new PolicyDeniedError(`native process cwd must be absolute: ${candidate}`)
    }
    const abs = resolve(candidate)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new PolicyDeniedError(`native process cwd does not exist: ${abs}`)
    }
    const real = realExisting(abs)
    if (!this.spec.allowedRoots.some((root) => isInside(root, real))) {
      this.emit({ type: 'execution.denied', detail: `cwd outside allowed roots: ${real}` })
      throw new PolicyDeniedError(
        `native process cwd '${real}' is outside the allowed roots [${this.spec.allowedRoots.join(', ')}]`,
      )
    }
    return real
  }

  private resolveEnv(caller: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {}
    const safeKeys = new Set<string>(SAFE_ENV_KEYS)
    for (const key of SAFE_ENV_KEYS) {
      const value = this.provider.environment[key]
      if (value !== undefined && value !== '') resolved[key] = value
    }
    for (const [key, value] of Object.entries(this.spec.env)) {
      resolved[key] = value
    }
    const allowed = new Set([...safeKeys, ...Object.keys(this.spec.env)])
    const filtered: string[] = []
    for (const [key, value] of Object.entries(caller)) {
      if (!allowed.has(key)) {
        filtered.push(key)
        continue
      }
      resolved[key] = value
    }
    if (filtered.length > 0) {
      this.emit({ type: 'execution.env_filtered', names: [...new Set(filtered)].sort() })
    }

    // Session-scoped scratch always wins: a confined process must never be
    // asked to write the host temp directory, and `restricted` sessions have no
    // filesystem route to it. HOME stays the engine home (private config/auth
    // is read from there); read-only sessions redirect caches to the tmpfs.
    resolved['TMPDIR'] = this.tmpDir
    if (process.platform === 'win32') {
      resolved['TMP'] = this.tmpDir
      resolved['TEMP'] = this.tmpDir
    }
    if (this.spec.mode === 'read-only') {
      resolved['XDG_CACHE_HOME'] = join(this.tmpDir, 'cache')
      resolved['XDG_STATE_HOME'] = join(this.tmpDir, 'state')
      resolved['XDG_RUNTIME_DIR'] = join(this.tmpDir, 'run')
    }
    return resolved
  }

  private armTimer(): void {
    if (this.timer !== null) return
    const timeoutMs = this.provider.configuredSessionTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.onTimeout()
    }, timeoutMs)
    this.timer.unref()
  }

  private async onTimeout(): Promise<void> {
    if (this.closed || this.timedOut) return
    this.timedOut = true
    this.emit({
      type: 'execution.session_timeout',
      detail: `session timed out after ${String(this.provider.configuredSessionTimeoutMs)}ms`,
    })
    const live = [...this.records].filter((record) => !record.finished)
    await Promise.all(live.map((record) => this.terminate(record, 'SIGKILL')))
    await this.waitForRecords(live, 2_000)
  }

  private async terminate(record: ProcessRecord, signal: NodeJS.Signals): Promise<void> {
    if (record.finished) return
    if (record.escalationTimer !== null && signal !== 'SIGKILL') return
    const pid = record.killPid
    if (pid === undefined) {
      try {
        record.child.kill(signal)
      } catch {
        // Already gone.
      }
      return
    }
    if (signal === 'SIGKILL') {
      if (record.escalationTimer !== null) {
        clearTimeout(record.escalationTimer)
        record.escalationTimer = null
      }
      await this.provider.killTree(pid, 'SIGKILL')
      return
    }
    await this.provider.killTree(pid, signal)
    if (record.finished) return
    const timer = setTimeout(() => {
      record.escalationTimer = null
      if (!record.finished && record.killPid !== undefined) {
        void this.provider.killTree(record.killPid, 'SIGKILL')
      }
    }, this.provider.graceMs)
    timer.unref()
    record.escalationTimer = timer
  }

  private finishRecord(
    record: ProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (record.finished) return
    record.finished = true
    if (!record.readySettled) {
      record.readySettled = true
      const message =
        record.errorMessage ??
        'native helper exited before reporting the confined process as ready'
      record.errorMessage = message
      this.emit({ type: 'execution.session_error', detail: bounded(message) })
    }
    this.cleanupRequest(record)
    if (record.escalationTimer !== null) {
      clearTimeout(record.escalationTimer)
      record.escalationTimer = null
    }
    this.records.delete(record)
    this.emit({
      type: 'execution.session_exited',
      ...(record.reportPid !== undefined ? { pid: record.reportPid } : {}),
      code,
      signal,
    })
    record.resolveExit({ code, signal })
  }

  private async waitForRecords(records: ProcessRecord[], timeoutMs: number): Promise<void> {
    if (records.length === 0) return
    await Promise.race([
      Promise.all(records.map((record) => record.exitPromise)),
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, timeoutMs)
        timer.unref()
      }),
    ])
  }
}

function readLineWithTimeout(stream: Readable, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolveLine, rejectLine) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error: Error | null, line?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
      if (error !== null) rejectLine(error)
      else resolveLine(line as string)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_READY_LINE_BYTES) {
        finish(new Error('native helper readiness line is too long'))
        return
      }
      const newline = buffer.indexOf(0x0a)
      if (newline === -1) {
        chunks.push(buffer)
        return
      }
      chunks.push(buffer.subarray(0, newline))
      finish(null, Buffer.concat(chunks).toString('utf8'))
    }
    const onEnd = (): void => {
      finish(new Error('native helper exited before reporting readiness'))
    }
    const onError = (error: Error): void => {
      finish(new Error(`native helper readiness pipe failed: ${error.message}`))
    }
    const timer = setTimeout(() => {
      finish(new Error(`native helper did not report readiness within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
  })
}
