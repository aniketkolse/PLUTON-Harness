import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityError,
  EngineAuthMissingError,
  EngineMissingError,
  EngineProtocolError,
  ValidationError,
} from '../../domain/errors.ts'
import { newId } from '../../domain/ids.ts'
import { firstLine, run } from '../../util/exec.ts'
import type { RunOptions, RunResult } from '../../util/exec.ts'
import { AcpClient, type AcpServerRequestResponse, type AcpSpawnFn } from '../acp/client.ts'
import { withRetry, type RetryOptions } from '../acp/retry.ts'
import {
  asRecord,
  assertNonEmptyModel,
  matchModelChoice,
  permissionScope,
  readModeOption,
  readModelOption,
  toAcpMcpServers,
} from '../acp/options.ts'
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
  StartSessionRequest,
} from '../contract/types.ts'
import { QWEN_MISSING_FIX, resolveQwenInvocation, type QwenInvocation } from './discover.ts'
import { buildQwenEnv, qwenStateDir } from './env.ts'

/**
 * Qwen Code engine adapter over ACP (stdio JSON-RPC).
 *
 * Protocol facts verified live against `qwen --acp` (Qwen Code v0.25.2) on
 * 2026-10-16 (`.pluton-tmp/qwen-acp-probe.log`, `qwen-acp-probe2.log`,
 * `qwen-noauth-probe.log`):
 *
 * - `initialize` (protocolVersion 1) -> agentInfo qwen-code/v0.25.2;
 *   `agentCapabilities.loadSession === true`; `sessionCapabilities` is an
 *   object (`{list:{}, resume:{}}`) — there is **no** `close`.
 * - `session/new {cwd, mcpServers}` -> `{sessionId, models, modes,
 *   configOptions:[mode, model]}`; the mode select starts at `auto`
 *   ("LLM classifier auto-approves safe actions").
 * - `session/set_config_option` works for both `mode` and `model` and returns
 *   the updated `configOptions`; model choices are composite runtime ids
 *   (`$runtime|openai|cbai/glm-5.2(openai)`) — the option value must be used
 *   verbatim, the display name is the bare model id.
 * - `session/prompt` streams `session/update` (agent_message_chunk in ~4-char
 *   slices, agent_thought_chunk, tool_call, tool_call_update, usage_update,
 *   available_commands_update, user_message_chunk on load) and resolves with
 *   `{stopReason, _meta:{qwen.branchPoint}}`. `session/cancel` (notification)
 *   resolves the prompt with `stopReason:'cancelled'`.
 * - `session/load` resumes a session and replays history as updates;
 *   `session/list` lists sessions (qwen extension); `session/close` does NOT
 *   exist (-32601).
 * - Under mode `default`, edits and shell commands raise
 *   `session/request_permission` with options
 *   `[proceed_always|allow_always, proceed_once|allow_once, cancel|reject_once]`
 *   (shell adds `proceed_always_project` / `proceed_always_user`). Rejecting
 *   is safe: the tool is not run and the turn still ends `end_turn`.
 * - Unauthenticated `session/new` fails with -32000
 *   `"Authentication required: Use Qwen Code CLI to authenticate first."`
 *   (`data.authMethods[openai]`) — mapped to EngineAuthMissingError.
 * - Qwen emits non-ACP notifications (e.g.
 *   `qwen/notify/session/prompt-suggestion`) and a custom server request
 *   (`craft/drainMidTurnQueue`, only when mid-turn prompt queueing is used);
 *   both are ignored/refused explicitly, never guessed.
 */

const INITIALIZE_TIMEOUT_MS = 45_000
const SESSION_NEW_TIMEOUT_MS = 60_000
const SESSION_LOAD_TIMEOUT_MS = 120_000
const CONFIG_SET_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 60_000

export type QwenApprovalPolicy = 'deny' | 'allow_once' | 'allow_always' | 'interactive'

