import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { ExecutionClosedError, ExecutionTimeoutError, PolicyDeniedError, ValidationError } from '../domain/errors.ts'
import { newId } from '../domain/ids.ts'
import { PLATFORM_ENV_KEEP } from '../engines/acp/env.ts'
import type { AcpChild } from '../engines/acp/client.ts'
import type { RunResult } from '../util/exec.ts'

/**
 * Native execution provider (host processes, no Docker).
 *
 * What is enforced here:
 * - an explicit working-directory boundary: every process cwd must be inside
 *   one of the session's allowed roots (real paths, so symlink escapes fail);
 * - environment allowlisting: no host environment is inherited wholesale;
 *   platform essentials plus explicitly supplied/allowlisted values only;
 * - process-tree termination with a bounded SIGTERM -> SIGKILL escalation;
 * - bounded output for `exec`, hard per-exec timeouts, and a session timeout;
 * - durable lifecycle facts through an injected event sink.
 *
 * What is deliberately NOT claimed: OS-level filesystem/network confinement or
 * cgroup/resource limits. The provider reports `enforcement: 'partial'` and
 * callers must explicitly acknowledge that before dispatch. Docker remains the
 * only full-isolation provider; native is never a silent fallback.
 */

export type ExecutionProviderKind = 'native'
export type ExecutionMode = 'read-only' | 'workspace-write'
export type ExecutionNetworkPolicy = 'restricted' | 'none' | 'open'

export interface ExecutionLimits {
  cpus: number
  memoryMb: number
  pids: number
}

export interface ExecutionSessionSpec {
  projectId: string
  museId: string | null
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
}

export interface ExecutionProbe {
  available: boolean
  provider: ExecutionProviderKind
  backend: 'process-policy'
  enforcement: 'partial'
  detail: string
  fix?: string
  capabilities: {
    processTreeKill: boolean
    outputBounds: boolean
    filesystemConfinement: boolean
    networkConfinement: boolean
    resourceLimits: boolean
    terminal: boolean
  }
}

export interface ExecutionSessionFacts {
  provider: ExecutionProviderKind
  backend: 'process-policy'
  enforcement: 'partial'
  sessionId: string
  projectId: string
  museId: string | null
  engineKind: string
  pid: number | null
  pids: number[]
  workdir: string
  engineHome: string
  mode: ExecutionMode
  network: ExecutionNetworkPolicy
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
  museId: string | null
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

export interface NativeExecutionProviderOptions {
  rootDir: string
  hostEnv?: Record<string, string | undefined>
  onEvent?: (event: ExecutionEvent) => void
  spawnFn?: NativeSpawnFn
  /** Test seam: replaces the platform process-tree killer. */
  killTreeFn?: (pid: number, signal: NodeJS.Signals) => Promise<void>
  now?: () => Date
  maxOutputBytes?: number
  /** Grace between SIGTERM and SIGKILL. Default 2s. */
  terminateGraceMs?: number
  /** Wall-clock bound for the whole execution session; 0 disables it. */
  sessionTimeoutMs?: number
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_TERMINATE_GRACE_MS = 2_000
const MAX_EVENT_DETAIL_CHARS = 1_000

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
  'QWEN_DIR',
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

const SAFE_ENV_PREFIXES = ['XDG_', 'LC_'] as const
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function bounded(text: string, max = MAX_EVENT_DETAIL_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
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

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
  if (!statSync(path).isDirectory()) {
    throw new PolicyDeniedError(`native execution path is not a directory: ${path}`)
  }
}

function defaultSpawn(command: string, args: string[], options: {
  cwd: string
  env: Record<string, string>
  stdio: 'pipe'
  windowsHide: boolean
  detached: boolean
}): AcpChild {
  return nodeSpawn(command, args, options) as unknown as AcpChild
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
  child: AcpChild
  pid: number | undefined
  finished: boolean
  errorMessage: string | null
  escalationTimer: NodeJS.Timeout | null
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  resolveExit: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void
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
    return this.record.pid
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
}

export class NativeExecutionProvider implements ExecutionProvider {
  readonly kind = 'native' as const
  private readonly opts: NativeExecutionProviderOptions
  private readonly rootReal: string
  private readonly hostEnv: Record<string, string | undefined>
  private readonly sessions = new Set<NativeExecutionSession>()
  private readonly maxOutputBytes: number
  private readonly terminateGraceMs: number
  private readonly sessionTimeoutMs: number
  private closed = false

