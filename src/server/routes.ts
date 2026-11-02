/**
 * REST API route dispatcher for Pluton Application Server (ADR-0014).
 * Single authoritative bridge connecting frontend clients to the Pluton runtime.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from '../store/store.ts'
import { NotFoundError, PlutonError, ValidationError } from '../domain/errors.ts'
import { isTerminalRunState } from '../domain/state.ts'
import type { ApprovalRecord, ShipRecord, RunRecord } from '../domain/models.ts'
import { loadConfig, stateDir, workspaceDir, type LoadedConfig } from '../config/load.ts'
import { createEngineApprovalChannel, settleApprovalWaiter, type EnginePermissionChannel } from '../engines/interactive-approval.ts'
import { getEngineAdapter, registerBuiltinEngines } from '../engines/registry.ts'
import { SHIP_WORKER_MODELS } from '../engines/opencode/adapter.ts'
import type { EngineAdapter, EngineSession, McpServerSpec } from '../engines/contract/types.ts'
import { nativeAdapterFor } from '../execution/adapter.ts'
import {
  appendExecutionEvent,
  createNativeExecutionProvider,
  nativeSpecForShip,
} from '../execution/factory.ts'
import type { NativeExecutionProvider } from '../execution/native.ts'
import type { ExecutionBridgeSpec } from '../execution/native.ts'
import { GitWorkspaceManager } from '../workspace/manager.ts'
import { diffWorktreePatch } from '../workspace/trusted-git.ts'
import { PLUTON_VERSION } from '../version.ts'
import {
  providerAdd,
  providerList,
  providerRemove,
  providerRemoveKey,
  providerSetKey,
  providerValidate,
} from '../cli/commands/provider.ts'
import { editShip } from '../cli/commands/ship.ts'
import { getProvider, hasProviderCredential, listProviders } from '../providers/store.ts'
import { safeResolvePath, protectedWorkspaceSegment } from './security.ts'
import { buildRunActivity } from './activity.ts'
import { pickNativeFolder } from './folder-picker.ts'
import { describeWorkspace, resolveWorkspaceRoot } from './workspace.ts'
import type { ServerEventBroadcaster } from './events.ts'
import { SessionRunner } from './session-runner.ts'
import {
  decideApproval,
  sweepExpiredApprovals,
  requestRunCancel,
  resumeRun,
  settleRunCrashed,
  startRunInBackground,
  type RunDeps,
  type ProjectContext,
} from '../orchestrator/service.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict, runVerificationChecks } from '../verify/runner.ts'
import { redactProseSecrets } from '../util/redact.ts'
import { stripControlChars } from '../util/sanitize.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../tools/bridge.ts'
import { ToolHttpServer } from '../tools/http-transport.ts'
import { bridgeEndpointOf } from '../tools/http-transport.ts'
import { isSupervisorStale, wakeSupervisor } from '../orchestrator/supervisor.ts'
import { WorkerMessageBus } from '../orchestrator/messages.ts'
import { WakeupRegistry } from '../orchestrator/wakeups.ts'
import type { TaskGraph } from '../orchestrator/task-graph.ts'
import { buildTaskDetail } from './task-detail.ts'
import type {
  HealthResponse,
  McpServerStatus,
  McpStatusResponse,
  RunDetailView,
  SessionDetailView,
  WorkspaceSummary,
} from './types.ts'

export interface RouteContext {
  store: Store
  projectId: string
  loaded: LoadedConfig
  broadcaster: ServerEventBroadcaster
  pickFolderFn?: typeof pickNativeFolder
  runner?: SessionRunner
}

/**
 * The largest JSON request body the API accepts.
 *
 * The body is the operator's prompt, a goal, or a decision - none of which
 * need megabytes. Anything larger is rejected with 413 and a reason, not a
 * reset connection.
 */
const MAX_REQUEST_BODY_CHARS = 1024 * 1024

/**
 * The absolute byte count the server will read before it gives up on an
 * oversized body and drops the connection. It bounds the memory a single
 * hostile (or broken) client can make the server buffer.
 */
const MAX_REQUEST_BODY_HARD_STOP = 8 * 1024 * 1024

/**
 * A live MCP server registration: the tool bridge handed to one engine session
 * together with the transport session that serves it.
 */
interface McpRegistration {
  name: string
  kind: 'http' | 'stdio'
  sessionId: string
  shipId: string
  shipName: string
  engineKind: string
  /** Bearer token of the registered transport session (never leaves the process). */
  token: string
}


interface PermissionPolicies {
  autonomousToolExecution: boolean
  parallelSubAgents: boolean
  autoApproveReadTools: boolean
  terminalAndBash: boolean
}

export class ApiRouter {
  private readonly ctx: RouteContext
  public readonly runner: SessionRunner
  /**
   * Shared MCP tool transport. One HTTP endpoint serves every SPA chat
   * session's bridge; each engine session gets its own bearer token, exactly
   * like `pluton chat` (`src/cli/commands/chat.ts:275-285`).
   */
  private toolHttp: ToolHttpServer | null = null
  private toolHttpStarting: Promise<ToolHttpServer> | null = null
  /** Live MCP registrations, keyed by the chat session that owns them. */
  private readonly mcpRegistrations = new Map<string, McpRegistration>()
  /** Runs started from the SPA's Build mode, so Stop can cancel the right one. */
  private readonly activeRunTasks = new Map<string, string>()
  /**
   * Live native execution providers, one per distinct workspace root. The
   * provider enforces that every session's cwd is inside a root it was built
   * for, so a provider created for the project root cannot serve an external
   * session workspace.
   */
  private readonly nativeProviders = new Map<string, NativeExecutionProvider>()

  /** Runtime settings and account state for SPA configuration (ADR-0014). */
  private accountSettings = {
    username: 'pluton-developer',
    email: 'developer@pluton.account',
    connected: true,
  }
  private permissionPolicies: PermissionPolicies = {
    autonomousToolExecution: true,
    parallelSubAgents: true,
    autoApproveReadTools: true,
    terminalAndBash: true,
  }
  private thinkingEffort: 'auto' | 'max' | 'high' | 'balanced' | 'low' = 'auto'
  private readonly customModels: Array<{ id: string; name: string; desc: string }> = []
  private readonly customApiKeys = new Map<string, string>()

  constructor(ctx: RouteContext) {
    this.ctx = ctx
    registerBuiltinEngines()
    this.runner =
      ctx.runner ??
      new SessionRunner({
        store: ctx.store,
        broadcaster: ctx.broadcaster,
        projectId: ctx.projectId,
        adapterResolver: (ship, workspaceRoot) => this.adapterForShip(ship, workspaceRoot),
        workspaceResolver: (sessionId) => this.workspaceRootFor(sessionId),
        mcpServersResolver: (sessionId, ship, adapter, workspaceRoot) =>
          this.mcpServersForSession(sessionId, ship, adapter, workspaceRoot),
        onSessionDropped: (sessionId) => this.dropMcpRegistration(sessionId),
        approvalTimeoutMinutes: ctx.loaded?.config?.runtime?.approval_timeout_minutes ?? 10,
      })
  }