export interface QwenAdapterOptions {
  /** Injection for tests: replaces node:child_process.spawn for the ACP child. */
  spawnFn?: AcpSpawnFn
  spawnRetry?: RetryOptions
  /** Path to cli-entry.js (or an executable/shim) — skips PATH resolution. */
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
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult>
  /** How long to wait for session/cancel to be acknowledged before poisoning the session. */
  cancelGraceMs?: number
  /** Node executable used to run cli-entry.js entries (defaults to process.execPath). */
  nodePath?: string
  /**
   * What Pluton does with engine permission requests. 'deny' (default) rejects
   * fail-closed and surfaces an approval_request event; allow_* selections are
   * explicit operator choices made at adapter construction; 'interactive'
   * forwards to the session's operator approval channel and holds the engine's
   * request open until the decision (a grant is always narrow: `allow_once`).
   */
  approvalPolicy?: QwenApprovalPolicy
  /** Session mode to set explicitly at session start (qwen defaults to 'auto'). */
  approvalMode?: string
}

function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /authentication required|unauthori[sz]ed|no auth|api key/i.test(message)
}

function authHint(configDir: string): string {
  return (
    `Qwen Code needs credentials: set OPENAI_API_KEY (plus OPENAI_BASE_URL/OPENAI_MODEL for an OpenAI-compatible ` +
    `endpoint, e.g. the operator's local 9router) or DASHSCOPE_API_KEY for the DashScope API before starting the ` +
    `Pluton daemon, or log in once against this Muse's engine home (${qwenStateDir(configDir)}) with the qwen CLI`
  )
}

export class QwenEngineSession extends AcpEngineSessionBase {
  readonly approvalPolicy: QwenApprovalPolicy
  /** Diagnostics: how many permission requests were answered and how. */
  approvalDecisions: Array<{ requestId: string; decision: string }> = []

  constructor(args: {
    client: AcpClient
    sessionId: string
    pinnedModel: string
    instructions: string | null
    cancelGraceMs: number
    approvalPolicy: QwenApprovalPolicy
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
    this.approvalPolicy = args.approvalPolicy
    this.setPendingInstructions(args.instructions)
  }

  /**
   * Policy-driven approval handling. The engine's option kinds are respected
   * exactly; when the policy cannot be satisfied the request is denied
   * (fail-closed), never silently allowed.
   *
   * `interactive` (ask-* Muse modes) forwards the request to the operator
   * approval channel and holds the engine's request open until the decision;
   * a grant is always narrow (`allow_once`) and everything else — deny,
   * timeout, teardown, no channel — answers the reject/cancel outcome.
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
    const byKind = (kind: string): Record<string, unknown> | undefined =>
      options.find((o) => o['kind'] === kind)
    const anyAllow = options.find((o) => typeof o['kind'] === 'string' && (o['kind'] as string).startsWith('allow_'))
    const reject = options.find((o) => typeof o['kind'] === 'string' && (o['kind'] as string).startsWith('reject'))
    const toolCall = p ? asRecord(p['toolCall']) : null
    const requestId =
      toolCall && typeof toolCall['toolCallId'] === 'string' ? (toolCall['toolCallId'] as string) : newId('approval')
    const title = toolCall && typeof toolCall['title'] === 'string' ? (toolCall['title'] as string) : 'permission'

    if (this.approvalPolicy === 'interactive') {
      return await this.answerInteractive({ requestId, title, toolCall, options, reject })
    }

    let chosen: Record<string, unknown> | undefined
    let decision: string
    switch (this.approvalPolicy) {
      case 'allow_always':
        chosen = byKind('allow_always') ?? anyAllow
        decision = chosen === undefined ? 'deny(no grantable option)' : 'allow_always'
        break
      case 'allow_once':
        // Never fall back to `anyAllow`: a session-persistent `allow_always`
        // grant is broader than this policy intends, so a frame without a
        // one-time option is denied (falls through to the reject option).
        chosen = byKind('allow_once')
        decision = chosen === undefined ? 'deny(no grantable option)' : 'allow_once'
        break
      default:
        chosen = reject
        decision = reject === undefined ? 'cancelled(no reject option)' : 'deny'
    }
    if (chosen === undefined && this.approvalPolicy !== 'deny') chosen = reject

    this.recordApproval(requestId, title, decision)
    if (chosen && typeof chosen['optionId'] === 'string') {
      return { result: { outcome: { outcome: 'selected', optionId: chosen['optionId'] } } }
    }
    return { result: { outcome: { outcome: 'cancelled' } } }
  }

  /**
   * Interactive path: create the operator approval and wait for it (the engine
   * stays unanswered meanwhile). Operator consent is narrow — only the
   * engine's own one-time grant is used; a request with no `allow_once` option
   * is cancelled rather than escalated to `allow_always`, and the channel's
   * `deny` (including timeout/teardown) answers the reject option.
   */
  private async answerInteractive(parts: {
    requestId: string
    title: string
    toolCall: Record<string, unknown> | null
    options: Record<string, unknown>[]
    reject: Record<string, unknown> | undefined
  }): Promise<AcpServerRequestResponse> {
    const cancelOutcome: AcpServerRequestResponse =
      parts.reject && typeof parts.reject['optionId'] === 'string'
        ? { result: { outcome: { outcome: 'selected', optionId: parts.reject['optionId'] } } }
        : { result: { outcome: { outcome: 'cancelled' } } }

    // A closed session must never mint a durable, actionable record: its
    // transport is going away, so the answer would be dropped anyway.
    if (this.isClosed) {
      this.recordApproval(parts.requestId, parts.title, 'deny(session closed)')
      return cancelOutcome
    }

    const channel = this.permissionChannel
    if (!channel) {
      this.recordApproval(parts.requestId, parts.title, 'deny(no operator channel)')
      return cancelOutcome
    }
    const optionKinds = parts.options.map((o) => (typeof o['kind'] === 'string' ? (o['kind'] as string) : 'unknown'))
    let decision: EnginePermissionDecision
    try {
      decision = await channel.requestPermission({
        requestId: parts.requestId,
        description: `engine requested permission: ${parts.title}`,
        scope: permissionScope({ toolCall: parts.toolCall, optionKinds }),
      })
    } catch {
      // The channel contract is "never rejects"; if it still does, fail closed.
      decision = 'deny'
    }
    if (decision !== 'allow') {
      this.recordApproval(parts.requestId, parts.title, 'deny(operator)')
      return cancelOutcome
    }
    const allowOnce = parts.options.find((o) => o['kind'] === 'allow_once')
    if (allowOnce && typeof allowOnce['optionId'] === 'string') {
      this.recordApproval(parts.requestId, parts.title, 'allow_once(interactive)')
      return { result: { outcome: { outcome: 'selected', optionId: allowOnce['optionId'] } } }
    }
    this.recordApproval(parts.requestId, parts.title, 'deny(no allow_once option)')
    return cancelOutcome
  }

  /** One approval decision → diagnostics + normalized event (one per request). */
  private recordApproval(requestId: string, title: string, decision: string): void {
    this.approvalDecisions.push({ requestId, decision })
    this.emit({
      kind: 'approval_request',
      requestId,
      description: `engine requested permission: ${title} — Pluton decision: ${decision} (approvalPolicy=${this.approvalPolicy})`,
    })
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.markClosed()
    // Qwen Code v0.25.2 does not implement session/close; closing the
    // transport ends the session (verified: no session state survives a
    // process exit that matters to Pluton — resume uses on-disk sessions).
    await this.client.close()
  }
}

export class QwenEngineAdapter implements EngineAdapter {
  readonly kind = 'qwen'
  private readonly opts: QwenAdapterOptions
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>

