import { join } from 'node:path'
import {
  CapabilityError,
  EngineAuthMissingError,
  EngineMissingError,
  EngineProtocolError,
  ExternalToolError,
  ValidationError,
  isPlutonError,
} from '../../domain/errors.ts'
import { newId } from '../../domain/ids.ts'
import { AsyncQueue } from '../../util/async-queue.ts'
import { firstLine, run } from '../../util/exec.ts'
import type { RunOptions, RunResult } from '../../util/exec.ts'
import { AcpClient, type AcpServerRequestResponse, type AcpSpawnFn } from '../acp/client.ts'
import { defaultCapabilities } from '../contract/types.ts'
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineDiscovery,
  EngineEvent,
  EngineModel,
  EngineSession,
  EngineSessionInfo,
  McpServerSpec,
  PromptRequest,
  StartSessionRequest,
} from '../contract/types.ts'
import { OPENCODE_MISSING_FIX, assertNonEmptyModel, resolveOpenCodeBinary } from './discover.ts'
import {
  normalizeSessionUpdate,
  summarizePromptResult,
  type PromptOutcome,
  type PromptResultSummary,
} from './normalize.ts'

/**
 * OpenCode engine adapter over ACP (Agent Client Protocol, stdio JSON-RPC).
 * Protocol facts verified live against opencode v2.0.29 on 2026-10-16
 * (`.pluton-tmp/acp-probe.log`, `acp-probe2.log`):
 *
 * - `initialize` (protocolVersion 1) -> agentCapabilities incl. loadSession
 * - `session/new {cwd, mcpServers}` -> {sessionId, configOptions}
 * - `session/set_config_option {configId:'model', value}` pins the model and
 *   returns the full config options; the adapter verifies the switch took
 *   effect and refuses to run on a different model
 * - `session/prompt` streams `session/update` notifications, then resolves
 *   with {stopReason, usage}
 * - `session/cancel` (notification) -> prompt resolves stopReason 'cancelled'
 * - `session/load` resumes a session; history replays as updates
 * - `session/close` exists; exiting the process also ends sessions
 *
 * Capability notes (never faked):
 * - `resumeSession` uses session/load, verified by live probe #2.
 * - `approvals`: permission requests are answered fail-closed (reject) and
 *   surfaced as approval_request events; there is no interactive approval
 *   channel in this build, so the adapter never fabricates consent.
 * - throwaway containers/Docker isolation is a sandbox concern (Phase 5);
 *   this adapter only manages the engine protocol.
 */

const INITIALIZE_TIMEOUT_MS = 30_000
const SESSION_NEW_TIMEOUT_MS = 60_000
const SESSION_LOAD_TIMEOUT_MS = 120_000
const MODEL_SET_TIMEOUT_MS = 20_000
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const CANCEL_GRACE_MS = 10_000
const TURN_EVENT_BUFFER = 8192

export interface OpenCodeAdapterOptions {
  /** Injection for tests: replaces node:child_process.spawn for the ACP child. */
  spawnFn?: AcpSpawnFn
  /** Skip PATH resolution (tests, or an operator-pinned binary). */
  binaryPath?: string
  platform?: NodeJS.Platform
  envOverrides?: Record<string, string>
  isFile?: (path: string) => boolean
  readTextFile?: (path: string) => string
  requestTimeoutMs?: number
  versionTimeoutMs?: number
  /** Injection for tests: replaces the bounded subprocess runner. */
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult>
  /** How long to wait for session/cancel to be acknowledged before poisoning the session. */
  cancelGraceMs?: number
}