  constructor(opts: NativeExecutionProviderOptions) {
    this.opts = opts
    if (!existsSync(opts.rootDir) || !statSync(opts.rootDir).isDirectory()) {
      throw new PolicyDeniedError(`native execution root is not an existing directory: ${opts.rootDir}`)
    }
    this.rootReal = realExisting(opts.rootDir)
    this.hostEnv = opts.hostEnv ?? (process.env as Record<string, string | undefined>)
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.terminateGraceMs = opts.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? 0
    if (this.maxOutputBytes <= 0) throw new ValidationError('native maxOutputBytes must be positive')
    if (this.terminateGraceMs < 0) throw new ValidationError('native terminateGraceMs must be >= 0')
    if (this.sessionTimeoutMs < 0) throw new ValidationError('native sessionTimeoutMs must be >= 0')
  }

  async probe(): Promise<ExecutionProbe> {
    return {
      available: !this.closed,
      provider: 'native',
      backend: 'process-policy',
      enforcement: 'partial',
      detail:
        'native host execution: cwd boundary, explicit env allowlist and process-tree termination are enforced; ' +
        'filesystem writes, host networking and CPU/memory limits are NOT OS-confined (partial enforcement)',
      ...(this.closed ? { fix: 'create a new native execution provider' } : {}),
      capabilities: {
        processTreeKill: true,
        outputBounds: true,
        filesystemConfinement: false,
        networkConfinement: false,
        resourceLimits: false,
        terminal: false,
      },
    }
  }

