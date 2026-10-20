import { join } from 'node:path'
import {
  CapabilityError,
  EngineAuthMissingError,
  EngineMissingError,
  EngineProtocolError,
  ExternalToolError,
  ValidationError,
} from '../../domain/errors.ts'
import { newId } from '../../domain/ids.ts'
import { firstLine, run } from '../../util/exec.ts'
import type { RunOptions, RunResult } from '../../util/exec.ts'
import { AcpClient, type AcpServerRequestResponse, type AcpSpawnFn } from '../acp/client.ts'
import { withRetry, type RetryOptions } from '../acp/retry.ts'
import { copyPlatformEnv } from '../acp/env.ts'
import { asRecord, permissionScope, readModelOption, toAcpMcpServers } from '../acp/options.ts'
import { AcpEngineSessionBase, CANCEL_GRACE_MS } from '../acp/session-base.ts'
import { defaultCapabilities } from '../contract/types.ts'
import type { EnginePermissionChannel, EnginePermissionDecision } from '../interactive-approval.ts'
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineDiscovery,
  EngineModel,
  EngineSession,
  ModelAvailability,
  StartSessionRequest,
} from '../contract/types.ts'
import { OPENCODE_MISSING_FIX, assertNonEmptyModel, resolveOpenCodeBinary } from './discover.ts'

export { type ModelAvailability } from '../contract/types.ts'

export const SHIP_WORKER_MODELS = [
  '9router/ag/claude-opus-4-6-thinking',
  '9router/ag/gemini-3.8-flash',
  '9router/ag/gemini-3.8-flash-high',
  'opencode/beam-free',
  'opencode/big-pickle',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/minimax-m3.1-flash-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free',
] as const

export type ShipWorkerModel = (typeof SHIP_WORKER_MODELS)[number]

// Kept as re-exports so existing imports (tests included) stay stable; the
// canonical definitions live in the shared ACP modules.
export { readModelOption, toAcpMcpServers } from '../acp/options.ts'

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
 *   surfaced as approval_request events. With the `interactive` policy the
 *   request is forwarded to the session's operator approval channel and the
 *   engine's request is held open until the decision; a grant is always
 *   narrow (`allow_once`) and the adapter never fabricates consent.
 * - throwaway containers/Docker isolation is a sandbox concern (Phase 5);
 *   this adapter only manages the engine protocol.
 */

const INITIALIZE_TIMEOUT_MS = 30_000
const SESSION_NEW_TIMEOUT_MS = 60_000
const SESSION_LOAD_TIMEOUT_MS = 120_000
const MODEL_SET_TIMEOUT_MS = 20_000

/** What Pluton does with an opencode permission request. */
export type OpenCodeApprovalPolicy = 'deny' | 'interactive'

export interface RunMockResult {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  timedOut?: boolean
  truncated?: boolean
  durationMs?: number
  argv?: string[]
}

export interface OpenCodeAdapterOptions {
  /** Injection for tests: replaces node:child_process.spawn for the ACP child. */
  spawnFn?: AcpSpawnFn
  spawnRetry?: RetryOptions
  /** Skip PATH resolution (tests, or an operator-pinned binary). */
  binaryPath?: string
  platform?: NodeJS.Platform
  /** Maps the host session workdir to the engine's namespace (container mode); identity when absent. */
  mapWorkdir?: (hostPath: string) => string
  envOverrides?: Record<string, string>
  isFile?: (path: string) => boolean
  readTextFile?: (path: string) => string
  requestTimeoutMs?: number
  versionTimeoutMs?: number
  /** Injection for tests: replaces the bounded subprocess runner. */
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult | RunMockResult>
  /** How long to wait for session/cancel to be acknowledged before poisoning the session. */
  cancelGraceMs?: number
  /**
   * What Pluton does with engine permission requests. 'deny' (default) rejects
   * fail-closed and surfaces an approval_request event; 'interactive' forwards
   * to the session's operator approval channel and holds the engine's request
   * open until the decision (a grant is always narrow: `allow_once`).
   */
  approvalPolicy?: OpenCodeApprovalPolicy
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
  const env = copyPlatformEnv()
  env['XDG_CONFIG_HOME'] = join(configDir, 'config')
  env['XDG_DATA_HOME'] = join(configDir, 'data')
  env['XDG_CACHE_HOME'] = join(configDir, 'cache')
  if (platform === 'win32') env['USERPROFILE'] = configDir
  else env['HOME'] = configDir
  return { ...env, ...extra }
}

export class OpenCodeEngineSession extends AcpEngineSessionBase {
  private readonly supportsSessionClose: boolean
  private readonly approvalPolicy: OpenCodeApprovalPolicy
  /** Diagnostics: how many permission requests were answered and how. */
  approvalDecisions: Array<{ requestId: string; decision: string }> = []