  constructor(opts: QwenAdapterOptions = {}) {
    this.opts = opts
    this.runFn = opts.runFn ?? run
  }

  /**
   * Effective session-level approval settings (read-only introspection): the
   * session mode this adapter will request and the policy it answers
   * permission prompts with — same defaults as the session itself (`default`
   * mode, `deny` policy). Pinned by the wiring tests so reverting the per-Muse
   * mapping in `engines/approval.ts` must fail the suite.
   */
  get sessionApproval(): { mode: string; policy: QwenApprovalPolicy } {
    return { mode: this.opts.approvalMode ?? 'default', policy: this.opts.approvalPolicy ?? 'deny' }
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

  private resolve(): ReturnType<typeof resolveQwenInvocation> {
    if (this.opts.binaryPath) {
      const path = this.opts.binaryPath
      const invocation: QwenInvocation = /\.(m?js|cjs)$/i.test(path)
        ? { command: this.opts.nodePath ?? process.execPath, baseArgs: [path], path, via: 'env', entryKind: 'node-script' }
        : { command: path, baseArgs: [], path, via: 'env', entryKind: 'executable' }
      return { ok: true, invocation }
    }
    return resolveQwenInvocation({
      env: { ...process.env, ...(this.opts.envOverrides ?? {}) },
      platform: this.opts.platform,
      isFile: this.opts.isFile,
      readTextFile: this.opts.readTextFile,
      nodePath: this.opts.nodePath,
    })
  }

  private spawnEnv(configDir: string, extra: Record<string, string>): Record<string, string> {
    return buildQwenEnv(configDir, extra, this.opts.platform ?? process.platform, {
      ...process.env,
      ...(this.opts.envOverrides ?? {}),
    })
  }

  async discover(): Promise<EngineDiscovery> {
    const resolved = this.resolve()
    if (!resolved.ok) {
      return { engineKind: this.kind, installed: false, binaryPath: null, version: null, fix: resolved.fix }
    }
    const { invocation } = resolved
    let version: string | null = null
    try {
      const out = await this.runFn([invocation.command, ...invocation.baseArgs, '--version'], {
        timeoutMs: this.opts.versionTimeoutMs ?? 20_000,
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
      binaryPath: invocation.path,
      version,
      fix: '',
    }
  }

  /**
   * Honest auth check. When allowlisted credentials are present in the
   * environment it reports them without spawning; otherwise it performs a real
   * `session/new` handshake and lets the engine answer — an engine-level
   * "Authentication required" (-32000) means not configured.
   */
  async authStatus(configDir: string): Promise<EngineAuthStatus> {
    const resolved = this.resolve()
    if (!resolved.ok) return { configured: false, hint: resolved.fix }
    const env = this.spawnEnv(configDir, {})
    if (env['OPENAI_API_KEY'] || env['DASHSCOPE_API_KEY']) {
      return {
        configured: true,
        hint: 'credentials via environment (OPENAI_*/DASHSCOPE_*); injected into the engine process at start',
      }
    }
    try {
      mkdirSync(configDir, { recursive: true })
      await this.withEphemeralSession(configDir, configDir, async () => undefined)
      return { configured: true, hint: `authenticated via this Muse's engine home (${qwenStateDir(configDir)})` }
    } catch (err) {
      if (err instanceof EngineAuthMissingError) return { configured: false, hint: authHint(configDir) }
      return { configured: false, hint: `${authHint(configDir)} (probe failed: ${(err as Error).message})` }
    }
  }

  /**
   * Models come from a real `session/new` handshake: the engine reports the
   * model select option it will accept (`id` = exact value for muse config,
   * `label` = display name). Requires credentials like any session.
   */
  async listModels(): Promise<EngineModel[]> {
    const resolved = this.resolve()
    if (!resolved.ok) throw new EngineMissingError(this.kind, resolved.fix)
    const probeDir = mkdtempSync(join(tmpdir(), 'pluton-qwen-modelprobe-'))
    try {
      return await this.withEphemeralSession(probeDir, probeDir, async (created) => {
        const option = readModelOption(created['configOptions'])
        if (!option) throw new CapabilityError(this.kind, 'modelList')
        return option.choices.map((choice) => {
          const model: EngineModel = { id: choice.value, source: 'engine' }
          if (choice.name !== undefined && choice.name !== choice.value) model.label = choice.name
          return model
        })
      })
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  }

  /**
   * Start an ACP session: initialize -> session/new|load -> set mode ->
   * set model (verified) -> hand the session to the runtime.
   */
  async startSession(req: StartSessionRequest): Promise<EngineSession> {
    assertNonEmptyModel(req.muse.model)
    const resolved = this.resolve()
    if (!resolved.ok) throw new EngineMissingError(this.kind, resolved.fix)
    const { invocation } = resolved

    // Qwen Code v0.25.2 crashes at startup (ENOENT via realpathSync) when its
    // home directory does not exist yet; the engine home is Pluton-owned
    // (ADR-0008), so create both layers before spawning.
    mkdirSync(req.configDir, { recursive: true })
    mkdirSync(qwenStateDir(req.configDir), { recursive: true })

    const retryOpts = this.opts.spawnRetry
    const maxRetries = retryOpts?.maxRetries ?? (this.opts.spawnFn ? 0 : 2)
    const effectiveRetry = { ...retryOpts, maxRetries }

    let activeClient: AcpClient | null = null
    try {
      const createAndInitialize = async (): Promise<{
        client: AcpClient
        holder: { session: QwenEngineSession | null }
        agentCapabilities: Record<string, unknown>
      }> => {
        const holder: { session: QwenEngineSession | null } = { session: null }
        const client = new AcpClient({
          command: invocation.command,
          args: [...invocation.baseArgs, '--acp'],
          cwd: req.workdir,
          env: this.spawnEnv(req.configDir, req.env),
          spawnFn: this.opts.spawnFn,
          requestTimeoutMs: this.opts.requestTimeoutMs ?? 60_000,
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
            throw new EngineProtocolError('initialize response is missing agentCapabilities', { details: { init } })
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
        if (agentCapabilities['loadSession'] !== true) throw new CapabilityError(this.kind, 'resumeSession')
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

      await this.applyMode(client, sessionId, configOptions)
      await this.applyModel(client, sessionId, configOptions, req.muse.model)

      const session = new QwenEngineSession({
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
        throw new EngineMissingError(this.kind, `'${invocation.command}' could not be started (ENOENT). ${QWEN_MISSING_FIX}`)
      }
      if (isAuthFailure(err)) throw new EngineAuthMissingError(this.kind, authHint(req.configDir))
      throw err
    }
  }

  /**
   * Ephemeral initialize + session/new used by authStatus/listModels. The
   * session is never prompted; the transport is closed afterwards.
   */
  private async withEphemeralSession<T>(
    cwd: string,
    configDir: string,
    fn: (created: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const resolved = this.resolve()
    if (!resolved.ok) throw new EngineMissingError(this.kind, resolved.fix)
    const { invocation } = resolved
    const client = new AcpClient({
      command: invocation.command,
      args: [...invocation.baseArgs, '--acp'],
      cwd,
      env: this.spawnEnv(configDir, {}),
      spawnFn: this.opts.spawnFn,
      requestTimeoutMs: this.opts.requestTimeoutMs ?? 60_000,
    })
    try {
      await client.start()
      await client.request(
        'initialize',
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      )
      const created = await client.request<Record<string, unknown>>(
        'session/new',
        { cwd, mcpServers: [] },
        { timeoutMs: PROBE_TIMEOUT_MS },
      )
      return await fn(created)
    } catch (err) {
      if (isAuthFailure(err)) throw new EngineAuthMissingError(this.kind, authHint(configDir))
      throw err
    } finally {
      await client.close().catch(() => {
        // probe cleanup is best-effort
      })
    }
  }

  /** Set the session mode explicitly — qwen's own default is 'auto'. */
  private async applyMode(client: AcpClient, sessionId: string, configOptions: unknown): Promise<void> {
    const wanted = this.opts.approvalMode ?? 'default'
    const option = readModeOption(configOptions)
    if (!option) return // engine does not offer a mode select; nothing to fake
    if (option.currentValue === wanted) return
    if (!option.values.includes(wanted)) {
      throw new ValidationError(
        `approval mode '${wanted}' is not offered by engine '${this.kind}'; available: ${option.values.join(', ')}`,
        { details: { requested: wanted, available: option.values } },
      )
    }
    const applied = await client.request<Record<string, unknown>>(
      'session/set_config_option',
      { sessionId, configId: option.id, value: wanted },
      { timeoutMs: CONFIG_SET_TIMEOUT_MS },
    )
    const after = readModeOption(applied['configOptions'])
    if (!after || after.currentValue !== wanted) {
      throw new EngineProtocolError(
        `engine did not switch to approval mode '${wanted}' (reported: ${String(after?.currentValue ?? 'missing')})`,
      )
    }
  }

  /** Pin the model; refuse to run when the engine did not switch. */
  private async applyModel(
    client: AcpClient,
    sessionId: string,
    configOptions: unknown,
    wantModel: string,
  ): Promise<void> {
    const option = readModelOption(configOptions)
    if (!option) throw new CapabilityError(this.kind, 'model_select')
    const choice = matchModelChoice(option, wantModel)
    if (!choice) {
      throw new ValidationError(
        `model '${wantModel}' is not offered by engine '${this.kind}'; available: ${option.choices
          .slice(0, 20)
          .map((c) => c.name ?? c.value)
          .join(', ')}`,
        { details: { requested: wantModel, available: option.values } },
      )
    }
    if (option.currentValue === choice.value) return
    const applied = await client.request<Record<string, unknown>>(
      'session/set_config_option',
      { sessionId, configId: option.id, value: choice.value },
      { timeoutMs: CONFIG_SET_TIMEOUT_MS },
    )
    const after = readModelOption(applied['configOptions'])
    if (!after || after.currentValue !== choice.value) {
      throw new EngineProtocolError(
        `engine did not switch to model '${wantModel}' (reported: ${String(after?.currentValue ?? 'missing')}); refusing to run on an unpinned model`,
      )
    }
  }
}