interface TurnState {
  queue: AsyncQueue<EngineEvent>
  interrupted: boolean
  overflowed: boolean
  error: Error | null
  resultSummary: PromptResultSummary | null
  timedOut: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function errorCodeOf(e: unknown): string {
  return isPlutonError(e) ? e.code : 'engine_protocol_error'
}

/**
 * Sanitized environment for a Muse's engine process (ADR-0008): platform
 * essentials plus XDG/HOME redirection into the Muse's private engine home.
 * Verified: opencode v2.0.29 honours XDG_CONFIG_HOME/XDG_DATA_HOME/
 * XDG_CACHE_HOME (which is where its credentials, logs and caches land).
 * Consequence: the engine cannot read the user's global opencode config, and
 * authentication for a Muse must be performed against that Muse's home.
 */
export function buildEngineEnv(
  configDir: string,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const keep = [
    'PATH',
    'Path',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'WINDIR',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'LANG',
    'LC_ALL',
    'SHELL',
    'TERM',
  ]
  const env: Record<string, string> = {}
  for (const key of keep) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env['XDG_CONFIG_HOME'] = join(configDir, 'config')
  env['XDG_DATA_HOME'] = join(configDir, 'data')
  env['XDG_CACHE_HOME'] = join(configDir, 'cache')
  if (platform === 'win32') env['USERPROFILE'] = configDir
  else env['HOME'] = configDir
  return { ...env, ...extra }
}

export function toAcpMcpServers(specs: McpServerSpec[] | undefined): unknown[] {
  return (specs ?? []).map((spec) => {
    const [command, ...args] = spec.command
    if (!command) throw new ValidationError(`MCP server '${spec.name}' has an empty command argv`)
    return {
      name: spec.name,
      command,
      args,
      env: Object.entries(spec.env ?? {}).map(([name, value]) => ({ name, value })),
    }
  })
}

interface ConfigOptionLike {
  id: string
  currentValue: unknown
  values: string[]
}

export function readModelOption(configOptions: unknown): ConfigOptionLike | null {
  if (!Array.isArray(configOptions)) return null
  for (const raw of configOptions) {
    const opt = asRecord(raw)
    if (!opt) continue
    if (opt['id'] !== 'model' && opt['category'] !== 'model') continue
    const values: string[] = []
    if (Array.isArray(opt['options'])) {
      for (const entry of opt['options']) {
        const e = asRecord(entry)
        if (!e) continue
        if (typeof e['value'] === 'string') values.push(e['value'])
        else if (Array.isArray(e['options'])) {
          for (const nested of e['options']) {
            const n = asRecord(nested)
            if (n && typeof n['value'] === 'string') values.push(n['value'])
          }
        }
      }
    }
    return {
      id: typeof opt['id'] === 'string' ? opt['id'] : 'model',
      currentValue: opt['currentValue'],
      values,
    }
  }
  return null
}

export class OpenCodeEngineSession implements EngineSession {
  readonly info: EngineSessionInfo
  private readonly client: AcpClient
  private readonly sessionId: string
  private readonly pinnedModel: string
  private busy = false
  private closed = false
  private poisoned: Error | null = null
  private activeTurn: TurnState | null = null
  private pendingInstructions: string | null
  private readonly cancelGraceMs: number

  /** Diagnostics for tests/doctor (never part of the event stream). */
  ignoredUpdates = 0
  modelDriftSeen = false

  constructor(args: {
    client: AcpClient
    sessionId: string
    pinnedModel: string
    instructions: string | null
    cancelGraceMs: number
  }) {
    this.client = args.client
    this.sessionId = args.sessionId
    this.pinnedModel = args.pinnedModel
    this.cancelGraceMs = args.cancelGraceMs
    this.pendingInstructions = args.instructions && args.instructions.trim() !== '' ? args.instructions : null
    this.info = {
      id: newId('session'),
      nativeSessionId: args.sessionId,
      resumeToken: args.sessionId,
    }
  }

  /** Called by the adapter's client handlers (routed by sessionId). */
  handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return
    const p = asRecord(params)
    if (!p || p['sessionId'] !== this.sessionId) return
    const normalized = normalizeSessionUpdate(p['update'], { pinnedModel: this.pinnedModel })
    for (const event of normalized.events) {
      if (event.kind === 'error' && event.code === 'engine_model_changed') this.modelDriftSeen = true
      this.emit(event)
    }
    if (normalized.ignored) this.ignoredUpdates += 1
  }

  /** Handles server -> client requests; fail-closed by design. */
  handleServerRequest(method: string, params: unknown): AcpServerRequestResponse | null {
    if (method !== 'session/request_permission') return null
    const p = asRecord(params)
    const options: Record<string, unknown>[] = []
    if (p && Array.isArray(p['options'])) {
      for (const raw of p['options']) {
        const o = asRecord(raw)
        if (o) options.push(o)
      }
    }
    const reject = options.find((o) => typeof o['kind'] === 'string' && (o['kind'] as string).startsWith('reject'))
    const toolCall = p ? asRecord(p['toolCall']) : null
    const requestId =
      toolCall && typeof toolCall['toolCallId'] === 'string' ? (toolCall['toolCallId'] as string) : newId('approval')
    const description =
      toolCall && typeof toolCall['title'] === 'string'
        ? `engine requested permission: ${toolCall['title'] as string}`
        : 'engine requested permission'
    this.emit({ kind: 'approval_request', requestId, description })
    // No interactive approval channel exists yet in this build: deny, but
    // surface the request. Never fabricate consent.
    if (reject && typeof reject['optionId'] === 'string') {
      return { result: { outcome: { outcome: 'selected', optionId: reject['optionId'] } } }
    }
    return { result: { outcome: { outcome: 'cancelled' } } }
  }