  constructor(args: {
    client: AcpClient
    sessionId: string
    pinnedModel: string
    instructions: string | null
    cancelGraceMs: number
    supportsSessionClose?: boolean
    approvalPolicy?: OpenCodeApprovalPolicy
    /** Required by the 'interactive' policy; other policies ignore it. */
    permissionChannel?: EnginePermissionChannel | null
  }) {
    super({
      client: args.client,
      nativeSessionId: args.sessionId,
      pinnedModel: args.pinnedModel,
      cancelGraceMs: args.cancelGraceMs,
      permissionChannel: args.permissionChannel ?? null,
    })
    this.supportsSessionClose = args.supportsSessionClose ?? true
    this.approvalPolicy = args.approvalPolicy ?? 'deny'
    this.setPendingInstructions(args.instructions)
  }

  /**
   * Handles server -> client requests; fail-closed by design. opencode did not
   * issue permission requests during live probes, but a rejection path must
   * exist: any request is denied/refused and surfaced as an approval_request.
   *
   * Under the `interactive` policy the request is forwarded to the operator
   * approval channel and the engine's request stays open until the decision; a
   * grant is always narrow (`allow_once`) and everything else — deny, timeout,
   * teardown, no channel — answers the reject outcome.
   */
  async handleServerRequest(method: string, params: unknown): Promise<AcpServerRequestResponse | null> {
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
    const title = toolCall && typeof toolCall['title'] === 'string' ? (toolCall['title'] as string) : null
    const description = title !== null ? `engine requested permission: ${title}` : 'engine requested permission'
    const rejectOutcome: AcpServerRequestResponse =
      reject && typeof reject['optionId'] === 'string'
        ? { result: { outcome: { outcome: 'selected', optionId: reject['optionId'] } } }
        : { result: { outcome: { outcome: 'cancelled' } } }

    // A closed session must never mint a durable, actionable record: its
    // transport is going away, so the answer would be dropped anyway.
    if (this.isClosed) {
      this.recordInteractive(requestId, description, 'deny(session closed)')
      return rejectOutcome
    }

    if (this.approvalPolicy !== 'interactive') {
      this.approvalDecisions.push({ requestId, decision: 'deny(fail-closed)' })
      this.emit({
        kind: 'approval_request',
        requestId,
        description: `${description} — Pluton decision: deny(fail-closed) (approvalPolicy=${this.approvalPolicy})`,
      })
      // Deny, but surface the request. Never fabricate consent.
      return rejectOutcome
    }

    const channel = this.permissionChannel
    if (!channel) {
      this.recordInteractive(requestId, description, 'deny(no operator channel)')
      return rejectOutcome
    }
    const optionKinds = options.map((o) => (typeof o['kind'] === 'string' ? (o['kind'] as string) : 'unknown'))
    let decision: EnginePermissionDecision
    try {
      decision = await channel.requestPermission({
        requestId,
        description,
        scope: permissionScope({ toolCall, optionKinds }),
      })
    } catch {
      // The channel contract is "never rejects"; if it still does, fail closed.
      decision = 'deny'
    }
    if (decision === 'allow') {
      const allowOnce = options.find((o) => o['kind'] === 'allow_once')
      if (allowOnce && typeof allowOnce['optionId'] === 'string') {
        this.recordInteractive(requestId, description, 'allow_once(interactive)')
        return { result: { outcome: { outcome: 'selected', optionId: allowOnce['optionId'] } } }
      }
      // The engine offers no one-time grant: never escalate to allow_always.
      this.recordInteractive(requestId, description, 'deny(no allow_once option)')
      return rejectOutcome
    }
    this.recordInteractive(requestId, description, 'deny(operator)')
    return rejectOutcome
  }

  /** Interactive decision → diagnostics + event (emitted once, after settling). */
  private recordInteractive(requestId: string, description: string, decision: string): void {
    this.approvalDecisions.push({ requestId, decision })
    this.emit({
      kind: 'approval_request',
      requestId,
      description: `${description} — Pluton decision: ${decision} (approvalPolicy=interactive)`,
    })
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.markClosed()
    if (this.supportsSessionClose) {
      try {
        await this.client.request('session/close', { sessionId: this.nativeSessionId }, { timeoutMs: 3_000 })
      } catch {
        // Best-effort cleanup: the session may already be gone, or the agent
        // may not implement session/close; killing the transport ends it too.
      }
    }
    await this.client.close()
  }
}