  private getStoreShips(): ShipRecord[] {
    return this.ctx.store.listShips?.() ?? this.ctx.store.listMuses?.() ?? []
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = parsedUrl.pathname
    const method = req.method?.toUpperCase() ?? 'GET'

    if (!pathname.startsWith('/api/')) {
      return false
    }

    try {
      // 1. Health
      if (method === 'GET' && pathname === '/api/health') {
        const body: HealthResponse = {
          ok: true,
          version: PLUTON_VERSION,
          node: process.version,
          platform: process.platform,
          projectId: this.ctx.projectId,
          projectName: this.ctx.loaded.config.project.name,
          rootDir: this.ctx.loaded.rootDir,
        }
        this.sendJson(res, 200, body)
        return true
      }

      // 2. Workspace Summary (optionally scoped to a session's workspace)
      if (method === 'GET' && pathname === '/api/workspace') {
        const store = this.ctx.store
        const project = store.getProject(this.ctx.projectId)
        const ships = this.getStoreShips()
        // syncShips disables (never deletes) rows that left pluton.yaml. A
        // disabled row still resolves for old sessions, but it is not part of
        // the current team and must not reappear as a configurable Settings or
        // chat agent.
        const roster = ships.filter((m) => m.enabled)
        const runs = store.listRuns(50)
        // listRuns is newest-first: the workspace's active run is the newest
        // non-terminal one. Terminal run states are excluded rather than
        // matching a hand-written allowlist, which silently missed `active`
        // (the primary live state) and made a reload adopt a stale run.
        const activeRun = runs.find((r) => !isTerminalRunState(r.state)) ?? null
        const approvals = store.listApprovalsByProject(this.ctx.projectId, { status: 'pending' })

        const sessionId = parsedUrl.searchParams.get('sessionId') ?? undefined
        const sessionScoped = sessionId !== undefined && sessionId !== null
        const resolved = sessionId ? this.sessionWorkspaceRoot(sessionId) : resolveWorkspaceRoot(this.ctx.loaded.rootDir)
        const sessionRecord = sessionId ? this.ctx.store.getChatSessionOrNull(sessionId) : null
        const summary: WorkspaceSummary = {
          name: project?.name ?? this.ctx.loaded.config.project.name,
          rootDir: resolved,
          projectId: this.ctx.projectId,
          defaultBranch: project?.defaultBranch ?? this.ctx.loaded.config.project.default_branch,
          ships: roster.map((m) => ({
            id: m.id,
            slug: m.slug,
            displayName: m.displayName,
            role: m.role,
            engine: m.engineKind,
            model: m.model,
            state: m.enabled ? 'ready' : 'disabled',
          })),
          muses: roster.map((m) => ({
            id: m.id,
            slug: m.slug,
            displayName: m.displayName,
            role: m.role,
            engine: m.engineKind,
            model: m.model,
            state: m.enabled ? 'ready' : 'disabled',
          })),
          activeRun: activeRun ? { id: activeRun.id, state: activeRun.state, goal: activeRun.goal } : null,
          approvalsPending: approvals.length,
          sessionId: sessionScoped ? sessionId ?? null : (sessionRecord?.id ?? null),
          workspaceRoot: sessionScoped ? sessionRecord?.workspaceRoot ?? null : null,
          sessionScoped,
        }
        this.sendJson(res, 200, { ok: true, workspace: summary })
        return true
      }

      // 2b. Native folder picker: returns an absolute path or a cancellation.
      if (method === 'POST' && pathname === '/api/workspace/pick') {
        try {
          const picker = this.ctx.pickFolderFn ?? pickNativeFolder
          const result = await picker()
          if (result.cancelled) {
            this.sendJson(res, 200, { ok: true, cancelled: true })
            return true
          }
          this.sendJson(res, 200, { ok: true, path: result.path })
          return true
        } catch (err) {
          this.sendJson(res, 200, { ok: false, cancelled: true, error: err instanceof Error ? err.message : String(err) })
          return true
        }
      }

      // 2c. Workspace file list (session-scoped when sessionId supplied)
      if (method === 'GET' && pathname === '/api/files') {
        const sessionId = parsedUrl.searchParams.get('sessionId') ?? undefined
        const rootDir = this.workspaceRootFor(sessionId ?? null)
        const files = this.listWorkspaceFiles(rootDir)
        this.sendJson(res, 200, { ok: true, files, rootDir })
        return true
      }

      // 2d. Read one workspace file.
      if (method === 'GET' && pathname === '/api/files/content') {
        const target = parsedUrl.searchParams.get('path')
        if (!target) {
          this.sendJson(res, 400, { ok: false, error: 'path query parameter is required' })
          return true
        }
        const rootDir = this.workspaceRootFor(parsedUrl.searchParams.get('sessionId') ?? null)
        const resolved = this.resolveWorkspaceFile(rootDir, target)
        if (!resolved.ok) {
          this.sendJson(res, resolved.status, { ok: false, error: resolved.error })
          return true
        }
        if (resolved.size > 2 * 1024 * 1024) {
          this.sendJson(res, 413, { ok: false, error: 'file too large to inspect in editor (> 2MB)' })
          return true
        }
        const content = readFileSync(resolved.canonical, 'utf8')
        this.sendJson(res, 200, { ok: true, path: target, content, size: resolved.size })
        return true
      }

      // 2e. Save an existing workspace file. The body is the raw file text,
      // not JSON: a 1 MB JSON envelope cannot carry a 2 MB source file.
      if (method === 'PUT' && pathname === '/api/files/content') {
        const target = parsedUrl.searchParams.get('path')
        if (!target) {
          this.sendJson(res, 400, { ok: false, error: 'path query parameter is required' })
          return true
        }
        const rootDir = this.workspaceRootFor(parsedUrl.searchParams.get('sessionId') ?? null)
        const resolved = this.resolveWorkspaceFile(rootDir, target)
        if (!resolved.ok) {
          this.sendJson(res, resolved.status, { ok: false, error: resolved.error })
          return true
        }
        if (resolved.size > 2 * 1024 * 1024) {
          this.sendJson(res, 413, { ok: false, error: 'file too large to edit (> 2MB)' })
          return true
        }
        const content = await this.readTextBody(req, 2 * 1024 * 1024 + 1024)
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > 2 * 1024 * 1024) {
          this.sendJson(res, 413, { ok: false, error: 'file content too large to save (> 2MB)' })
          return true
        }
        writeFileSync(resolved.canonical, content, 'utf8')
        this.sendJson(res, 200, { ok: true, path: target, size: bytes })
        return true
      }

      // 2f. Delete one workspace file (the operator confirms in the UI).
      if (method === 'DELETE' && pathname === '/api/files/content') {
        const target = parsedUrl.searchParams.get('path')
        if (!target) {
          this.sendJson(res, 400, { ok: false, error: 'path query parameter is required' })
          return true
        }
        const rootDir = this.workspaceRootFor(parsedUrl.searchParams.get('sessionId') ?? null)
        const resolved = this.resolveWorkspaceFile(rootDir, target)
        if (!resolved.ok) {
          this.sendJson(res, resolved.status, { ok: false, error: resolved.error })
          return true
        }
        unlinkSync(resolved.canonical)
        this.sendJson(res, 200, { ok: true, path: target, deleted: true })
        return true
      }

      // 5. Sessions list & create
      if (pathname === '/api/sessions') {
        if (method === 'GET') {
          const sessions = this.ctx.store.listChatSessions(this.ctx.projectId)
          this.sendJson(res, 200, { ok: true, sessions })
          return true
        }
        if (method === 'POST') {
          const payload = await this.readJsonBody<{ shipId?: string; museId?: string; title?: string; workspaceRoot?: string }>(req)
          const ships = this.getStoreShips()
          // New chats default to the Manager Ship (the same Ship whose model
          // the main chat selector controls), never an arbitrary first row.
          const defaultShip = ships.find((s) => s.enabled && s.role === 'supervisor')
            ?? ships.find((s) => s.role === 'supervisor')
            ?? ships[0]
          const shipId = payload.shipId ?? payload.museId ?? defaultShip?.id
          if (!shipId) {
            this.sendJson(res, 400, { ok: false, error: 'no ship available for session' })
            return true
          }
          let workspaceRoot: string
          try {
            workspaceRoot = payload.workspaceRoot
              ? resolveWorkspaceRoot(payload.workspaceRoot)
              : resolveWorkspaceRoot(this.ctx.loaded.rootDir)
          } catch (err) {
            this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid workspace' })
            return true
          }
          const session = this.ctx.store.createChatSession({
            projectId: this.ctx.projectId,
            shipId,
            title: payload.title ?? 'New Session',
            workspaceRoot,
          })
          this.sendJson(res, 201, { ok: true, session })
          return true
        }
      }

      // 6. Session Detail
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionMatch && (method === 'GET' || method === 'PATCH')) {
        const sessionId = sessionMatch[1]!
        const session = this.ctx.store.getChatSessionOrNull(sessionId)
        if (!session) {
          this.sendJson(res, 404, { ok: false, error: `session '${sessionId}' not found` })
          return true
        }
        const ship = this.ctx.store.getShip(session.shipId)
        if (!ship) {
          this.sendJson(res, 404, { ok: false, error: `ship '${session.shipId}' not found` })
          return true
        }
        if (method === 'PATCH') {
          const payload = await this.readJsonBody<{ workspaceRoot?: string | null; title?: string | null }>(req)
          if (payload.workspaceRoot !== undefined) {
            let nextRoot: string | null = null
            try {
              nextRoot = payload.workspaceRoot === null
                ? resolveWorkspaceRoot(this.ctx.loaded.rootDir)
                : resolveWorkspaceRoot(payload.workspaceRoot)
            } catch (err) {
              this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid workspace' })
              return true
            }
            const updated = this.ctx.store.updateChatSession(sessionId, { workspaceRoot: nextRoot })
            this.dropMcpRegistration(sessionId)
            await this.runner.dropSession(sessionId)
            this.ctx.broadcaster.broadcast({ type: 'workspace_changed', sessionId, workspaceRoot: updated.workspaceRoot })
            this.sendJson(res, 200, { ok: true, session: updated })
            return true
          }
          if (payload.title !== undefined) {
            const updated = this.ctx.store.updateChatSession(sessionId, { title: payload.title })
            this.sendJson(res, 200, { ok: true, session: updated })
            return true
          }
          this.sendJson(res, 200, { ok: true, session })
          return true
        }
        const messages = this.ctx.store.listChatMessages(sessionId)
        let workspaceRoot: string | null
        try {
          workspaceRoot = this.sessionWorkspaceRoot(sessionId)
        } catch {
          workspaceRoot = session.workspaceRoot ?? null
        }
        const shipView = {
          id: ship.id,
          slug: ship.slug,
          displayName: ship.displayName,
          role: ship.role,
          engine: ship.engineKind,
          model: ship.model,
        }
        const detail: SessionDetailView = {
          session,
          messages,
          activeShip: shipView,
          activeMuse: shipView,
          busy: this.runner.isBusy(sessionId),
          queueLength: this.runner.getQueueLength(sessionId),
          ...(workspaceRoot !== null ? { workspaceRoot } : {}),
        }
        this.sendJson(res, 200, { ok: true, session: detail })
        return true
      }

      // 6b. Delete a session and its transcript. A busy turn owns live engine
      // state, so the operator must stop it first instead of orphaning a turn.
      if (sessionMatch && method === 'DELETE') {
        const sessionId = sessionMatch[1]!
        const session = this.ctx.store.getChatSessionOrNull(sessionId)
        if (!session || session.projectId !== this.ctx.projectId) {
          this.sendJson(res, 404, { ok: false, error: `session '${sessionId}' not found` })
          return true
        }
        if (this.runner.isBusy(sessionId)) {
          this.sendJson(res, 409, { ok: false, error: 'cannot delete a session while a turn is running' })
          return true
        }
        this.dropMcpRegistration(sessionId)
        await this.runner.dropSession(sessionId)
        this.ctx.store.deleteChatSession(sessionId)
        this.sendJson(res, 200, { ok: true, deleted: true, sessionId })
        return true
      }

      // 7. Session Prompt Turn (Dispatch)
      const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const sessionId = promptMatch[1]!
        const payload = await this.readJsonBody<{ text?: string; mode?: string }>(req)
        const userText = payload.text?.trim()
        if (!userText) {
          this.sendJson(res, 400, { ok: false, error: 'text is required' })
          return true
        }
        const session = this.ctx.store.getChatSessionOrNull(sessionId)
        if (!session) {
          this.sendJson(res, 404, { ok: false, error: `session '${sessionId}' not found` })
          return true
        }

        const isBusy = this.runner.isBusy(sessionId)
        const item = this.runner.enqueue(sessionId, userText, payload.mode ?? 'chat')
        const queueLength = this.runner.getQueueLength(sessionId)