  async *sendPrompt(req: PromptRequest): AsyncIterable<EngineEvent> {
    if (this.closed) throw new EngineProtocolError(`session ${this.info.id} is closed`)
    if (this.poisoned) throw this.poisoned
    if (this.busy) {
      throw new EngineProtocolError(
        `session ${this.info.id} already has an in-flight prompt; per-Muse serialization is the runtime's job and the adapter refuses to overlap turns`,
      )
    }
    if (typeof req.text !== 'string' || req.text.trim() === '') {
      throw new ValidationError('prompt text must be a non-empty string')
    }

    this.busy = true
    const queue = new AsyncQueue<EngineEvent>(TURN_EVENT_BUFFER)
    const turn: TurnState = {
      queue,
      interrupted: false,
      overflowed: false,
      error: null,
      resultSummary: null,
      timedOut: false,
    }
    this.activeTurn = turn

    const timeoutMs = req.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    const promptParts: unknown[] = []
    if (this.pendingInstructions !== null) {
      promptParts.push({ type: 'text', text: this.pendingInstructions })
      this.pendingInstructions = null
    }
    promptParts.push({ type: 'text', text: req.text })

    const request = this.client.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: promptParts },
      { timeoutMs: timeoutMs + 30_000 },
    )
    const requestSettled = request.then(
      () => 'settled' as const,
      () => 'settled' as const,
    )
    request.then(
      (result) => {
        const summary = summarizePromptResult(result)
        turn.resultSummary = summary
        if (summary.usage) queue.push({ kind: 'usage', ...summary.usage })
        queue.close()
      },
      (err: Error) => {
        turn.error = err
        queue.close()
      },
    )

    let adapterTimer: NodeJS.Timeout | null = null
    const timeoutSignal = new Promise<'timeout'>((resolve) => {
      adapterTimer = setTimeout(() => {
        turn.timedOut = true
        resolve('timeout')
      }, timeoutMs)
      adapterTimer.unref?.()
    })
    void Promise.race([requestSettled, timeoutSignal]).then(async (which) => {
      if (which !== 'timeout') return
      try {
        this.client.notify('session/cancel', { sessionId: this.sessionId })
      } catch {
        // transport may already be dead; the stream will end as unknown below
      }
      const settled = await Promise.race([
        requestSettled,
        new Promise<'grace'>((resolve) => {
          const t = setTimeout(() => resolve('grace'), this.cancelGraceMs)
          t.unref?.()
        }),
      ])
      if (settled === 'settled') return
      turn.error = new EngineProtocolError(
        `prompt timed out after ${timeoutMs}ms and the engine did not acknowledge session/cancel within ${this.cancelGraceMs}ms; session state is unknown — close it and start a new one`,
        { details: { timeoutMs, cancelGraceMs: this.cancelGraceMs } },
      )
      queue.close()
    })

    yield { kind: 'status', status: 'busy' }

    try {
      for await (const event of queue) yield event
    } finally {
      if (adapterTimer) clearTimeout(adapterTimer)
      this.busy = false
      this.activeTurn = null
    }

    if (turn.overflowed) {
      const err = new EngineProtocolError(
        `engine produced more than ${TURN_EVENT_BUFFER} events for one prompt; turn aborted and session marked unknown`,
      )
      this.poisoned = err
      yield { kind: 'error', code: err.code, message: err.message }
      yield { kind: 'result', outcome: 'unknown', summary: 'event buffer overflow; session state unknown' }
      return
    }

    if (turn.resultSummary) {
      yield { kind: 'result', outcome: turn.resultSummary.outcome, summary: turn.resultSummary.summary }
      return
    }

    const err =
      turn.error ??
      new EngineProtocolError('prompt stream ended without a result from the engine', {
        details: { sessionId: this.sessionId },
      })
    if (turn.timedOut) this.poisoned = err
    yield { kind: 'error', code: errorCodeOf(err), message: err.message }
    const outcome: PromptOutcome = 'unknown'
    yield {
      kind: 'result',
      outcome,
      summary: turn.timedOut ? 'prompt timed out; cancellation not acknowledged' : 'no result from engine; outcome unknown',
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn
    if (turn) turn.interrupted = true
    if (this.closed) return
    try {
      this.client.notify('session/cancel', { sessionId: this.sessionId })
    } catch (err) {
      // If the transport is already gone the stream ends via the error path;
      // interrupt must not mask that with a second failure.
      if (!this.client.isDead) throw err
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.activeTurn) this.activeTurn.queue.close()
    try {
      await this.client.request('session/close', { sessionId: this.sessionId }, { timeoutMs: 3_000 })
    } catch {
      // Best-effort cleanup: the session may already be gone, or the agent
      // may not implement session/close; killing the transport ends it too.
    }
    await this.client.close()
  }

  private emit(event: EngineEvent): void {
    const turn = this.activeTurn
    if (!turn) {
      // Updates outside a turn are history replay / informational frames.
      this.ignoredUpdates += 1
      return
    }
    if (!turn.queue.push(event)) {
      turn.overflowed = true
      void this.interrupt()
    }
  }
}