export class OpenCodeEngineAdapter implements EngineAdapter {
  readonly kind = 'opencode'
  private readonly opts: OpenCodeAdapterOptions
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this.opts = opts
    this.runFn = opts.runFn
      ? async (argv, options) => {
          const res = await opts.runFn!(argv, options)
          return {
            argv: res.argv ?? argv,
            exitCode: res.exitCode ?? 0,
            timedOut: res.timedOut ?? false,
            stdout: res.stdout ?? '',
            stderr: res.stderr ?? '',
            truncated: res.truncated ?? false,
            durationMs: res.durationMs ?? 0,
          }
        }
      : run
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

  /**
   * Effective session-level approval policy (read-only introspection). Pinned
   * by the wiring tests so reverting the per-Muse mapping in
   * `engines/approval.ts` must fail the suite.
   */
  get sessionApproval(): { policy: OpenCodeApprovalPolicy } {
    return { policy: this.opts.approvalPolicy ?? 'deny' }
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

  async listModelsWithAvailability(candidateModels?: string[]): Promise<ModelAvailability[]> {
    let engineModels: EngineModel[] = []
    let failureReason: string | undefined
    try {
      engineModels = await this.listModels()
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err)
    }

    const availableSet = new Set(engineModels.map((m) => m.id))
    const candidates = candidateModels ?? Array.from(new Set([...SHIP_WORKER_MODELS, ...engineModels.map((m) => m.id)]))

    return candidates.map((id) => {
      if (failureReason !== undefined) {
        return {
          id,
          available: false,
          reason: failureReason,
          source: 'catalog',
        }
      }
      const engineModel = engineModels.find((m) => m.id === id)
      if (availableSet.has(id)) {
        return {
          id,
          available: true,
          label: engineModel?.label ?? id,
          source: engineModel?.source ?? 'engine',
        }
      }
      return {
        id,
        available: false,
        reason: `model '${id}' is not offered by engine '${this.kind}'`,
        source: 'catalog',
      }
    })
  }

  async authStatus(configDir: string): Promise<EngineAuthStatus> {
    const resolved = this.resolveBinary()
    if (!resolved.ok) return { configured: false, hint: resolved.fix }
    const env = buildEngineEnv(configDir, {}, this.opts.platform ?? process.platform)
    // On Windows, the OS credential store hangs when USERPROFILE is diverted from the active user account
    if ((this.opts.platform ?? process.platform) === 'win32' && process.env['USERPROFILE']) {
      env['USERPROFILE'] = process.env['USERPROFILE']
    }
    const out = await this.runFn([resolved.binary.path, 'auth', 'list'], {
      timeoutMs: 5_000,
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

    const retryOpts = this.opts.spawnRetry
    const maxRetries = retryOpts?.maxRetries ?? (this.opts.spawnFn ? 0 : 2)
    const effectiveRetry = { ...retryOpts, maxRetries }

    let activeClient: AcpClient | null = null
    try {
      const createAndInitialize = async (): Promise<{
        client: AcpClient
        holder: { session: OpenCodeEngineSession | null }
        agentCapabilities: Record<string, unknown>
      }> => {
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
          return { client, holder, agentCapabilities }
        } catch (err) {
          await client.close().catch(() => {})
          throw err
        }
      }

      const { client, holder, agentCapabilities } = await withRetry(createAndInitialize, effectiveRetry)
      activeClient = client

      const mcpServers = toAcpMcpServers(req.mcpServers)
      // Container mode: the ACP session cwd is a path in the engine's
      // namespace, which may differ from the host path the spawn was given.
      const sessionCwd = this.opts.mapWorkdir !== undefined ? this.opts.mapWorkdir(req.workdir) : req.workdir
      let sessionId: string
      let configOptions: unknown
      if (req.resumeToken) {
        if (agentCapabilities['loadSession'] !== true) {
          throw new CapabilityError(this.kind, 'resumeSession')
        }
        const loaded = await client.request<Record<string, unknown>>(
          'session/load',
          { sessionId: req.resumeToken, cwd: sessionCwd, mcpServers },
          { timeoutMs: SESSION_LOAD_TIMEOUT_MS },
        )
        sessionId = req.resumeToken
        configOptions = loaded['configOptions']
      } else {
        const created = await client.request<Record<string, unknown>>(
          'session/new',
          { cwd: sessionCwd, mcpServers },
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
        approvalPolicy: this.opts.approvalPolicy ?? 'deny',
        permissionChannel: req.approvals ?? null,
      })
      holder.session = session
      return session
    } catch (err) {
      if (activeClient) {
        await activeClient.close().catch(() => {
          // cleanup is best-effort; the original error is what matters
        })
      }
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

  async applyModel(
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

export { OpenCodeEngineAdapter as OpenCodeAdapter }