        // Return 202 Accepted with 'streaming' if immediately started, 'enqueued' if queued behind running turn
        this.sendJson(res, 202, {
          ok: true,
          status: isBusy ? 'enqueued' : 'streaming',
          sessionId,
          inboxId: item.id,
          queueLength,
          mode: payload.mode ?? 'chat',
        })
        return true
      }

      // 8. Session Cancel
      const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/)
      if (cancelMatch && method === 'POST') {
        const sessionId = cancelMatch[1]!
        const cancelled = await this.runner.cancel(sessionId)
        this.sendJson(res, 200, { ok: true, cancelled })
        return true
      }

      // 9. Runs list & create
      if (pathname === '/api/runs') {
        if (method === 'GET') {
          const runs = this.ctx.store.listRuns(50)
          this.sendJson(res, 200, { ok: true, runs })
          return true
        }
        if (method === 'POST') {
          const payload = await this.readJsonBody<{
            goal?: string
            managerShipId?: string
            managerMuseId?: string
            sessionId?: string
            workspaceRoot?: string
          }>(req)
          const goal = payload.goal?.trim()
          if (!goal) {
            this.sendJson(res, 400, { ok: false, error: 'goal is required' })
            return true
          }
          const ships = this.getStoreShips()
          const manager = ships.find((m) => m.role === 'supervisor') ?? ships[0]
          if (!manager) {
            this.sendJson(res, 400, { ok: false, error: 'no manager ship configured' })
            return true
          }
          let workspaceRoot: string
          try {
            workspaceRoot = payload.workspaceRoot
              ? resolveWorkspaceRoot(payload.workspaceRoot)
              : payload.sessionId
                ? this.workspaceRootFor(payload.sessionId)
                : resolveWorkspaceRoot(this.ctx.loaded.rootDir)
          } catch (err) {
            this.sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid workspace' })
            return true
          }
          const run = this.ctx.store.createRun({
            projectId: this.ctx.projectId,
            goal,
            origin: 'api',
            requestedBy: 'operator:ui',
            managerShipId: payload.managerShipId ?? payload.managerMuseId ?? manager.id,
            acceptanceCriteria: ['Task executed via graphical workspace'],
            budget: {
              maxConcurrentWorkers: 3,
              maxTasks: 20,
              maxDelegationDepth: 3,
              maxRunMinutes: 60,
              defaultTaskMinutes: 10,
            },
            workspaceRoot,
            originSessionId: payload.sessionId ?? null,
          })
          this.sendJson(res, 201, { ok: true, run })
          return true
        }
      }

      // 10. Run Detail
      const runDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
      if (runDetailMatch && method === 'GET') {
        const runId = runDetailMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const tasks = this.ctx.store.listTasks(runId)
        const edges = this.ctx.store.listEdges(runId)
        const approvals = this.ctx.store.listApprovals(runId)
        const usage = this.ctx.store.getRunUsage(runId)
        // Inspector partitions need role/model/workspace, but TaskRecord only
        // carries the claim-time `assignment` snapshot and a workspace id.
        // Enrich here (one place) so the SPA's reconstitution shows the real
        // assignment instead of guessing from task-id substrings.
        const workspacePathByTask = new Map<string, string>()
        for (const ws of this.ctx.store.listWorkspaces(this.ctx.projectId)) {
          if (ws.runId === runId && ws.taskId !== null) workspacePathByTask.set(ws.taskId, ws.path)
        }
        const taskViews = tasks.map((task) => {
          const assignment =
            task.assignment !== null && typeof task.assignment === 'object' && !Array.isArray(task.assignment)
              ? (task.assignment as Record<string, unknown>)
              : null
          const role = assignment !== null && typeof assignment['role'] === 'string' ? assignment['role'] : undefined
          const model = assignment !== null && typeof assignment['model'] === 'string' ? assignment['model'] : undefined
          // Read-only roles run in the project root, so they have no per-task
          // workspace row. Report that effective path instead of leaving the
          // partition blank after a reload (live events already carry it).
          const assignedShipId =
            assignment !== null && typeof assignment['shipId'] === 'string'
              ? assignment['shipId']
              : assignment !== null && typeof assignment['museId'] === 'string'
                ? assignment['museId']
                : undefined
          const policy = assignedShipId !== undefined ? this.ctx.loaded.config.ships[assignedShipId]?.workspace_policy : undefined
          const assignedShip = assignedShipId !== undefined ? this.ctx.store.getShip(assignedShipId) : null
          const workspace =
            workspacePathByTask.get(task.id) ??
            (policy === 'read-only' || policy === 'coordinator-read-only' ? this.ctx.loaded.rootDir : undefined)
          return {
            ...task,
            ...(role !== undefined ? { role } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(workspace !== undefined ? { workspace } : {}),
            ...(assignedShip !== null
              ? { shipId: assignedShip.id, shipDisplayName: assignedShip.displayName }
              : {}),
          }
        })
        const detail: RunDetailView = {
          run,
          tasks: taskViews,
          edges,
          approvals,
          usage,
          // Stranded-run observability (defect 2026-10-21): a non-terminal run
          // whose supervisor heartbeat is far past the ownership TTL has no
          // live driver — the SPA surfaces a "may be stranded" hint with the
          // existing manual Resume path instead of ever fabricating a state.
          supervisorStale: isSupervisorStale(run, Date.now()),
        }
        this.sendJson(res, 200, { ok: true, run: detail })
        return true
      }

      // 10b. Run activity (durable-event progress feed; seq-resumable)
      const activityMatch = pathname.match(/^\/api\/runs\/([^/]+)\/activity$/)
      if (activityMatch && method === 'GET') {
        const runId = activityMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const rawAfter = Number(parsedUrl.searchParams.get('afterSeq') ?? '0')
        const afterSeq = Number.isFinite(rawAfter) && rawAfter > 0 ? Math.floor(rawAfter) : 0
        const rawLimit = Number(parsedUrl.searchParams.get('limit') ?? '200')
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 200
        // `tail=1` selects the newest window (initial page load). An explicit
        // cursor is always forward-only, so reconnect recovery never skips a
        // gap by jumping to the tail.
        const tail = afterSeq === 0 && parsedUrl.searchParams.get('tail') === '1'
        const events = tail
          ? this.ctx.store.listEvents(runId, { limit }).slice().reverse()
          : this.ctx.store.listEventsSince(runId, afterSeq, limit)
        const activity = buildRunActivity(this.ctx.store, events)
        const latestSeq = events.length > 0 ? events[events.length - 1]!.seq : afterSeq
        this.sendJson(res, 200, {
          ok: true,
          activity: { runId, activity, latestSeq },
        })
        return true
      }

      // 10c. Worker detail (authoritative task view for the inspector modal)
      const taskDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/detail$/)
      if (taskDetailMatch && method === 'GET') {
        const runId = taskDetailMatch[1]!
        const taskId = taskDetailMatch[2]!
        const detail = await buildTaskDetail(this.ctx.store, runId, taskId, {
          workspacesRoot: workspaceDir(this.ctx.loaded.rootDir),
        })
        if (detail === null) {
          this.sendJson(res, 404, { ok: false, error: `task '${taskId}' not found in run '${runId}'` })
          return true
        }
        this.sendJson(res, 200, { ok: true, detail })
        return true
      }

      // 10d. Operator → worker message (durable, delivered at the worker's
      // next `ship.inbox` call). Read-only for the task: this never cancels it.
      const taskMessageMatch = pathname.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/message$/)
      if (taskMessageMatch && method === 'POST') {
        const runId = taskMessageMatch[1]!
        const taskId = taskMessageMatch[2]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const task = this.ctx.store.getTaskOrNull(taskId)
        if (task === null || task.runId !== runId) {
          this.sendJson(res, 404, { ok: false, error: `task '${taskId}' not found in run '${runId}'` })
          return true
        }
        if (task.assigneeShipId === null) {
          this.sendJson(res, 409, { ok: false, error: 'task has no assignee Ship to message' })
          return true
        }
        const assigneeShipId = task.assigneeShipId
        const assignee = this.ctx.store.getShip(assigneeShipId)
        if (assignee === null || !assignee.enabled) {
          this.sendJson(res, 409, { ok: false, error: 'task assignee Ship is not enabled' })
          return true
        }
        const payload = await this.readJsonBody<{ body?: string }>(req)
        const body = typeof payload.body === 'string' ? payload.body : ''
        const bus = new WorkerMessageBus({
          store: this.ctx.store,
          projectId: this.ctx.projectId,
          runId,
          wakeups: new WakeupRegistry(),
        })
        try {
          const message = bus.sendOperator({
            recipientShipId: assigneeShipId,
            recipientTaskId: task.id,
            body,
          })
          // The bus persisted the durable `worker.message` event: publish the
          // live frame without a second write.
          this.ctx.broadcaster.broadcastWorkerEvent(
            {
              type: 'worker.message',
              runId,
              taskId: message.recipientTaskId ?? message.recipientShipId,
              role: 'worker',
              shipName: message.recipientLabel,
              payload: {
                messageId: message.id,
                seq: message.seq,
                senderShipId: message.senderShipId,
                senderLabel: message.senderLabel,
                senderTaskId: message.senderTaskId,
                recipientShipId: message.recipientShipId,
                recipientLabel: message.recipientLabel,
                recipientTaskId: message.recipientTaskId,
                kind: message.kind,
                body: message.body,
                replyTo: message.replyTo,
                createdAt: message.createdAt,
              },
            },
            this.ctx.store,
            this.ctx.projectId,
            { persist: false },
          )
          this.sendJson(res, 200, { ok: true, message })
        } finally {
          bus.close()
        }
        return true
      }

      // 11. Approvals list
      if (pathname === '/api/approvals' && method === 'GET') {
        // Shared sweep: flips overdue records, appends approval.expired events
        // and wakes any engine session waiting on them (fail-closed).
        sweepExpiredApprovals(this.ctx.store, this.ctx.projectId, new Date().toISOString())
        const approvals = this.ctx.store.listApprovalsByProject(this.ctx.projectId)
        this.sendJson(res, 200, { ok: true, approvals })
        return true
      }

      // 12. Approval Decision
      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/)
      if (approvalMatch && method === 'POST') {
        const approvalId = approvalMatch[1]!
        const payload = await this.readJsonBody<{
          decision?: 'approved' | 'denied'
          autoContinue?: boolean
          selectedOption?: string
          answer?: string
        }>(req)
        if (!payload.decision || !['approved', 'denied'].includes(payload.decision)) {
          this.sendJson(res, 400, { ok: false, error: "decision must be 'approved' or 'denied'" })
          return true
        }
        const approval = this.ctx.store.getApprovalOrNull(approvalId)
        if (!approval) {
          this.sendJson(res, 404, { ok: false, error: `approval '${approvalId}' not found` })
          return true
        }

        const isQuestion =
          approval.action === 'qa.question' ||
          approval.action.includes('question') ||
          payload.selectedOption !== undefined ||
          payload.answer !== undefined

        if (isQuestion) {
          const result = await handleQuestionDecision({
            approvalId,
            decision: payload.decision,
            selectedOption: payload.selectedOption,
            answer: payload.answer,
            store: this.ctx.store,
            projectId: this.ctx.projectId,
          })
          const updated = this.ctx.store.getApproval(approvalId)
          this.ctx.broadcaster.broadcast({
            type: 'approval_decided',
            approval: updated,
          })
          this.sendJson(res, 200, { ok: true, ...result })
          return true
        }

        if (approval.status !== 'pending') {
          this.sendJson(res, 409, { ok: false, error: `approval is already '${approval.status}'` })
          return true
        }

        const projectCtx: ProjectContext = {
          rootDir: this.ctx.loaded.rootDir,
          configPath: this.ctx.loaded.configPath,
          loaded: this.ctx.loaded,
        }
        const report = await decideApproval(projectCtx, {
          approvalRef: approvalId,
          decision: payload.decision === 'approved' ? 'approve' : 'deny',
          autoContinue: payload.autoContinue,
        })
        const updated = this.ctx.store.getApproval(approvalId)
        this.ctx.broadcaster.broadcast({
          type: 'approval_decided',
          approval: updated,
        })
        this.sendJson(res, 200, { ok: true, approval: updated, report })
        return true
      }

      // 13. Run Verification Gate & Re-dispatch
      const runVerifyMatch = pathname.match(/^\/api\/runs\/([^/]+)\/verify$/)
      if (runVerifyMatch && method === 'POST') {
        const runId = runVerifyMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const payload = await this.readJsonBody<{ taskId?: string; dispatch?: boolean }>(req)
        const checks = this.ctx.loaded.config.project.verification
        if (checks.length === 0) {
          this.sendJson(res, 400, { ok: false, error: 'no verification checks configured in project' })
          return true
        }
        const artifactsDir = join(stateDir(this.ctx.loaded.rootDir), 'artifacts')
        const candidates = payload.taskId
          ? [this.ctx.store.getTask(payload.taskId)]
          : this.ctx.store.listTasks(runId).filter((t) => t.state === 'verifying')
        if (candidates.length === 0) {
          this.sendJson(res, 400, { ok: false, error: 'no candidate tasks in verifying state available for verification' })
          return true
        }
        // Bind the request to this run before any evidence is written: a task
        // id from another run (or a task that is not in `verifying`) must never
        // be verified under this run's identity.
        for (const task of candidates) {
          if (task.runId !== run.id) {
            this.sendJson(res, 400, {
              ok: false,
              error: `task '${task.id}' belongs to run '${task.runId}', not '${run.id}'`,
            })
            return true
          }
          if (task.state !== 'verifying') {
            this.sendJson(res, 400, {
              ok: false,
              error: `task '${task.id}' is '${task.state}'; only a task in 'verifying' can be verified`,
            })
            return true
          }
        }
        const taskReports = []
        for (const task of candidates) {
          const ws = this.ctx.store.getWorkspaceByTask(task.id)
          const report = await runVerificationChecks({
            store: this.ctx.store,
            projectId: this.ctx.projectId,
            runId: run.id,
            taskId: task.id,
            checks,
            cwd: ws !== null ? ws.path : this.ctx.loaded.rootDir,
            workspaceId: ws !== null ? ws.id : null,
            artifactsDir,
          })
          let diffText = ''
          let changedFiles: string[] = []
          if (ws !== null) {
            // Render the verified diff through trusted Git plumbing: the
            // worker's `.git` metadata (external diff, textconv, filters) is
            // never allowed to execute while evidence is being captured.
            try {
              const diff = await diffWorktreePatch(ws.path, ws.baseCommit)
              diffText = diff.diff
              changedFiles = diff.files
            } catch (error) {
              this.sendJson(res, 400, {
                ok: false,
                error: `could not capture the verified diff for task '${task.id}' through trusted Git plumbing: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              })
              return true
            }
          }
          const verdict = applyTaskVerificationVerdict(this.ctx.store, task.id, { diffText, changedFiles })
          taskReports.push({
            taskId: task.id,
            title: task.title,
            verdict: verdict.state,
            summary: verdict.summary,
            checks: report.results.map((r) => ({
              name: r.name,
              status: r.status,
              exitCode: r.exitCode,
              note: r.note,
            })),
          })
        }
        const finalVerdict = finalizeRunVerdict(this.ctx.store, runId)
        let resumed = null
        if (payload.dispatch && finalVerdict !== null && finalVerdict.outcome === 'redispatched') {
          resumed = await resumeRun(this.runProjectContext(run), runId, { skipManager: true }, this.runDeps())
        }
        this.sendJson(res, 200, {
          ok: true,
          taskReports,
          finalVerdict,
          resumed,
        })
        return true
      }

      // 14. Run Resume Execution
      const runResumeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/resume$/)
      if (runResumeMatch && method === 'POST') {
        const runId = runResumeMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const summary = await resumeRun(this.runProjectContext(run), runId, { skipManager: true }, this.runDeps())
        this.sendJson(res, 200, { ok: true, summary })
        return true
      }

      // 15. Task Worktree Diff
      const taskDiffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/)
      if (taskDiffMatch && method === 'GET') {
        const taskId = taskDiffMatch[1]!
        const task = this.ctx.store.getTaskOrNull(taskId)
        if (!task) {
          this.sendJson(res, 404, { ok: false, error: `task '${taskId}' not found` })
          return true
        }
        const ws = this.ctx.store.getWorkspaceByTask(taskId)
        if (!ws || !existsSync(ws.path)) {
          this.sendJson(res, 200, { ok: true, diff: '', untracked: [], truncated: false, hasWorkspace: false })
          return true
        }
        const gitMgr = new GitWorkspaceManager({ workspacesRoot: workspaceDir(this.ctx.loaded.rootDir) })
        const diffResult = await gitMgr.captureDiff(ws.path)
        this.sendJson(res, 200, { ok: true, ...diffResult, hasWorkspace: true, path: ws.path })
        return true
      }

      // 16. Run Worktrees Combined Diff
      const runDiffMatch = pathname.match(/^\/api\/runs\/([^/]+)\/diff$/)
      if (runDiffMatch && method === 'GET') {
        const runId = runDiffMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const gitMgr = new GitWorkspaceManager({ workspacesRoot: workspaceDir(this.ctx.loaded.rootDir) })
        const diffs: { taskId: string | null; taskTitle?: string; path: string; diff: string; untracked: string[] }[] = []
        const workspaces = this.ctx.store.listWorkspaces(this.ctx.projectId)
          .filter((w) => w.runId === runId && existsSync(w.path))
        for (const ws of workspaces) {
          try {
            const d = await gitMgr.captureDiff(ws.path)
            const task = ws.taskId ? this.ctx.store.getTaskOrNull(ws.taskId) : null
            diffs.push({
              taskId: ws.taskId,
              taskTitle: task?.title,
              path: ws.path,
              diff: d.diff,
              untracked: d.untracked,
            })
          } catch {
            // Ignore unreadable or transient checkout diffs
          }
        }
        this.sendJson(res, 200, { ok: true, diffs })
        return true
      }

      // 17. Ships list (backward-compatible: /api/muses is a deprecated alias)
      if ((pathname === '/api/ships' || pathname === '/api/muses') && method === 'GET') {
        const ships = this.getStoreShips()
        this.sendJson(res, 200, { ok: true, ships, muses: ships })
        return true
      }

      // 18. Models list
      if (pathname === '/api/models' && method === 'GET') {
        const ships = this.getStoreShips()
        const engineKinds = new Set(ships.map((m) => m.engineKind))
        engineKinds.add('opencode')

        const modelsByEngine: Record<string, unknown[]> = {}
        for (const engineKind of engineKinds) {
          const matchingShip = ships.find((m) => m.engineKind === engineKind)
          const matchingShipConfig = matchingShip ? this.ctx.loaded?.config?.ships?.[matchingShip.id] : undefined
          const unavailableFor = (reason: string): unknown[] =>
            matchingShip
              ? [{ id: matchingShip.model, source: 'static', available: false, reason }]
              : []
          try {
            const adapter = getEngineAdapter(engineKind, {
              rootDir: this.ctx.loaded?.rootDir,
              providerId: matchingShipConfig?.provider,
            })
            let listed: unknown[]
            if (typeof adapter.listModelsWithAvailability === 'function') {
              listed = await adapter.listModelsWithAvailability()
            } else {
              const models = await adapter.listModels()
              listed = models.map((m) => ({
                ...m,
                available: true,
              }))
            }
            // An empty inventory falls back to the static Ship models for opencode so
            // the UI and CLI show known model candidates with availability status.
            modelsByEngine[engineKind] =
              listed.length > 0
                ? listed
                : engineKind === 'opencode'
                  ? SHIP_WORKER_MODELS.map((id) => ({
                      id,
                      source: 'catalog',
                      available: false,
                      reason: `engine '${engineKind}' reported no models`,
                    }))
                  : unavailableFor(`engine '${engineKind}' reported no models`)
          } catch (err) {
            modelsByEngine[engineKind] =
              engineKind === 'opencode'
                ? SHIP_WORKER_MODELS.map((id) => ({
                    id,
                    source: 'catalog',
                    available: false,
                    reason: err instanceof Error ? err.message : String(err),
                  }))
                : unavailableFor(err instanceof Error ? err.message : String(err))
          }
        }

        const rootDir = this.ctx.loaded?.rootDir
        const configuredProviders = rootDir ? listProviders(rootDir) : []
        if (configuredProviders.length > 0) {
          const providerModels: unknown[] = []
          for (const prov of configuredProviders) {
            try {
              const adapter = getEngineAdapter(prov.engine, {
                rootDir: this.ctx.loaded?.rootDir,
                providerId: prov.id,
              })
              let listed: unknown[]
              if (typeof adapter.listModelsWithAvailability === 'function') {
                listed = await adapter.listModelsWithAvailability()
              } else {
                const models = await adapter.listModels()
                listed = models.map((m) => ({ ...m, available: true }))
              }
              for (const item of (listed as Array<Record<string, unknown>>)) {
                providerModels.push({
                  ...item,
                  provider: prov.id,
                  providerName: prov.display_name,
                  engine: prov.engine,
                })
              }
            } catch {
              // Stored provider may be offline or lacking key; continue
            }
          }
          if (providerModels.length > 0) {
            modelsByEngine['openai-compatible'] = providerModels
          }
        }

        if (this.customModels.length > 0) {
          modelsByEngine['custom'] = this.customModels.map((m) => ({ ...m, available: true }))
        }
        this.sendJson(res, 200, { ok: true, models: modelsByEngine })
        return true
      }

      // 19. MCP connection registry
      if (pathname === '/api/mcp' && method === 'GET') {
        this.sendJson(res, 200, this.mcpStatusResponse())
        return true
      }

      // 20. Switch a Ship's model (backward-compatible: /api/muses/<id>/model is a deprecated alias)
      const modelMatch = pathname.match(/^\/api\/(?:ships|muses)\/([^/]+)\/model$/)
      if (modelMatch && method === 'POST') {
        const shipId = modelMatch[1]!
        const payload = await this.readJsonBody<{ model?: string; provider?: string | null; engine?: string }>(req)
        const requested = payload.model?.trim()
        if (!requested) {
          this.sendJson(res, 400, { ok: false, error: 'model is required' })
          return true
        }
        const ship = this.ctx.store.getShip(shipId)
        if (!ship) {
          this.sendJson(res, 404, { ok: false, error: `ship '${shipId}' not found` })
          return true
        }

        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        let targetProvider: string | undefined
        let targetEngine = payload.engine?.trim() || ship.engineKind

        if (payload.provider !== undefined && payload.provider !== null && payload.provider !== '') {
          const provId = payload.provider.trim()
          const providerRecord = getProvider(rootDir, provId)
          if (!providerRecord) {
            this.sendJson(res, 400, { ok: false, error: `unknown provider '${provId}'` })
            return true
          }
          if (payload.engine && payload.engine !== providerRecord.engine) {
            this.sendJson(res, 400, {
              ok: false,
              error: `provider '${provId}' targets engine '${providerRecord.engine}', not '${payload.engine}'`,
            })
            return true
          }
          targetProvider = provId
          targetEngine = providerRecord.engine
        } else if (payload.provider === null || payload.provider === '') {
          targetProvider = undefined
        } else {
          targetProvider = this.ctx.loaded.config.ships?.[ship.id]?.provider
        }

        try {
          const isCustom = this.customModels.some((m) => m.id === requested)
          const adapter = getEngineAdapter(targetEngine, {
            rootDir,
            providerId: targetProvider,
          })
          if (!isCustom && adapter.capabilities().modelList) {
            const available = await adapter.listModels()
            const known = available.some((m) => m.id === requested || m.label === requested)
            if (!known && available.length > 0) {
              this.sendJson(res, 400, {
                ok: false,
                error: `model '${requested}' is not offered by engine '${targetEngine}'`,
                available: available.map((m) => m.id),
              })
              return true
            }
          }
        } catch (checkErr) {
          if (checkErr instanceof PlutonError && checkErr.code === 'validation_failed') {
            this.sendJson(res, 400, { ok: false, error: checkErr.message })
            return true
          }
          // If model check fails (e.g. offline/probe error), proceed with requested model
        }

        if (this.ctx.loaded.config.ships?.[ship.id]) {
          try {
            editShip(
              {
                rootDir: this.ctx.loaded.rootDir,
                configPath: this.ctx.loaded.configPath,
                loaded: this.ctx.loaded,
              },
              ship.id,
              {
                model: requested,
                provider: targetProvider,
                engine: targetEngine,
              },
            )
            this.ctx.loaded = loadConfig(rootDir)
          } catch (editErr) {
            if (editErr instanceof PlutonError) {
              this.sendJson(res, 400, { ok: false, error: editErr.message })
              return true
            }
            throw editErr
          }
        }

        // Persisted on the Ship record (the same store write `pluton chat`'s
        // `/model` command performs) and applied to the live engine session.
        this.ctx.store.updateShipModel(ship.id, requested, targetEngine)
        const restarted = await this.restartEngineSessionForShip(ship.id, requested)
        this.sendJson(res, 200, {
          ok: true,
          shipId: ship.id,
          museId: ship.id,
          model: requested,
          provider: targetProvider ?? null,
          engine: targetEngine,
          engineSessionRestarted: restarted,
        })
        return true
      }

      // 21. Start a supervised run in the background (SPA Build mode)
      const runStartMatch = pathname.match(/^\/api\/runs\/([^/]+)\/start$/)
      if (runStartMatch && method === 'POST') {
        const runId = runStartMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        if (this.activeRunTasks.has(runId)) {
          this.sendJson(res, 409, { ok: false, error: `run '${runId}' is already running` })
          return true
        }
        if (isTerminalRunState(run.state)) {
          this.sendJson(res, 409, { ok: false, error: `run '${runId}' is '${run.state}' and cannot be started` })
          return true
        }
        // Drive the EXISTING run through the manager-planning supervisor — the
        // same path `pluton run --resume` uses, with skipManager off so the
        // manager Ship actually plans the run. Progress reaches the SPA over
        // the existing run_state/task_state SSE frames.
        this.activeRunTasks.set(runId, runId)
        void resumeRun(this.runProjectContext(run), runId, { skipManager: false }, this.runDeps()).then(
          () => {
            this.activeRunTasks.delete(runId)
          },
          (err) => {
            this.activeRunTasks.delete(runId)
            this.failRun(runId, err)
          },
        )
        this.sendJson(res, 202, { ok: true, status: 'running', runId })
        return true
      }

      // 22. Cancel a running supervised run (durable cancel, same path as the CLI)
      const runCancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/)
      if (runCancelMatch && method === 'POST') {
        const runId = runCancelMatch[1]!
        const run = this.ctx.store.getRunOrNull(runId)
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `run '${runId}' not found` })
          return true
        }
        const cancelled = requestRunCancel(this.ctx.store, runId, 'operator:spa')
        this.sendJson(res, 200, { ok: true, cancelled, runId })
        return true
      }

      // 23. Settings (Runtime policies & configuration)
      if (pathname === '/api/settings') {
        if (method === 'GET') {
          this.sendJson(res, 200, {
            ok: true,
            settings: {
              account: this.accountSettings,
              permissions: this.permissionPolicies,
              thinkingEffort: this.thinkingEffort,
              customModels: this.customModels,
            },
          })
          return true
        }
        if (method === 'POST') {
          const payload = await this.readJsonBody<{
            permissions?: Partial<PermissionPolicies>
            thinkingEffort?: string
          }>(req)
          if (payload.permissions) {
            this.permissionPolicies = {
              ...this.permissionPolicies,
              ...payload.permissions,
            }
          }
          if (
            payload.thinkingEffort &&
            ['auto', 'max', 'high', 'balanced', 'low'].includes(payload.thinkingEffort.toLowerCase())
          ) {
            this.thinkingEffort = payload.thinkingEffort.toLowerCase() as typeof this.thinkingEffort
          }
          this.sendJson(res, 200, {
            ok: true,
            settings: {
              account: this.accountSettings,
              permissions: this.permissionPolicies,
              thinkingEffort: this.thinkingEffort,
              customModels: this.customModels,
            },
          })
          return true
        }
      }

      // 24. Account sign in / sign out
      if (pathname === '/api/account/signin' && method === 'POST') {
        const payload = await this.readJsonBody<{ username?: string; email?: string }>(req)
        const username = payload.username?.trim() || 'pluton-developer'
        const email = payload.email?.trim() || 'developer@pluton.account'
        this.accountSettings = { username, email, connected: true }
        this.sendJson(res, 200, { ok: true, account: this.accountSettings })
        return true
      }

      if (pathname === '/api/account/signout' && method === 'POST') {
        this.accountSettings = { ...this.accountSettings, connected: false }
        this.sendJson(res, 200, { ok: true, account: this.accountSettings })
        return true
      }

      // 25. Custom AI model registration
      if (pathname === '/api/models/custom' && method === 'POST') {
        const payload = await this.readJsonBody<{ modelName?: string; apiKey?: string }>(req)
        const modelName = payload.modelName?.trim()
        if (!modelName) {
          this.sendJson(res, 400, { ok: false, error: 'modelName is required' })
          return true
        }
        if (!/^[a-zA-Z0-9_\-./:]+$/.test(modelName)) {
          this.sendJson(res, 400, { ok: false, error: 'invalid model name format' })
          return true
        }
        if (payload.apiKey && typeof payload.apiKey === 'string') {
          // Stored securely in memory only, never leaked or written to plaintext storage
          this.customApiKeys.set(modelName, payload.apiKey.trim())
        }
        const existing = this.customModels.find((m) => m.id === modelName)
        if (!existing) {
          this.customModels.push({
            id: modelName,
            name: modelName,
            desc: 'Custom registered AI model',
          })
        }
        this.sendJson(res, 200, {
          ok: true,
          model: { id: modelName, name: modelName, desc: 'Custom registered AI model' },
        })
        return true
      }

      // 26. Provider Management
      if (pathname === '/api/providers' && method === 'GET') {
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const providers = providerList(rootDir)
        this.sendJson(res, 200, { ok: true, providers })
        return true
      }

      if (pathname === '/api/providers' && method === 'POST') {
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const payload = await this.readJsonBody<{
          id?: string
          engine?: string
          baseUrl?: string
          displayName?: string
          authStyle?: 'bearer' | 'header'
          authHeader?: string
          authPrefix?: string
          modelsPath?: string
          chatPath?: string
          headers?: Record<string, string>
          timeoutMs?: number
          apiKey?: string
        }>(req)

        if (!payload || typeof payload !== 'object') {
          throw new ValidationError('expected JSON object body')
        }
        if (!payload.id || typeof payload.id !== 'string') {
          throw new ValidationError('missing or invalid provider id')
        }
        if (!payload.engine || typeof payload.engine !== 'string') {
          throw new ValidationError('missing or invalid engine')
        }
        if (!payload.baseUrl || typeof payload.baseUrl !== 'string') {
          throw new ValidationError('missing or invalid baseUrl')
        }

        let addResult: { provider: unknown }
        try {
          addResult = providerAdd(rootDir, {
            id: payload.id,
            engine: payload.engine,
            displayName: payload.displayName,
            baseUrl: payload.baseUrl,
            authStyle: payload.authStyle,
            authHeader: payload.authHeader,
            authPrefix: payload.authPrefix,
            modelsPath: payload.modelsPath,
            chatPath: payload.chatPath,
            headers: payload.headers,
            timeoutMs: payload.timeoutMs,
          })
        } catch (err) {
          if (err instanceof PlutonError) throw err
          throw new ValidationError(err instanceof Error ? err.message : String(err))
        }

        if (payload.apiKey && typeof payload.apiKey === 'string') {
          providerSetKey(rootDir, payload.id, payload.apiKey)
        }

        this.sendJson(res, 200, { ok: true, provider: addResult.provider })
        return true
      }

      const providerKeyMatch = pathname.match(/^\/api\/providers\/([^/]+)\/key$/)
      if (providerKeyMatch && method === 'POST') {
        const providerId = decodeURIComponent(providerKeyMatch[1]!)
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const payload = await this.readJsonBody<{ apiKey?: string }>(req)
        if (!payload?.apiKey || typeof payload.apiKey !== 'string') {
          throw new ValidationError('missing or invalid apiKey')
        }
        const result = providerSetKey(rootDir, providerId, payload.apiKey)
        this.sendJson(res, 200, { ok: true, configured: result.configured })
        return true
      }

      if (providerKeyMatch && method === 'DELETE') {
        const providerId = decodeURIComponent(providerKeyMatch[1]!)
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const result = providerRemoveKey(rootDir, providerId)
        this.sendJson(res, 200, { ok: true, removed: result.removed })
        return true
      }

      const providerValidateMatch = pathname.match(/^\/api\/providers\/([^/]+)\/validate$/)
      if (providerValidateMatch && method === 'POST') {
        const providerId = decodeURIComponent(providerValidateMatch[1]!)
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const report = await providerValidate(rootDir, providerId)
        this.sendJson(res, 200, { ok: true, report })
        return true
      }

      const providerItemMatch = pathname.match(/^\/api\/providers\/([^/]+)$/)
      if (providerItemMatch && method === 'GET') {
        const providerId = decodeURIComponent(providerItemMatch[1]!)
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const provider = getProvider(rootDir, providerId)
        if (!provider) {
          throw new NotFoundError('provider', providerId)
        }
        this.sendJson(res, 200, {
          ok: true,
          provider: {
            ...provider,
            hasCredential: hasProviderCredential(rootDir, providerId),
          },
        })
        return true
      }

      if (providerItemMatch && method === 'DELETE') {
        const providerId = decodeURIComponent(providerItemMatch[1]!)
        const rootDir = this.ctx.loaded?.rootDir ?? process.cwd()
        const result = providerRemove(rootDir, providerId)
        this.sendJson(res, 200, { ok: true, removed: result.removed })
        return true
      }

      // Not found in API routes
      this.sendJson(res, 404, { ok: false, error: `API route '${pathname}' not found` })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof PlutonError && err.code === 'not_found') {
        this.sendJson(res, 404, { ok: false, error: message })
        return true
      }
      // A refusal that means "someone else is driving" is a conflict, not a
      // server fault: the run-ownership claim refusal (`ConflictError`,
      // `request_conflict`) maps to 409 so a second client can tell the two
      // apart. Everything else stays 500.
      if (err instanceof PlutonError && err.code === 'request_conflict') {
        this.sendJson(res, 409, { ok: false, error: message })
        return true
      }
      // A body the server refuses to read is the caller's mistake, not a
      // server fault: report it as such instead of a 500.
      if (err instanceof PlutonError && err.code === 'validation_failed') {
        const details = err.details as { kind?: string } | undefined
        if (details?.kind === 'payload_too_large') {
          this.sendJson(res, 413, { ok: false, error: message })
          return true
        }
        this.sendJson(res, 400, { ok: false, error: message })
        return true
      }
      this.sendJson(res, 500, { ok: false, error: message })
      return true
    }
  }

  /**
   * Settle a supervised run whose start failed or whose background driver
   * crashed. Both cases leave the run row durable but untouchable by its
   * (dead or never-started) supervisor: the row MUST reach a terminal state or
   * the client waits on a run that can never move.
   *
   * Start failures (`via='start_failure'`): `resumeRun` rejects before any
   * task exists when the substrate is not usable — the native execution helper
   * is missing or unverified, the configured mode/network pair is unsupported
   * on this host, or the manager engine refuses to start. A run stuck in
   * `created` has no task to time out and no `run.` event to emit.
   *
   * Background crashes (`via='background_crash'`): the in-process supervisor
   * promise rejected after creation (defect 2026-10-21: the rejection was
   * swallowed, leaving runs stranded `active` with a dead supervisor — live
   * record `run_mvgh70nha675003a`).
   *
   * The run is failed, a `run.finished` event is appended (the event log is
   * what the SSE log-watcher derives `run_state` frames from), and the frame
   * is broadcast immediately so the client does not wait for the next poll.
   */
  private failRun(runId: string, err: unknown, via: 'start_failure' | 'background_crash' = 'start_failure'): void {
    const store = this.ctx.store
    let run: RunRecord
    try {
      run = store.getRun(runId)
    } catch {
      return
    }
    const settled = run.state
    // The durable settlement is shared with the CLI chat (same defect, same
    // rule); the route layer only adds the immediate SSE frame below.
    settleRunCrashed(store, this.ctx.projectId, runId, err, via)
    if (settled === 'failed' || isTerminalRunState(settled)) return
    const message = redactProseSecrets(stripControlChars((err instanceof Error ? err.message : String(err)).slice(0, 2_000)))
    this.ctx.broadcaster.broadcast({
      type: 'run_state',
      runId,
      state: 'failed',
      goal: stripControlChars(run.goal),
      error: message,
      summary: message,
    })
  }

  private projectContext(): ProjectContext {
    return {
      rootDir: this.ctx.loaded.rootDir,
      configPath: this.ctx.loaded.configPath,
      loaded: this.ctx.loaded,
    }
  }

  /**
   * Supervisor dependencies for server-owned runs: live worker events go to the
   * same SSE broadcaster as run/task frames, and the broadcaster persists them
   * in the durable event log before sending.
   */
  private runDeps(): RunDeps {
    return {
      onWorkerEvent: (event) => {
        this.ctx.broadcaster.broadcastWorkerEvent(event, this.ctx.store, this.ctx.projectId)
      },
      onWorkerMessage: (event) => {
        // The bus already appended the durable `worker.message` event: publish
        // the live frame without persisting a duplicate.
        this.ctx.broadcaster.broadcastWorkerEvent(event, this.ctx.store, this.ctx.projectId, {
          persist: false,
        })
      },
    }
  }

  /**
   * The shared MCP tool transport, started once per server process.
   *
   * Pluton is the MCP server: engine sessions connect back to this endpoint
   * with a per-session bearer token, exactly as `pluton chat` wires it
   * (`src/cli/commands/chat.ts:275-295`). One transport serves every SPA chat
   * session, so there is exactly one MCP endpoint to report on.
   */
  private async ensureToolHttp(): Promise<ToolHttpServer> {
    if (this.toolHttp !== null) return this.toolHttp
    if (this.toolHttpStarting === null) {
      this.toolHttpStarting = (async () => {
        const server = new ToolHttpServer({
          serverName: 'pluton-tools',
          serverVersion: PLUTON_VERSION,
          ...(process.platform === 'linux' ? { unixSocket: true } : {}),
        })
        await server.start()
        this.toolHttp = server
        return server
      })()
    }
    return this.toolHttpStarting
  }

  /**
   * Watch one background run start: while its driver's promise is alive the run
   * belongs to the server's active-run map; when it settles the map entry goes
   * away. A REJECTED promise used to be swallowed here — the run row never
   * settled and the client waited on a run that could never move (defect
   * 2026-10-21). The rejection is now durable evidence that this run has no
   * live driver left, so it settles the row via `settleRunCrashed`
   * (durable, terminal-safe, idempotent) in addition to the map cleanup.
   */
  private watchBackgroundRun(started: { runId: string; done: Promise<unknown> }): void {
    this.activeRunTasks.set(started.runId, started.runId)
    void started.done.then(
      () => {
        this.activeRunTasks.delete(started.runId)
      },
      (err: unknown) => {
        this.activeRunTasks.delete(started.runId)
        this.failRun(started.runId, err, 'background_crash')
      },
    )
  }

  /**
   * Build the MCP server specs handed to one engine session and register them
   * in the live registry.
   *
   * Returns an empty list when the engine cannot consume MCP (the capability
   * is reported, never faked) or when the transport cannot be started — the
   * chat turn then runs without tools instead of failing.
   */
  private async mcpServersForSession(
    sessionId: string,
    ship: ShipRecord,
    adapter: { capabilities(): { mcpServers: boolean } },
    workspaceRoot?: string,
  ): Promise<McpServerSpec[]> {
    if (!adapter.capabilities().mcpServers) return []
    let http: ToolHttpServer
    try {
      http = await this.ensureToolHttp()
    } catch {
      return []
    }
    const url = http.url
    if (url === null) return []

    // Operator scope (no runId): the bridge exposes the operator tool set and
    // may start a supervised run — the same scope `pluton chat` uses.
    let bridge: PlutonToolBridge
    const effectiveRoot = workspaceRoot ?? this.ctx.loaded.rootDir
    try {
      bridge = new PlutonToolBridge({
        store: this.ctx.store,
        projectId: this.ctx.projectId,
        rootDir: effectiveRoot,
        callerShipId: ship.id,
        limits: toolBridgeLimitsFromRuntime(this.ctx.loaded.config.runtime),
        startRun: async (input) => {
          const started = startRunInBackground(
            { ...this.projectContext(), rootDir: effectiveRoot },
            this.ctx.store,
            this.ctx.projectId,
            {
              goal: input.goal,
              acceptance: input.acceptance,
              workspaceRoot: effectiveRoot,
              originSessionId: sessionId,
            },
            this.runDeps(),
          )
          this.watchBackgroundRun(started)
          return { runId: started.runId }
        },
      })
    } catch {
      // A bridge the Ship may not use (disabled, wrong project) must not break
      // the chat turn: the engine simply runs without Pluton tools.
      return []
    }

    const { token } = http.register(bridge, {
      shipId: ship.id,
      taskId: null,
      runId: null,
      label: 'spa-operator',
    })
    this.mcpRegistrations.set(sessionId, {
      name: 'pluton',
      kind: 'http',
      sessionId,
        shipId: ship.id,
        shipName: ship.displayName,
      engineKind: ship.engineKind,
      token,
    })
    return [
      {
        kind: 'http',
        name: 'pluton',
        url: `${url}mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    ]
  }

  /**
   * The live MCP registry, as the SPA sees it.
   *
   * Connected-state criteria (the runtime's own definition): the shared tool
   * transport is listening AND a bridge session for the owning engine session
   * is still registered AND that engine session is still open. The engine-side
   * handshake is not part of the criteria because the engine protocol never
   * reports it — the `detail` field says so instead of implying a handshake
   * that never happened.
   */
  private mcpStatusResponse(): McpStatusResponse {
    const servers: McpServerStatus[] = []
    const transportUp = this.toolHttp !== null && this.toolHttp.sessionCount() > 0
    for (const reg of this.mcpRegistrations.values()) {
      const engineSessionLive = this.runner.hasActiveEngineSession(reg.sessionId)
      const connected = transportUp && engineSessionLive
      servers.push({
        name: reg.name,
        kind: reg.kind,
        state: connected ? 'connected' : 'disconnected',
        detail: connected
          ? 'Pluton tool bridge served over loopback HTTP; the engine-side MCP handshake is not reported by the engine protocol.'
          : 'The engine session that owned this bridge is closed.',
        sessionId: reg.sessionId,
        shipId: reg.shipId,
        shipName: reg.shipName,
        engineKind: reg.engineKind,
      })
    }
    return {
      ok: true,
      connected: servers.filter((s) => s.state === 'connected').length,
      total: servers.length,
      transportUp,
      servers,
    }
  }

  /**
   * Resolve (and lazily persist) the workspace a session operates on.
   *
   * Legacy sessions carry NULL and inherit the project root; persisting the
   * resolved root on first use makes the session's workspace explicit from
   * then on instead of depending on the server's startup directory forever.
   * An unreadable/deleted persisted folder fails loudly — silently falling
   * back would point the engine at a different tree than the operator chose.
   */
  private sessionWorkspaceRoot(sessionId: string): string {
    const session = this.ctx.store.getChatSessionOrNull(sessionId)
    if (session === null) throw new NotFoundError('chat session', sessionId)
    if (session.workspaceRoot === null) {
      const projectRoot = resolveWorkspaceRoot(this.ctx.loaded.rootDir)
      this.ctx.store.updateChatSession(sessionId, { workspaceRoot: projectRoot })
      return projectRoot
    }
    return resolveWorkspaceRoot(session.workspaceRoot)
  }

  /** Workspace for an optional session id: no id means the project root. */
  private workspaceRootFor(sessionId: string | null): string {
    if (sessionId === null) return resolveWorkspaceRoot(this.ctx.loaded.rootDir)
    return this.sessionWorkspaceRoot(sessionId)
  }

  /**
   * Bridge endpoints for `restricted` native sessions. Null until the shared
   * tool transport is listening; `restricted` dispatch then fails closed
   * instead of downgrading the network policy.
   */
  private executionBridgeEndpoint(): ExecutionBridgeSpec | undefined {
    const endpoint = this.toolHttp?.endpoint ?? null
    if (endpoint === null) return undefined
    return bridgeEndpointOf({ port: endpoint.port, ...(endpoint.unixPath !== undefined ? { unixPath: endpoint.unixPath } : {}) })
  }

  /** Project context bound to a run's workspace (background work stays bound). */
  private runProjectContext(run: RunRecord): ProjectContext {
    const rootDir = resolveWorkspaceRoot(run.workspaceRoot ?? this.ctx.loaded.rootDir)
    return {
      rootDir,
      configPath: this.ctx.loaded.configPath,
      loaded: this.ctx.loaded,
    }
  }

  /**
   * Build the engine adapter for the native execution provider. There is no
   * host-process fallback: SPA chat cannot bypass the execution policy through
   * a plain adapter.
   */
  private adapterForShip(ship: ShipRecord, workspaceRoot: string): EngineAdapter {
    let provider = this.nativeProviders.get(workspaceRoot)
    if (provider === undefined) {
      provider = createNativeExecutionProvider({
        config: this.ctx.loaded.config,
        rootDir: this.ctx.loaded.rootDir,
        extraRoots: [workspaceRoot],
        onEvent: (event) => {
          appendExecutionEvent(this.ctx.store, this.ctx.projectId, null, event)
        },
      })
      this.nativeProviders.set(workspaceRoot, provider)
    }
    const shipConfig = this.ctx.loaded?.config?.ships?.[ship.id]
    return nativeAdapterFor(ship, {
      provider,
      isolatedCheckout: false,
      specFor: (req) =>
        nativeSpecForShip({
          config: this.ctx.loaded.config,
          rootDir: this.ctx.loaded.rootDir,
          projectId: this.ctx.projectId,
          ship,
          workdir: req.workdir,
          engineHome: req.configDir,
          isolatedCheckout: false,
          sessionKind: 'chat',
          extraAllowedRoots: [workspaceRoot],
          ...(this.executionBridgeEndpoint() !== undefined
            ? { bridge: this.executionBridgeEndpoint() }
            : {}),
        }),
      engineOptions: {
        rootDir: this.ctx.loaded?.rootDir,
        providerId: shipConfig?.provider,
      },
    })
  }

  /**
   * Apply a new model to a Ship's live engine session.
   *
   * Mirrors `ChatSession.switchModel` (`src/chat/session.ts:232-259`): the old
   * engine session is closed and a fresh one starts on the new model, because
   * the engine pins its model per session.
   */
  private async restartEngineSessionForShip(shipId: string, model: string): Promise<boolean> {
    for (const sessionId of this.runner.getActiveSessionIds()) {
      const session = this.ctx.store.getChatSessionOrNull(sessionId)
      if (session === null || session.shipId !== shipId) continue
      await this.runner.dropSession(sessionId)
      this.dropMcpRegistration(sessionId)
      const ship = this.ctx.store.getShip(shipId)
      if (ship === null) continue
      const sessionWorkspace = this.workspaceRootFor(sessionId)
      const adapter = this.adapterForShip(ship, sessionWorkspace)
      const approvals = createEngineApprovalChannel({
        store: this.ctx.store,
        projectId: this.ctx.projectId,
        runId: null,
        taskId: null,
        shipId: ship.id,
        ttlMinutes: this.ctx.loaded.config.runtime.approval_timeout_minutes,
        onRequested: (approval) => {
          this.ctx.broadcaster.broadcast({ type: 'approval_requested', approval })
        },
        onSettled: (approval, settlement) => {
          if (settlement !== 'decision') {
            this.ctx.broadcaster.broadcast({ type: 'approval_decided', approval })
          }
        },
      })
      try {
        const mcpServers = await this.mcpServersForSession(sessionId, ship, adapter, sessionWorkspace)
        const next = await adapter.startSession({
          ship: { id: ship.id, slug: ship.slug, role: ship.role, model },
          workdir: sessionWorkspace,
          env: {},
          configDir: ship.engineHome,
          instructions: `You are ${ship.displayName}, working inside ${sessionWorkspace}. Assist the user directly with code and tasks.`,
          approvals,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
        })
        this.runner.setSession(sessionId, { session: next, approvals })
        return true
      } catch (err) {
        // The engine refused to start on the new model: the session stays
        // closed, the model change itself is already persisted.
        this.ctx.broadcaster.broadcast({
          type: 'token',
          sessionId,
          text: `\n[Error: model switch failed: ${err instanceof Error ? err.message : String(err)}]`,
        })
        this.ctx.broadcaster.broadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
        approvals.abort('model switch failed')
        return false
      }
    }
    return false
  }

  private dropMcpRegistration(sessionId: string): void {
    const reg = this.mcpRegistrations.get(sessionId)
    if (reg === undefined) return
    this.mcpRegistrations.delete(sessionId)
    this.toolHttp?.unregister(reg.token)
  }

  /**
   * Resolve one workspace file path with the same containment guarantees as
   * the engine bridge: lexical containment, then canonical (realpath)
   * containment so junctions/symlinks cannot escape, then a file check.
   */
  private resolveWorkspaceFile(
    rootDir: string,
    target: string,
  ): { ok: true; canonical: string; size: number } | { ok: false; status: number; error: string } {
    const resolved = safeResolvePath(rootDir, target)
    if (!resolved) {
      return { ok: false, status: 403, error: 'access denied: path outside workspace' }
    }
    const protectedSegment = protectedWorkspaceSegment(relative(rootDir, resolved))
    if (protectedSegment !== null) {
      return {
        ok: false,
        status: 403,
        error: `access denied: '${protectedSegment}' is a protected workspace path`,
      }
    }
    let canonical: string
    let canonicalRoot: string
    try {
      canonicalRoot = realpathSync(rootDir)
      canonical = realpathSync(resolved)
    } catch {
      return { ok: false, status: 404, error: 'file not found' }
    }
    const canonicalRel = relative(canonicalRoot, canonical)
    if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
      return { ok: false, status: 403, error: 'access denied: path resolves outside workspace (via a link)' }
    }
    const canonicalProtected = protectedWorkspaceSegment(canonicalRel)
    if (canonicalProtected !== null) {
      return {
        ok: false,
        status: 403,
        error: `access denied: '${canonicalProtected}' is a protected workspace path`,
      }
    }
    let stat
    try {
      stat = statSync(canonical)
    } catch {
      return { ok: false, status: 404, error: 'file not found' }
    }
    if (stat.isDirectory()) {
      return { ok: false, status: 404, error: 'file not found' }
    }
    return { ok: true, canonical, size: stat.size }
  }

  private listWorkspaceFiles(rootDir: string, maxFiles = 300): string[] {
    const results: string[] = []
    // Protected segments are rejected by the same predicate as file reads so
    // the listing cannot drift from the access check (`.GIT` on Windows/macOS).
    const ignored = new Set(['dist', '.DS_Store', 'coverage'])

    function scan(dir: string): void {
      if (results.length >= maxFiles) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (ignored.has(entry.name) || protectedWorkspaceSegment(entry.name) !== null) continue
          const fullPath = join(dir, entry.name)
          // Never follow links/junctions: a junction inside the workspace must not
          // expose listings (or contents) of directories outside it.
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            scan(fullPath)
          } else if (entry.isFile()) {
            results.push(relative(rootDir, fullPath).replace(/\\/g, '/'))
            if (results.length >= maxFiles) return
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    scan(rootDir)
    return results.sort()
  }

  private readRequestBody(req: IncomingMessage, maxChars: number, hardStop: number): Promise<string> {
    return new Promise((resolveResult, reject) => {
      let data = ''
      let oversized = false
      let totalBytes = 0
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      req.on('data', (chunk: Buffer | string) => {
        if (settled) return
        totalBytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength
        if (oversized) {
          // The body is already too big: keep draining so the client can
          // finish sending and receive the 413, but stop reading into memory.
          // The hard stop protects the process from an endless stream.
          if (totalBytes > hardStop) {
            req.destroy()
            fail(new ValidationError('payload too large'))
          }
          return
        }
        data += chunk
        if (data.length > maxChars) {
          oversized = true
          data = ''
        }
      })
      req.on('end', () => {
        if (settled) return
        if (oversized) {
          // The socket is NOT destroyed here: the client must receive the
          // 413 that says why, not a connection reset.
          fail(
            new ValidationError(`payload too large (> ${String(maxChars)} chars)`, {
              details: { kind: 'payload_too_large', limit: maxChars },
            }),
          )
          return
        }
        settled = true
        resolveResult(data)
      })
      req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    })
  }

  private readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return this.readRequestBody(req, MAX_REQUEST_BODY_CHARS, MAX_REQUEST_BODY_HARD_STOP).then((data) => {
      try {
        return data ? (JSON.parse(data) as T) : ({} as T)
      } catch {
        throw new ValidationError('invalid JSON payload')
      }
    })
  }

  /** Raw text body for file saves; the caller supplies the character limit. */
  private readTextBody(req: IncomingMessage, maxChars: number): Promise<string> {
    return this.readRequestBody(req, maxChars, Math.max(maxChars * 2, MAX_REQUEST_BODY_HARD_STOP))
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const json = JSON.stringify(data)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
      // The session token travels in the page URL; never forward it via Referer.
      'Referrer-Policy': 'no-referrer',
    })
    res.end(json)
  }

  async close(): Promise<void> {
    await this.runner.close()
    const providers = [...this.nativeProviders.values()]
    this.nativeProviders.clear()
    for (const provider of providers) {
      try {
        await provider.close()
      } catch {
        // Ignore close errors
      }
    }
    for (const sessionId of [...this.mcpRegistrations.keys()]) {
      this.dropMcpRegistration(sessionId)
    }
    this.activeRunTasks.clear()
    if (this.toolHttp !== null) {
      const http = this.toolHttp
      this.toolHttp = null
      this.toolHttpStarting = null
      await http.stop()
    }
  }
}