export class OpenCodeEngineAdapter implements EngineAdapter {
  readonly kind = 'opencode'
  private readonly opts: OpenCodeAdapterOptions
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.opts = opts
    this.runFn = opts.runFn ?? run
  }

  capabilities(): EngineCapabilities {
    return {
      ...defaultCapabilities(),
      resumeSession: true,
      interrupt: true,
      approvals: true,
      usage: true,
      modelList: true,
      mcpServers: true,
    }
  }

  private resolveBinary(): ReturnType<typeof resolveOpenCodeBinary> {
    if (this.opts.binaryPath) return { ok: true, binary: { path: this.opts.binaryPath, via: 'env' } }
    return resolveOpenCodeBinary({
      env: { ...process.env, ...(this.opts.envOverrides ?? {}) },
      platform: this.opts.platform,
      isFile: this.opts.isFile,
      readTextFile: this.opts.readTextFile,
    })
  }

  async discover(): Promise<EngineDiscovery> {
    const resolved = this.resolveBinary()
    if (!resolved.ok) {
      return { engineKind: this.kind, installed: false, binaryPath: null, version: null, fix: resolved.fix }
    }
    let version: string | null = null
    try {
      const out = await this.runFn([resolved.binary.path, '--version'], {
        timeoutMs: this.opts.versionTimeoutMs ?? 15_000,
        maxOutputBytes: 64 * 1024,
      })
      if (!out.timedOut && out.exitCode === 0) {
        version = firstLine(out.stdout) || firstLine(out.stderr) || null
      }
    } catch {
      version = null
    }
    return {
      engineKind: this.kind,
      installed: true,
      binaryPath: resolved.binary.path,
      version,
      fix: '',
    }
  }

  async listModels(): Promise<EngineModel[]> {
    const resolved = this.resolveBinary()
    if (!resolved.ok) throw new EngineMissingError(this.kind, resolved.fix)
    const out = await this.runFn([resolved.binary.path, 'models'], {
      timeoutMs: 30_000,
      maxOutputBytes: 512 * 1024,
    })
    if (out.timedOut) throw new ExternalToolError('opencode models', 'timed out after 30000ms')
    if (out.exitCode !== 0) {
      throw new ExternalToolError(
        'opencode models',
        `exit code ${String(out.exitCode)}: ${firstLine(out.stderr) || '(no stderr)'}`,
      )
    }
    if (out.truncated) {
      throw new ExternalToolError('opencode models', 'output exceeded the 512 KiB cap; refusing a partial model list')
    }
    const seen = new Set<string>()
    const models: EngineModel[] = []
    for (const raw of out.stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || !/^[^\s/]+\/\S+$/.test(line)) continue
      if (seen.has(line)) continue
      seen.add(line)
      models.push({ id: line, source: 'engine' })
    }
    return models
  }

  async authStatus(configDir: string): Promise<EngineAuthStatus> {
    const resolved = this.resolveBinary()
    if (!resolved.ok) return { configured: false, hint: resolved.fix }
    const env = buildEngineEnv(configDir, {}, this.opts.platform ?? process.platform)
    const out = await this.runFn([resolved.binary.path, 'auth', 'list'], {
      timeoutMs: 20_000,
      env,
      envMode: 'explicit',
      maxOutputBytes: 128 * 1024,
    })
    const hint =
      'free opencode/* models need no login; to use provider models run `opencode auth login` with this Muse\'s engine home as the config dir (XDG_CONFIG_HOME)'
    if (out.timedOut || out.exitCode !== 0) {
      return { configured: false, hint: `${hint} (auth list failed: ${out.timedOut ? 'timeout' : `exit ${String(out.exitCode)}`})` }
    }
    const configured = !/no authenticated integrations/i.test(out.stdout)
    return { configured, hint }
  }

  async startSession(req: StartSessionRequest): Promise<EngineSession> {
    assertNonEmptyModel(req.muse.model)
    const resolved = this.resolveBinary()
    if (!resolved.ok) throw new EngineMissingError(this.kind, resolved.fix)

    const holder: { session: OpenCodeEngineSession | null } = { session: null }
    const client = new AcpClient({
      command: resolved.binary.path,
      args: ['acp', '--log-level', 'warn'],
      cwd: req.workdir,
      env: buildEngineEnv(req.configDir, req.env, this.opts.platform ?? process.platform),
      spawnFn: this.opts.spawnFn,
      requestTimeoutMs: this.opts.requestTimeoutMs ?? 30_000,
      onNotification: (method, params) => holder.session?.handleNotification(method, params),
      onServerRequest: (method, params) => holder.session?.handleServerRequest(method, params) ?? null,
    })

    try {
      await client.start()
      const init = await client.request<Record<string, unknown>>(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      )
      const agentCapabilities = asRecord(init['agentCapabilities'])
      if (!agentCapabilities) {
        throw new EngineProtocolError('initialize response is missing agentCapabilities', {
          details: { init },
        })
      }

      const mcpServers = toAcpMcpServers(req.mcpServers)
      let sessionId: string
      let configOptions: unknown
      if (req.resumeToken) {
        if (agentCapabilities['loadSession'] !== true) {
          throw new CapabilityError(this.kind, 'resumeSession')
        }
        const loaded = await client.request<Record<string, unknown>>(
          'session/load',
          { sessionId: req.resumeToken, cwd: req.workdir, mcpServers },
          { timeoutMs: SESSION_LOAD_TIMEOUT_MS },
        )
        sessionId = req.resumeToken
        configOptions = loaded['configOptions']
      } else {
        const created = await client.request<Record<string, unknown>>(
          'session/new',
          { cwd: req.workdir, mcpServers },
          { timeoutMs: SESSION_NEW_TIMEOUT_MS },
        )
        if (typeof created['sessionId'] !== 'string' || created['sessionId'] === '') {
          throw new EngineProtocolError('session/new returned no sessionId', { details: { created } })
        }
        sessionId = created['sessionId']
        configOptions = created['configOptions']
      }

      await this.applyModel(client, sessionId, configOptions, req.muse.model)

      const session = new OpenCodeEngineSession({
        client,
        sessionId,
        pinnedModel: req.muse.model,
        instructions: req.resumeToken ? null : (req.instructions ?? null),
        cancelGraceMs: this.opts.cancelGraceMs ?? CANCEL_GRACE_MS,
      })
      holder.session = session
      return session
    } catch (err) {
      await client.close().catch(() => {
        // cleanup is best-effort; the original error is what matters
      })
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EngineMissingError(
          this.kind,
          `'${resolved.binary.path}' could not be started (ENOENT). ${OPENCODE_MISSING_FIX}`,
        )
      }
      if (
        err instanceof EngineProtocolError &&
        /\b(auth|login|credential|unauthori[sz]ed)/i.test(err.message)
      ) {
        throw new EngineAuthMissingError(
          this.kind,
          `free opencode/* models need no login; otherwise authenticate into this Muse's engine home (${req.configDir}). Engine said: ${err.message}`,
        )
      }
      throw err
    }
  }

  private async applyModel(
    client: AcpClient,
    sessionId: string,
    configOptions: unknown,
    wantModel: string,
  ): Promise<void> {
    const option = readModelOption(configOptions)
    if (!option) throw new CapabilityError(this.kind, 'model_select')
    if (!option.values.includes(wantModel)) {
      throw new ValidationError(
        `model '${wantModel}' is not offered by engine '${this.kind}'; available: ${option.values.slice(0, 20).join(', ')}`,
        { details: { requested: wantModel, available: option.values } },
      )
    }
    if (option.currentValue === wantModel) return
    const applied = await client.request<Record<string, unknown>>(
      'session/set_config_option',
      { sessionId, configId: option.id, value: wantModel },
      { timeoutMs: MODEL_SET_TIMEOUT_MS },
    )
    const after = readModelOption(applied['configOptions'])
    if (!after || after.currentValue !== wantModel) {
      throw new EngineProtocolError(
        `engine did not switch to model '${wantModel}' (reported: ${String(after?.currentValue ?? 'missing')}); refusing to run on an unpinned model`,
      )
    }
  }
}