  async prepare(spec: ExecutionSessionSpec): Promise<NativeExecutionSession> {
    this.assertOpen()
    const normalized = this.validateSpec(spec)
    const session = new NativeExecutionSession(this, normalized)
    this.sessions.add(session)
    session.emit({
      type: 'execution.session_prepared',
      detail: `mode=${normalized.mode}; network=${normalized.network}; partial process-policy enforcement`,
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
  spawnChild(command: string, args: string[], cwd: string, env: Record<string, string>): AcpChild {
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
  get rootRealPath(): string {
    return this.rootReal
  }

  /** @internal */
  get environment(): Record<string, string | undefined> {
    return this.hostEnv
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
    if (spec.mode !== 'read-only' && spec.mode !== 'workspace-write') {
      throw new ValidationError(`native execution mode '${String(spec.mode)}' is not supported`)
    }
    if (spec.network !== 'open') {
      throw new PolicyDeniedError(
        `native execution cannot enforce network_policy '${spec.network}': host processes share the host network. ` +
          'Set runtime.network_policy (or the Muse override) to open explicitly and acknowledge host networking; ' +
          'use sandbox.kind: docker when network isolation is required.',
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
      if (!isInside(this.rootReal, real)) {
        throw new PolicyDeniedError(
          `native allowed root '${real}' is outside the provider root '${this.rootReal}'`,
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
      hostWorkdir: workdir,
      hostEngineHome: engineHome,
      allowedRoots: roots,
      env: { ...spec.env },
    }
  }
}

class NativeExecutionSession implements ExecutionSession {
  readonly id: string
  readonly spec: ExecutionSessionSpec
  private readonly provider: NativeExecutionProvider
  private readonly records = new Set<ProcessRecord>()
  private readonly startedAt: string
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private timedOut = false

  constructor(provider: NativeExecutionProvider, spec: ExecutionSessionSpec) {
    this.provider = provider
    this.id = newId('session')
    this.spec = spec
    this.startedAt = new Date().toISOString()
  }

  facts(): ExecutionSessionFacts {
    const pids = [...this.records]
      .filter((record) => !record.finished)
      .map((record) => record.pid)
      .filter((pid): pid is number => pid !== undefined)
    return {
      provider: 'native',
      backend: 'process-policy',
      enforcement: 'partial',
      sessionId: this.id,
      projectId: this.spec.projectId,
      museId: this.spec.museId,
      engineKind: this.spec.engineKind,
      pid: pids[0] ?? null,
      pids,
      workdir: this.spec.hostWorkdir,
      engineHome: this.spec.hostEngineHome,
      mode: this.spec.mode,
      network: this.spec.network,
      startedAt: this.startedAt,
      limitations: [
        'filesystem writes are not OS-confined; cwd and allowed roots are policy checks, not a kernel boundary',
        'network access is the host network (network_policy: open) and is not filtered',
        'CPU/memory/pids limits are recorded but not enforced by the host scheduler',
        'a descendant that detaches into its own process group can outlive tree termination',
      ],
    }
  }

  spawn(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): ExecutionProcess {
    this.assertUsable()
    if (typeof command !== 'string' || command.trim() === '') {
      throw new ValidationError('native spawn requires a non-empty command')
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new ValidationError('native spawn requires an argv array of strings')
    }
    const cwd = this.validateCwd(options.cwd ?? this.spec.hostWorkdir)
    const env = this.resolveEnv(options.env ?? {})

    const spawnFn = this.provider['spawnChild'].bind(this.provider)
    let child: AcpChild
    try {
      child = spawnFn(command, args, cwd, env)
    } catch (error) {
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
      pid: child.pid,
      finished: false,
      errorMessage: null,
      escalationTimer: null,
      exitPromise,
      resolveExit,
    }
    this.records.add(record)
    this.armTimer()

    child.on('spawn', () => {
      record.pid = child.pid ?? record.pid
      this.emit({
        type: 'execution.session_started',
        ...(record.pid !== undefined ? { pid: record.pid } : {}),
      })
    })
    child.on('error', (error) => {
      record.errorMessage = error.message
      this.emit({ type: 'execution.session_error', detail: bounded(error.message) })
      this.finishRecord(record, null, null)
    })
    child.on('exit', (code, signal) => {
      this.finishRecord(record, code, signal)
    })

    return new NativeProcessHandle(record, this)
  }

  async exec(argv: string[], options: ExecutionExecOptions = {}): Promise<RunResult> {
    if (argv.length === 0) throw new ValidationError('native exec requires a non-empty argv')
    const maxOutputBytes = options.maxOutputBytes ?? this.provider.defaultMaxOutputBytes
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new ValidationError('native exec maxOutputBytes must be a positive integer')
    }
    const started = Date.now()
    const handle = this.spawn(argv[0] as string, argv.slice(1), {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
    const record = this.recordFor(handle)
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
  emit(event: Omit<ExecutionEvent, 'at' | 'provider' | 'sessionId' | 'projectId' | 'museId' | 'engineKind'>): void {
    this.provider.emit({
      ...event,
      sessionId: this.id,
      projectId: this.spec.projectId,
      museId: this.spec.museId,
      engineKind: this.spec.engineKind,
    })
  }

  private assertUsable(): void {
    if (this.closed) throw new ExecutionClosedError(this.id)
    if (this.timedOut) {
      throw new ExecutionTimeoutError(this.id, this.provider.configuredSessionTimeoutMs)
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
    return resolved
  }

  private armTimer(): void {
    if (this.timer !== null) return
    const timeoutMs = this.provider.configuredSessionTimeoutMs
    if (timeoutMs <= 0) return
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

  private recordFor(handle: ExecutionProcess): ProcessRecord {
    const record = [...this.records].find(
      (candidate) => candidate.pid !== undefined && candidate.pid === handle.pid,
    )
    if (record !== undefined) return record
    // The process may have exited before we looked it up; fall back to the
    // most recently spawned record. exec() is not concurrent with other spawns
    // in the same session in Pluton's call sites.
    const records = [...this.records]
    const last = records[records.length - 1]
    if (last === undefined) throw new ValidationError('native exec lost its process record')
    return last
  }

  private async terminate(record: ProcessRecord, signal: NodeJS.Signals): Promise<void> {
    if (record.finished) return
    if (record.escalationTimer !== null && signal !== 'SIGKILL') return
    const pid = record.pid
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
      if (!record.finished && record.pid !== undefined) {
        void this.provider.killTree(record.pid, 'SIGKILL')
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
    if (record.escalationTimer !== null) {
      clearTimeout(record.escalationTimer)
      record.escalationTimer = null
    }
    this.records.delete(record)
    this.emit({
      type: 'execution.session_exited',
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
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