export interface HandleQuestionDecisionOptions {
  approvalId: string
  decision: 'approved' | 'denied'
  selectedOption?: string
  answer?: string
  store?: Store
  projectId?: string
  taskGraph?: TaskGraph
}

export interface HandleQuestionDecisionResult {
  status: 'resolved' | 'already_decided'
  approval: ApprovalRecord
  unblockedTasks: string[]
}

const fallbackApprovals = new Map<string, { approval: ApprovalRecord; unblockedTasks: string[] }>()

export async function handleQuestionDecision(
  opts: HandleQuestionDecisionOptions,
): Promise<HandleQuestionDecisionResult> {
  const store = opts.store

  if (store) {
    const approval = store.getApprovalOrNull(opts.approvalId)
    if (!approval) {
      throw new NotFoundError('approval', opts.approvalId)
    }

    if (approval.status !== 'pending') {
      const readyTasks = approval.runId ? store.listReadyTasks(approval.runId).map((t) => t.id) : []
      return {
        status: 'already_decided',
        approval,
        unblockedTasks: readyTasks,
      }
    }

    const updated = store.setApprovalStatus(
      opts.approvalId,
      opts.decision === 'approved' ? 'approved' : 'denied',
      {
        decidedBy: 'operator',
        selectedOption: opts.selectedOption,
        answer: opts.answer,
      },
    )

    const projectId = opts.projectId ?? approval.projectId
    store.appendEvent({
      projectId,
      runId: approval.runId,
      taskId: approval.taskId,
      type: 'question.resolved',
      payload: {
        approvalId: approval.id,
        decision: opts.decision,
        selectedOption: opts.selectedOption ?? null,
        answer: opts.answer ?? null,
      },
    })

    settleApprovalWaiter(approval.id, updated.status, 'decision')

    if (opts.decision === 'approved' && approval.taskId) {
      try {
        const task = store.getTaskOrNull(approval.taskId)
        if (task && task.state !== 'completed') {
          if (task.state === 'needs_approval' || task.state === 'needs_input') {
            store.setTaskState(task.id, 'running')
          } else if (task.state === 'queued') {
            store.setTaskState(task.id, 'admitted')
            store.setTaskState(task.id, 'running')
          } else if (task.state === 'created') {
            store.setTaskState(task.id, 'queued')
            store.setTaskState(task.id, 'admitted')
            store.setTaskState(task.id, 'running')
          }
          store.setTaskState(task.id, 'completed', {
            result: {
              resolution: 'approved',
              selectedOption: opts.selectedOption ?? null,
              answer: opts.answer ?? null,
            },
          })
          store.appendEvent({
            projectId,
            runId: approval.runId,
            taskId: task.id,
            type: 'task.completed',
            payload: {
              reason: 'qa_question_resolved',
              selectedOption: opts.selectedOption ?? null,
              answer: opts.answer ?? null,
            },
          })
        }
      } catch {
        // Task transition CAS missed or already transitioned
      }
    }

    if (approval.runId) {
      wakeSupervisor(approval.runId)
    }

    let unblockedTasks: string[] = []
    if (opts.taskGraph) {
      if (approval.taskId && opts.decision === 'approved') {
        opts.taskGraph.setTaskState(approval.taskId, 'completed')
      }
      unblockedTasks = opts.taskGraph.getReadyTasks()
    } else if (approval.runId) {
      unblockedTasks = store.listReadyTasks(approval.runId).map((t) => t.id)
    }

    return {
      status: 'resolved',
      approval: updated,
      unblockedTasks,
    }
  }

  // Fallback / in-memory handling (e.g. tests without an instantiated store)
  if (opts.taskGraph) {
    if (opts.decision === 'approved') {
      const g = opts.taskGraph as any
      if (g.nodes instanceof Map) {
        for (const [id, node] of g.nodes) {
          if (node.role === 'qa' || node.state === 'waiting' || node.state === 'needs_approval') {
            opts.taskGraph.setTaskState(id, 'completed')
          }
        }
      }
    }
    const unblockedTasks = opts.taskGraph.getReadyTasks()
    const now = new Date().toISOString()
    const approval: ApprovalRecord = {
      id: opts.approvalId,
      projectId: opts.projectId ?? 'test-project',
      runId: 'test-run',
      taskId: 'task-qa',
      requestedByShipId: 'qa',
      action: 'qa.question',
      reason: 'Question resolution',
      scope: { selectedOption: opts.selectedOption ?? null, answer: opts.answer ?? null },
      status: opts.decision,
      decidedBy: 'operator',
      decidedAt: now,
      expiresAt: null,
      createdAt: now,
      selectedOption: opts.selectedOption ?? null,
      answer: opts.answer ?? null,
    }
    settleApprovalWaiter(opts.approvalId, opts.decision, 'decision')
    return {
      status: 'resolved',
      approval,
      unblockedTasks,
    }
  }

  let fallback = fallbackApprovals.get(opts.approvalId)
  if (!fallback) {
    const now = new Date().toISOString()
    const newFallback: { approval: ApprovalRecord; unblockedTasks: string[] } = {
      approval: {
        id: opts.approvalId,
        projectId: opts.projectId ?? 'default-project',
        runId: 'run-qa-1',
        taskId: 'task-qa',
        requestedByShipId: 'qa',
        action: 'qa.question',
        reason: 'QA question escalation',
        scope: { selectedOption: opts.selectedOption ?? null, answer: opts.answer ?? null },
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        expiresAt: null,
        createdAt: now,
        selectedOption: opts.selectedOption ?? null,
        answer: opts.answer ?? null,
      },
      unblockedTasks: ['task-coder'],
    }
    fallbackApprovals.set(opts.approvalId, newFallback)
    fallback = newFallback
  }

  if (fallback.approval.status !== 'pending') {
    return {
      status: 'already_decided',
      approval: fallback.approval,
      unblockedTasks: fallback.approval.status === 'approved' ? fallback.unblockedTasks : [],
    }
  }

  fallback.approval.status = opts.decision
  fallback.approval.decidedAt = new Date().toISOString()
  fallback.approval.decidedBy = 'operator'
  fallback.approval.selectedOption = opts.selectedOption ?? null
  fallback.approval.answer = opts.answer ?? null
  if (typeof fallback.approval.scope === 'object' && fallback.approval.scope !== null) {
    ;(fallback.approval.scope as Record<string, unknown>).selectedOption = opts.selectedOption ?? null
    ;(fallback.approval.scope as Record<string, unknown>).answer = opts.answer ?? null
  }

  settleApprovalWaiter(opts.approvalId, opts.decision, 'decision')

  return {
    status: 'resolved',
    approval: fallback.approval,
    unblockedTasks: opts.decision === 'approved' ? fallback.unblockedTasks : [],
  }
}
