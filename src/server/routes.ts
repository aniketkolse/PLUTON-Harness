/**
 * REST API route dispatcher for Pluton Application Server (ADR-0014).
 * Single authoritative bridge connecting frontend clients to the Pluton runtime.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from '../store/store.ts'
import type { LoadedConfig } from '../config/load.ts'
import { getEngineAdapter, registerBuiltinEngines } from '../engines/registry.ts'
import type { EngineSession } from '../engines/contract/types.ts'
import { PLUTON_VERSION } from '../version.ts'
import { safeResolvePath } from './security.ts'
import type { ServerEventBroadcaster } from './events.ts'
import type {
  HealthResponse,
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

export class ApiRouter {
  private readonly ctx: RouteContext
  private readonly activeEngineSessions = new Map<string, { session: EngineSession; busy: boolean }>()

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
        const activeRun = runs.find((r) =>
          ['planning', 'running', 'awaiting_approval', 'verifying'].includes(r.state),
        ) ?? null
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
        if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
          this.sendJson(res, 404, { ok: false, error: 'file not found' })
          return true
        }
        const stat = statSync(resolved)
        if (stat.size > 2 * 1024 * 1024) {
          this.sendJson(res, 413, { ok: false, error: 'file too large to inspect in editor (> 2MB)' })
          return true
        }
        const content = readFileSync(resolved, 'utf8')
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
        const detail: RunDetailView = {
          run,
          tasks,
          edges,
          approvals,
          usage,
        }
        this.sendJson(res, 200, { ok: true, run: detail })
        return true
      }

      // 11. Approvals list
      if (pathname === '/api/approvals' && method === 'GET') {
        this.ctx.store.expirePendingApprovals(new Date().toISOString(), this.ctx.projectId)
        const approvals = this.ctx.store.listApprovalsByProject(this.ctx.projectId)
        this.sendJson(res, 200, { ok: true, approvals })
        return true
      }

      // 12. Approval Decision
      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/)
      if (approvalMatch && method === 'POST') {
        const approvalId = approvalMatch[1]!
        const payload = await this.readJsonBody<{ decision?: 'approved' | 'denied' }>(req)
        if (!payload.decision || !['approved', 'denied'].includes(payload.decision)) {
          this.sendJson(res, 400, { ok: false, error: "decision must be 'approved' or 'denied'" })
          return true
        }
        const approval = this.ctx.store.getApprovalOrNull(approvalId)
        if (!approval) {
          this.sendJson(res, 404, { ok: false, error: `approval '${approvalId}' not found` })
          return true
        }
        if (approval.status !== 'pending') {
          this.sendJson(res, 409, { ok: false, error: `approval is already '${approval.status}'` })
          return true
        }
        const updated = this.ctx.store.setApprovalStatus(approvalId, payload.decision, {
          decidedBy: 'operator:ui',
        })
        this.ctx.broadcaster.broadcast({
          type: 'approval_decided',
          approval: updated,
        })
        this.sendJson(res, 200, { ok: true, approval: updated })
        return true
      }

      // 13. Muses list
      if (pathname === '/api/muses' && method === 'GET') {
        const muses = this.ctx.store.listMuses()
        this.sendJson(res, 200, { ok: true, muses })
        return true
      }

      // 14. Models list
      if (pathname === '/api/models' && method === 'GET') {
        const muses = this.ctx.store.listMuses()
        const modelsByEngine: Record<string, unknown[]> = {}
        for (const muse of muses) {
          if (!modelsByEngine[muse.engineKind]) {
            try {
              const adapter = getEngineAdapter(muse.engineKind)
              modelsByEngine[muse.engineKind] = await adapter.listModels()
            } catch {
              modelsByEngine[muse.engineKind] = [{ id: muse.model, source: 'config' }]
            }
          }
        }
        this.sendJson(res, 200, { ok: true, models: modelsByEngine })
        return true
      }

      // Not found in API routes
      this.sendJson(res, 404, { ok: false, error: `API route '${pathname}' not found` })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.sendJson(res, 500, { ok: false, error: message })
      return true
    }
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

    const adapter = getEngineAdapter(muse.engineKind)

    let entry = this.activeEngineSessions.get(sessionId)
    if (!entry) {
      const session = await adapter.startSession({
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
      })
      entry = { session, busy: false }
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
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1024 * 1024) {
          req.destroy()
          reject(new Error('payload too large (> 1MB)'))
        }
      })
      req.on('end', () => {
        try {
          resolveResult(data ? (JSON.parse(data) as T) : ({} as T))
        } catch {
          reject(new Error('invalid JSON payload'))
        }
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const json = JSON.stringify(data)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
    })
    res.end(json)
  }

  async close(): Promise<void> {
    for (const [, entry] of this.activeEngineSessions) {
      try {
        await entry.session.close()
      } catch {
        // Ignore close errors
      }
    }
    this.activeEngineSessions.clear()
  }
}
