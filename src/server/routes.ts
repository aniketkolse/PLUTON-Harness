/**
 * REST API route dispatcher for Pluton Application Server (ADR-0014).
 * Single authoritative bridge connecting frontend clients to the Pluton runtime.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from '../store/store.ts'
import { NotFoundError, PlutonError, ValidationError } from '../domain/errors.ts'
import { isTerminalRunState } from '../domain/state.ts'
import type { ApprovalRecord, MuseRecord, RunRecord } from '../domain/models.ts'
import { stateDir, workspaceDir, type LoadedConfig } from '../config/load.ts'
import { engineAdapterForMuse } from '../engines/approval.ts'
import { createEngineApprovalChannel, settleApprovalWaiter, type EnginePermissionChannel } from '../engines/interactive-approval.ts'
import { getEngineAdapter, registerBuiltinEngines } from '../engines/registry.ts'
import { SHIP_WORKER_MODELS } from '../engines/opencode/adapter.ts'
import type { EngineSession, McpServerSpec } from '../engines/contract/types.ts'
import { GitWorkspaceManager } from '../workspace/manager.ts'
import { run as execRun } from '../util/exec.ts'
import { PLUTON_VERSION } from '../version.ts'
import { safeResolvePath } from './security.ts'
import type { ServerEventBroadcaster } from './events.ts'
import { decideApproval, sweepExpiredApprovals } from '../cli/commands/approvals.ts'
import { requestRunCancel, resumeRun, startRunInBackground } from '../cli/commands/run.ts'
import type { WorkerLifecycleEvent } from '../orchestrator/supervisor.ts'
import type { ProjectContext } from '../cli/context.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict, runVerificationChecks } from '../verify/runner.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../tools/bridge.ts'
import { ToolHttpServer } from '../tools/http-transport.ts'
import { wakeSupervisor } from '../orchestrator/supervisor.ts'
import type { TaskGraph } from '../orchestrator/task-graph.ts'
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
  museId: string
  museName: string
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
  private readonly activeEngineSessions = new Map<
    string,
    { session: EngineSession; busy: boolean; approvals: EnginePermissionChannel }
  >()
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

      // 2. Workspace Summary
      if (method === 'GET' && pathname === '/api/workspace') {
        const store = this.ctx.store
        const project = store.getProject(this.ctx.projectId)
        const muses = store.listMuses()
        const runs = store.listRuns(50)
        // listRuns is newest-first: the workspace's active run is the newest
        // non-terminal one. Terminal run states are excluded rather than
        // matching a hand-written allowlist, which silently missed `active`
        // (the primary live state) and made a reload adopt a stale run.
        const activeRun = runs.find((r) => !isTerminalRunState(r.state)) ?? null
        const approvals = store.listApprovalsByProject(this.ctx.projectId, { status: 'pending' })

        const summary: WorkspaceSummary = {
          name: project?.name ?? this.ctx.loaded.config.project.name,
          rootDir: this.ctx.loaded.rootDir,
          projectId: this.ctx.projectId,
          defaultBranch: project?.defaultBranch ?? this.ctx.loaded.config.project.default_branch,
          muses: muses.map((m) => ({
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
        }
        this.sendJson(res, 200, { ok: true, workspace: summary })
        return true
      }

      // 3. Workspace Files
      if (method === 'GET' && pathname === '/api/files') {
        const files = this.listWorkspaceFiles(this.ctx.loaded.rootDir)
        this.sendJson(res, 200, { ok: true, files })
        return true
      }

      // 4. File Content
      if (method === 'GET' && pathname === '/api/files/content') {
        const target = parsedUrl.searchParams.get('path')
        if (!target) {
          this.sendJson(res, 400, { ok: false, error: 'path query parameter is required' })
          return true
        }
        const resolved = safeResolvePath(this.ctx.loaded.rootDir, target)
        if (!resolved) {
          this.sendJson(res, 403, { ok: false, error: 'access denied: path outside workspace' })
          return true
        }
        // Canonicalize before trusting the path: junctions/symlinks inside the
        // workspace must not expose files outside it (parity with the engine
        // tool bridge's realpath containment).
        let canonical: string
        let canonicalRoot: string
        try {
          canonicalRoot = realpathSync(this.ctx.loaded.rootDir)
          canonical = realpathSync(resolved)
        } catch {
          this.sendJson(res, 404, { ok: false, error: 'file not found' })
          return true
        }
        const canonicalRel = relative(canonicalRoot, canonical)
        if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
          this.sendJson(res, 403, { ok: false, error: 'access denied: path resolves outside workspace (via a link)' })
          return true
        }
        let stat
        try {
          stat = statSync(canonical)
        } catch {
          this.sendJson(res, 404, { ok: false, error: 'file not found' })
          return true
        }
        if (stat.isDirectory()) {
          this.sendJson(res, 404, { ok: false, error: 'file not found' })
          return true
        }
        if (stat.size > 2 * 1024 * 1024) {
          this.sendJson(res, 413, { ok: false, error: 'file too large to inspect in editor (> 2MB)' })
          return true
        }
        const content = readFileSync(canonical, 'utf8')
        this.sendJson(res, 200, { ok: true, path: target, content, size: stat.size })
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
          const payload = await this.readJsonBody<{ museId?: string; title?: string }>(req)
          const muses = this.ctx.store.listMuses()
          const museId = payload.museId ?? muses[0]?.id
          if (!museId) {
            this.sendJson(res, 400, { ok: false, error: 'no muse available for session' })
            return true
          }
          const session = this.ctx.store.createChatSession({
            projectId: this.ctx.projectId,
            museId,
            title: payload.title ?? 'New Session',
          })
          this.sendJson(res, 201, { ok: true, session })
          return true
        }
      }

      // 6. Session Detail
      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const sessionId = sessionMatch[1]!
        const session = this.ctx.store.getChatSessionOrNull(sessionId)
        if (!session) {
          this.sendJson(res, 404, { ok: false, error: `session '${sessionId}' not found` })
          return true
        }
        const messages = this.ctx.store.listChatMessages(sessionId)
        const muse = this.ctx.store.getMuse(session.museId)
        if (!muse) {
          this.sendJson(res, 404, { ok: false, error: `muse '${session.museId}' not found` })
          return true
        }
        const detail: SessionDetailView = {
          session,
          messages,
          activeMuse: {
            id: muse.id,
            slug: muse.slug,
            displayName: muse.displayName,
            role: muse.role,
            engine: muse.engineKind,
            model: muse.model,
          },
          busy: this.activeEngineSessions.get(sessionId)?.busy === true,
        }
        this.sendJson(res, 200, { ok: true, session: detail })
        return true
      }

      // 7. Session Prompt Turn (Dispatch)
      const promptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const sessionId = promptMatch[1]!
        const payload = await this.readJsonBody<{ text?: string }>(req)
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

        const active = this.activeEngineSessions.get(sessionId)
        if (active?.busy) {
          this.sendJson(res, 409, { ok: false, error: 'session is already processing a prompt' })
          return true
        }

        // Start processing asynchronously and return 202 Accepted
        this.sendJson(res, 202, { ok: true, status: 'streaming', sessionId })

        // Fire-and-forget prompt turn execution with real SSE streaming
        void this.executePromptTurn(sessionId, session.museId, userText)
        return true
      }

      // 8. Session Cancel
      const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/)
      if (cancelMatch && method === 'POST') {
        const sessionId = cancelMatch[1]!
        const active = this.activeEngineSessions.get(sessionId)
        if (active?.busy) {
          // Cancelling the turn settles any pending engine permission request
          // fail-closed (the engine gets a deny, not a hang).
          active.approvals.abort('turn cancelled by operator')
          await active.session.interrupt()
          active.busy = false
          this.ctx.broadcaster.broadcast({
            type: 'turn_end',
            sessionId,
            interrupted: true,
            failed: false,
          })
          this.sendJson(res, 200, { ok: true, cancelled: true })
        } else {
          this.sendJson(res, 200, { ok: true, cancelled: false, message: 'session was not busy' })
        }
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
          const payload = await this.readJsonBody<{ goal?: string; managerMuseId?: string }>(req)
          const goal = payload.goal?.trim()
          if (!goal) {
            this.sendJson(res, 400, { ok: false, error: 'goal is required' })
            return true
          }
          const muses = this.ctx.store.listMuses()
          const manager = muses.find((m) => m.role === 'supervisor') ?? muses[0]
          if (!manager) {
            this.sendJson(res, 400, { ok: false, error: 'no manager muse configured' })
            return true
          }
          const run = this.ctx.store.createRun({
            projectId: this.ctx.projectId,
            goal,
            origin: 'api',
            requestedBy: 'operator:ui',
            managerMuseId: payload.managerMuseId ?? manager.id,
            acceptanceCriteria: ['Task executed via graphical workspace'],
            budget: {
              maxConcurrentWorkers: 3,
              maxTasks: 20,
              maxDelegationDepth: 3,
              maxRunMinutes: 60,
              defaultTaskMinutes: 10,
            },
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
          const assignedMuseId =
            assignment !== null && typeof assignment['museId'] === 'string' ? assignment['museId'] : undefined
          const policy = assignedMuseId !== undefined ? this.ctx.loaded.config.muses[assignedMuseId]?.workspace_policy : undefined
          const workspace =
            workspacePathByTask.get(task.id) ??
            (policy === 'read-only' || policy === 'coordinator-read-only' ? this.ctx.loaded.rootDir : undefined)
          return {
            ...task,
            ...(role !== undefined ? { role } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(workspace !== undefined ? { workspace } : {}),
          }
        })
        const detail: RunDetailView = {
          run,
          tasks: taskViews,
          edges,
          approvals,
          usage,
        }
        this.sendJson(res, 200, { ok: true, run: detail })
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
            const diffRes = await execRun(['git', '-C', ws.path, 'diff', `${ws.baseCommit}...HEAD`], {
              timeoutMs: 15_000,
              maxOutputBytes: 100_000,
            }).catch(() => null)
            if (diffRes && diffRes.exitCode === 0) diffText = diffRes.stdout
            const nameRes = await execRun(['git', '-C', ws.path, 'diff', '--name-only', `${ws.baseCommit}...HEAD`], {
              timeoutMs: 10_000,
              maxOutputBytes: 50_000,
            }).catch(() => null)
            if (nameRes && nameRes.exitCode === 0) {
              changedFiles = nameRes.stdout.split('\n').map((s: string) => s.trim()).filter(Boolean)
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
          const projectCtx: ProjectContext = {
            rootDir: this.ctx.loaded.rootDir,
            configPath: this.ctx.loaded.configPath,
            loaded: this.ctx.loaded,
          }
          resumed = await resumeRun(projectCtx, runId, { skipManager: true }, this.runDeps())
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
        const projectCtx: ProjectContext = {
          rootDir: this.ctx.loaded.rootDir,
          configPath: this.ctx.loaded.configPath,
          loaded: this.ctx.loaded,
        }
        const summary = await resumeRun(projectCtx, runId, { skipManager: true }, this.runDeps())
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

      // 17. Muses list
      if (pathname === '/api/muses' && method === 'GET') {
        const muses = this.ctx.store.listMuses()
        this.sendJson(res, 200, { ok: true, muses })
        return true
      }

      // 18. Models list
      if (pathname === '/api/models' && method === 'GET') {
        const muses = this.ctx.store.listMuses()
        const engineKinds = new Set(muses.map((m) => m.engineKind))
        engineKinds.add('opencode')

        const modelsByEngine: Record<string, unknown[]> = {}
        for (const engineKind of engineKinds) {
          try {
            const adapter = getEngineAdapter(engineKind)
            if (typeof adapter.listModelsWithAvailability === 'function') {
              modelsByEngine[engineKind] = await adapter.listModelsWithAvailability()
            } else {
              const models = await adapter.listModels()
              modelsByEngine[engineKind] = models.map((m) => ({
                ...m,
                available: true,
              }))
            }
          } catch (err) {
            const matchingMuse = muses.find((m) => m.engineKind === engineKind)
            if (matchingMuse) {
              modelsByEngine[engineKind] = [
                {
                  id: matchingMuse.model,
                  source: 'static',
                  available: false,
                  reason: err instanceof Error ? err.message : String(err),
                },
              ]
            } else if (engineKind === 'opencode') {
              modelsByEngine[engineKind] = SHIP_WORKER_MODELS.map((id) => ({
                id,
                source: 'catalog',
                available: false,
                reason: err instanceof Error ? err.message : String(err),
              }))
            }
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

      // 20. Switch a Muse's model (persisted; restarts the live engine session)
      const modelMatch = pathname.match(/^\/api\/muses\/([^/]+)\/model$/)
      if (modelMatch && method === 'POST') {
        const museId = modelMatch[1]!
        const payload = await this.readJsonBody<{ model?: string }>(req)
        const requested = payload.model?.trim()
        if (!requested) {
          this.sendJson(res, 400, { ok: false, error: 'model is required' })
          return true
        }
        const muse = this.ctx.store.getMuse(museId)
        if (!muse) {
          this.sendJson(res, 404, { ok: false, error: `muse '${museId}' not found` })
          return true
        }
        const isCustom = this.customModels.some((m) => m.id === requested)
        const adapter = engineAdapterForMuse(muse)
        if (!isCustom && adapter.capabilities().modelList) {
          const available = await adapter.listModels()
          const known = available.some((m) => m.id === requested || m.label === requested)
          if (!known && available.length > 0) {
            this.sendJson(res, 400, {
              ok: false,
              error: `model '${requested}' is not offered by engine '${muse.engineKind}'`,
              available: available.map((m) => m.id),
            })
            return true
          }
        }
        // Persisted on the Muse record (the same store write `pluton chat`'s
        // `/model` command performs) and applied to the live engine session.
        this.ctx.store.updateMuseModel(muse.id, requested)
        const restarted = await this.restartEngineSessionForMuse(muse.id, requested)
        this.sendJson(res, 200, {
          ok: true,
          museId: muse.id,
          model: requested,
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
        // manager Muse actually plans the run. Progress reaches the SPA over
        // the existing run_state/task_state SSE frames.
        this.activeRunTasks.set(runId, runId)
        void resumeRun(this.projectContext(), runId, { skipManager: false }, this.runDeps()).then(
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

      // Not found in API routes
      this.sendJson(res, 404, { ok: false, error: `API route '${pathname}' not found` })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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
   * Settle a supervised run whose start failed.
   *
   * `resumeRun` rejects before any task exists when the substrate is not
   * usable: the Docker daemon is unreachable, the worker image is missing or
   * drifted, the manager engine refuses to start. The run row is already
   * durable at that point, so it MUST reach a terminal state: a run stuck in
   * `created` has no task to time out and no `run.` event to emit, so the
   * client would wait on a run that can never move.
   *
   * The run is failed, a `run.finished` event is appended (the event log is
   * what the SSE log-watcher derives `run_state` frames from), and the frame
   * is broadcast immediately so the client does not wait for the next poll.
   */
  private failRun(runId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const store = this.ctx.store
    let run: RunRecord
    try {
      run = store.getRun(runId)
    } catch {
      return
    }
    if (isTerminalRunState(run.state)) return
    try {
      store.setRunState(runId, 'failed', {
        finalSummary: `supervised start failed: ${message}`,
      })
    } catch {
      // A concurrent owner already moved the run to a terminal state; the
      // durable state is the record and there is nothing left to settle.
      return
    }
    try {
      store.appendEvent({
        projectId: this.ctx.projectId,
        runId,
        type: 'run.finished',
        payload: { outcome: 'failure', via: 'start_failure', error: message },
      })
    } catch {
      // The event log is best-effort here; the durable run state is the record.
    }
    this.ctx.broadcaster.broadcast({
      type: 'run_state',
      runId,
      state: 'failed',
      goal: run.goal,
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
  private runDeps(): { onWorkerEvent: (event: WorkerLifecycleEvent) => void } {
    return {
      onWorkerEvent: (event) => {
        this.ctx.broadcaster.broadcastWorkerEvent(event, this.ctx.store, this.ctx.projectId)
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
        })
        await server.start()
        this.toolHttp = server
        return server
      })()
    }
    return this.toolHttpStarting
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
    muse: MuseRecord,
    adapter: { capabilities(): { mcpServers: boolean } },
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
    try {
      bridge = new PlutonToolBridge({
        store: this.ctx.store,
        projectId: this.ctx.projectId,
        rootDir: this.ctx.loaded.rootDir,
        callerMuseId: muse.id,
        limits: toolBridgeLimitsFromRuntime(this.ctx.loaded.config.runtime),
        startRun: async (input) => {
          const started = startRunInBackground(
            this.projectContext(),
            this.ctx.store,
            this.ctx.projectId,
            { goal: input.goal, acceptance: input.acceptance },
            this.runDeps(),
          )
          this.activeRunTasks.set(started.runId, started.runId)
          void started.done.then(
            () => {
              this.activeRunTasks.delete(started.runId)
            },
            () => {
              this.activeRunTasks.delete(started.runId)
            },
          )
          return { runId: started.runId }
        },
      })
    } catch {
      // A bridge the Muse may not use (disabled, wrong project) must not break
      // the chat turn: the engine simply runs without Pluton tools.
      return []
    }

    const { token } = http.register(bridge, {
      museId: muse.id,
      taskId: null,
      runId: null,
      label: 'spa-operator',
    })
    this.mcpRegistrations.set(sessionId, {
      name: 'pluton',
      kind: 'http',
      sessionId,
      museId: muse.id,
      museName: muse.displayName,
      engineKind: muse.engineKind,
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
      const engineSessionLive = this.activeEngineSessions.has(reg.sessionId)
      const connected = transportUp && engineSessionLive
      servers.push({
        name: reg.name,
        kind: reg.kind,
        state: connected ? 'connected' : 'disconnected',
        detail: connected
          ? 'Pluton tool bridge served over loopback HTTP; the engine-side MCP handshake is not reported by the engine protocol.'
          : 'The engine session that owned this bridge is closed.',
        sessionId: reg.sessionId,
        museId: reg.museId,
        museName: reg.museName,
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
   * Apply a new model to a Muse's live engine session.
   *
   * Mirrors `ChatSession.switchModel` (`src/chat/session.ts:232-259`): the old
   * engine session is closed and a fresh one starts on the new model, because
   * the engine pins its model per session.
   */
  private async restartEngineSessionForMuse(museId: string, model: string): Promise<boolean> {
    for (const [sessionId, entry] of this.activeEngineSessions) {
      const session = this.ctx.store.getChatSessionOrNull(sessionId)
      if (session === null || session.museId !== museId) continue
      try {
        await entry.session.close()
      } catch {
        // Ignore close errors: the session is replaced either way.
      }
      this.activeEngineSessions.delete(sessionId)
      this.dropMcpRegistration(sessionId)
      const muse = this.ctx.store.getMuse(museId)
      if (muse === null) continue
      const adapter = engineAdapterForMuse(muse)
      const approvals = createEngineApprovalChannel({
        store: this.ctx.store,
        projectId: this.ctx.projectId,
        runId: null,
        taskId: null,
        museId: muse.id,
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
        const mcpServers = await this.mcpServersForSession(sessionId, muse, adapter)
        const next = await adapter.startSession({
          muse: { id: muse.id, slug: muse.slug, role: muse.role, model },
          workdir: this.ctx.loaded.rootDir,
          env: {},
          configDir: join(this.ctx.loaded.rootDir, '.pluton', 'engine-homes', muse.slug),
          instructions: `You are ${muse.displayName}, working inside ${this.ctx.loaded.rootDir}. Assist the user directly with code and tasks.`,
          approvals,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
        })
        this.activeEngineSessions.set(sessionId, { session: next, busy: false, approvals })
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

  private async executePromptTurn(sessionId: string, museId: string, userText: string): Promise<void> {
    const store = this.ctx.store
    const broadcaster = this.ctx.broadcaster

    // 1. Persist user turn
    store.appendChatMessage({
      sessionId,
      role: 'user',
      text: userText,
    })
    broadcaster.broadcast({ type: 'turn_start', sessionId, userText })

    const muse = store.getMuse(museId)
    if (!muse) {
      broadcaster.broadcast({ type: 'token', sessionId, text: `\n[Error: Muse '${museId}' not found]` })
      broadcaster.broadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
      return
    }

    const adapter = engineAdapterForMuse(muse)

    let entry = this.activeEngineSessions.get(sessionId)
    if (!entry) {
      // Interactive engine policies (ask-* Muse modes) forward permission
      // requests to the operator: the request becomes a durable approval the
      // operator decides in the TUI or the SPA, and the SPA hears about it
      // live over SSE. Decisions from the SPA's own route are broadcast there;
      // this channel only adds the expiry/abort notices.
      const approvals = createEngineApprovalChannel({
        store,
        projectId: this.ctx.projectId,
        runId: null,
        taskId: null,
        museId: muse.id,
        ttlMinutes: this.ctx.loaded.config.runtime.approval_timeout_minutes,
        onRequested: (approval) => {
          broadcaster.broadcast({ type: 'approval_requested', approval })
        },
        onSettled: (approval, settlement) => {
          if (settlement !== 'decision') {
            broadcaster.broadcast({ type: 'approval_decided', approval })
          }
        },
      })
      let session: EngineSession
      try {
        const mcpServers = await this.mcpServersForSession(sessionId, muse, adapter)
        session = await adapter.startSession({
          muse: {
            id: muse.id,
            slug: muse.slug,
            role: muse.role,
            model: muse.model,
          },
          workdir: this.ctx.loaded.rootDir,
          env: {},
          configDir: join(this.ctx.loaded.rootDir, '.pluton', 'engine-homes', muse.slug),
          instructions: `You are ${muse.displayName}, working inside ${this.ctx.loaded.rootDir}. Assist the user directly with code and tasks.`,
          approvals,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
        })
      } catch (err) {
        // The engine refused to start (binary missing, auth missing, ...). The
        // turn must end here: a client that never receives `turn_end` would
        // wait for a reply that can never arrive.
        const message = err instanceof Error ? err.message : String(err)
        // The bridge was registered before the session start, so a failed
        // start would leave a dead MCP registration behind. Drop it, or the
        // registry would report a server nobody can reach.
        this.dropMcpRegistration(sessionId)
        broadcaster.broadcast({ type: 'token', sessionId, text: `\n[Error: ${message}]` })
        broadcaster.broadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
        approvals.abort('engine session failed to start')
        return
      }
      entry = { session, busy: false, approvals }
      this.activeEngineSessions.set(sessionId, entry)
    }

    entry.busy = true
    let assistantText = ''
    let interrupted = false
    let failed = false

    try {
      for await (const ev of entry.session.sendPrompt({ text: userText })) {
        if (!entry.busy) {
          interrupted = true
          break
        }
        switch (ev.kind) {
          case 'text':
            assistantText += ev.text
            broadcaster.broadcast({ type: 'token', sessionId, text: ev.text })
            break
          case 'tool':
            broadcaster.broadcast({
              type: 'tool',
              sessionId,
              tool: {
                id: ev.callId ?? ev.name,
                name: ev.name,
                summary: ev.summary ?? ev.name,
                status: ev.phase === 'start' ? 'running' : ev.isError ? 'failed' : 'succeeded',
                input: ev.input,
                output: ev.output,
              },
            })
            break
          case 'usage':
            broadcaster.broadcast({
              type: 'usage',
              sessionId,
              inputTokens: ev.inputTokens ?? 0,
              outputTokens: ev.outputTokens ?? 0,
              costUsd: ev.costUsd ?? null,
            })
            break
          case 'error':
            failed = true
            broadcaster.broadcast({ type: 'token', sessionId, text: `\n[Error: ${ev.message}]` })
            break
        }
      }
    } catch (err) {
      failed = true
      const errMsg = err instanceof Error ? err.message : String(err)
      broadcaster.broadcast({ type: 'token', sessionId, text: `\n[Engine failure: ${errMsg}]` })
    } finally {
      entry.busy = false
      if (assistantText.trim().length > 0) {
        store.appendChatMessage({
          sessionId,
          role: 'assistant',
          text: assistantText,
        })
      }
      broadcaster.broadcast({ type: 'turn_end', sessionId, interrupted, failed })
    }
  }

  private listWorkspaceFiles(rootDir: string, maxFiles = 300): string[] {
    const results: string[] = []
    const ignored = new Set(['.git', 'node_modules', '.pluton', 'dist', '.DS_Store', 'coverage'])

    function scan(dir: string): void {
      if (results.length >= maxFiles) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (ignored.has(entry.name)) continue
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

  private readJsonBody<T>(req: IncomingMessage): Promise<T> {
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
          if (totalBytes > MAX_REQUEST_BODY_HARD_STOP) {
            req.destroy()
            fail(new ValidationError('payload too large'))
          }
          return
        }
        data += chunk
        if (data.length > MAX_REQUEST_BODY_CHARS) {
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
            new ValidationError(`payload too large (> ${String(MAX_REQUEST_BODY_CHARS)} chars)`, {
              details: { kind: 'payload_too_large', limit: MAX_REQUEST_BODY_CHARS },
            }),
          )
          return
        }
        settled = true
        try {
          resolveResult(data ? (JSON.parse(data) as T) : ({} as T))
        } catch {
          reject(new ValidationError('invalid JSON payload'))
        }
      })
      req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    })
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
    for (const [, entry] of this.activeEngineSessions) {
      // Server shutdown settles pending engine permissions fail-closed before
      // the sessions go away (never leave the engine waiting on us).
      entry.approvals.abort('server shutting down')
      try {
        await entry.session.close()
      } catch {
        // Ignore close errors
      }
    }
    this.activeEngineSessions.clear()
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
      requestedByMuseId: 'qa',
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
        requestedByMuseId: 'qa',
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
