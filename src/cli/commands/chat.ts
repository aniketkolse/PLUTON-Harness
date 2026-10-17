/**
 * `pluton chat` command implementation (ADR-0012).
 * Boots the operator session: resolves Muse, session persistence,
 * tool bridge with operator catalog, container / sandbox setup, and TUI loop.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findManager } from '../../config/load.ts'
import { ConfigError, NotFoundError, ValidationError, InternalError } from '../../domain/errors.ts'
import { isTerminalRunState } from '../../domain/state.ts'
import type { ChatSessionRecord, MuseRecord } from '../../domain/models.ts'
import type { AcpSpawnFn } from '../../engines/acp/client.ts'
import { engineAdapterForMuse } from '../../engines/approval.ts'
import type { EngineAdapter, McpServerSpec } from '../../engines/contract/types.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import type { WorkerImageProbe } from '../../sandbox/image.ts'
import type { SandboxManager } from '../../sandbox/types.ts'
import { sandboxContainerName } from '../../sandbox/types.ts'
import { bootstrapStore } from '../../bootstrap.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../../tools/bridge.ts'
import { ToolHttpServer } from '../../tools/http-transport.ts'
import type { OperatorToolEnv } from '../../tools/operator-catalog.ts'
import { TerminalHost, type ChatIo } from '../../tui/terminal.ts'
import { ChatSession, type ChatSessionDeps } from '../../chat/session.ts'
import { operatorPreamble } from '../../chat/prompt.ts'
import type { ProjectContext } from '../context.ts'
import { decideApproval } from './approvals.ts'
import { resolveMuseByRef } from './mcp.ts'
import { runLine } from './status.ts'
import { containerAdapterFor, prepareContainerMode, startRunInBackground, type RunDeps } from './run.ts'
import { defaultSlashHelp, type SlashContext } from '../../chat/commands.ts'

export interface ChatCommandOptions {
  museRef?: string
  resume?: string
  continue?: boolean
  json?: boolean
}

export interface ChatDeps {
  adapterFor?: (muse: MuseRecord) => EngineAdapter
  sandboxManager?: SandboxManager
  workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe>
  dockerSpawn?: AcpSpawnFn
  io?: ChatIo
  startRun?: OperatorToolEnv['startRun']
  poll?: ChatSessionDeps['poll']
}

export interface ChatPlan {
  museId: string
  museSlug: string
  engineKind: string
  model: string
  mode: 'docker' | 'local-process'
  containerName: string | null
  sessionId: string
  resumed: boolean
  messageCount: number
  bridge: { kind: 'http'; label: 'operator'; url: string } | null
}

function resolveChatMuse(ctx: ProjectContext, store: Store, museRef: string | undefined, projectId: string): MuseRecord {
  let muse: MuseRecord
  if (museRef !== undefined) {
    muse = resolveMuseByRef(store, museRef)
  } else {
    const found = findManager(ctx.loaded.config)
    if (!found) {
      throw new ConfigError("no Muse with role 'supervisor' in pluton.yaml — add one or pass a muse ref")
    }
    const m = store.getMuse(found[0])
    if (!m) throw new NotFoundError('muse', found[0])
    muse = m
  }

  if (!muse.enabled) {
    throw new ValidationError(`muse '${muse.slug}' is disabled in configuration`)
  }
  if (muse.projectId !== projectId) {
    throw new ValidationError(`muse '${muse.id}' belongs to another project`)
  }
  return muse
}

function resolveChatSession(
  store: Store,
  projectId: string,
  museId: string,
  opts: ChatCommandOptions,
): { session: ChatSessionRecord; resumed: boolean } {
  if (opts.resume !== undefined) {
    const session = store.getChatSession(opts.resume)
    if (session.projectId !== projectId) {
      throw new ValidationError(`chat session '${session.id}' belongs to another project`)
    }
    return { session, resumed: true }
  }

  if (opts.continue === true) {
    const latest = store.getLatestChatSession(projectId, museId)
    if (latest !== null) {
      return { session: latest, resumed: true }
    }
  }

  const session = store.createChatSession({ projectId, museId })
  return { session, resumed: false }
}

export async function chatRun(
  ctx: ProjectContext,
  opts: ChatCommandOptions,
  deps: ChatDeps = {},
): Promise<{ exitCode: number; plan: ChatPlan }> {
  const { store, projectId } = bootstrapStore(ctx.loaded)

  try {
    const muse = resolveChatMuse(ctx, store, opts.museRef, projectId)
    const { session, resumed } = resolveChatSession(store, projectId, muse.id, opts)
    const storedMessages = store.listChatMessages(session.id)
    const messageCount = storedMessages.length

    const isDocker = ctx.loaded.config.sandbox.kind === 'docker'
    const mode: 'docker' | 'local-process' = isDocker ? 'docker' : 'local-process'
    const containerName = isDocker ? sandboxContainerName(projectId, muse.id) : null

    const basePlan: ChatPlan = {
      museId: muse.id,
      museSlug: muse.slug,
      engineKind: muse.engineKind,
      model: muse.model,
      mode,
      containerName,
      sessionId: session.id,
      resumed,
      messageCount,
      bridge: null,
    }

    if (opts.json) {
      return { exitCode: 0, plan: basePlan }
    }

    const io = deps.io ?? new TerminalHost()
    if (!io.isTty) {
      throw new ValidationError(
        'pluton chat needs an interactive terminal (stdin/stdout are not a TTY); use --json to resolve the chat plan',
      )
    }

    let adapter: EngineAdapter
    if (isDocker) {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      const contexts = await prepareContainerMode(
        ctx,
        store,
        projectId,
        sandboxManager,
        deps.workerImageProbe,
        { museIds: [muse.id] },
      )
      adapter = deps.adapterFor?.(muse) ?? containerAdapterFor(muse, contexts, deps.dockerSpawn)
    } else {
      createSandboxManager(ctx.loaded.config)
      adapter = deps.adapterFor?.(muse) ?? engineAdapterForMuse(muse)
    }

    let activeRunId: string | null = null
    let activeRunDone: Promise<unknown> | null = null
    let sessionInstance: ChatSession | null = null

    const runStarter = deps.startRun
      ? async (input: { goal: string; acceptance: string[]; requestId?: string }) => {
          if (activeRunId !== null) {
            throw new ValidationError(`a run started from this chat is still active: ${activeRunId}`)
          }
          activeRunId = 'pending'
          try {
            const res = await deps.startRun!(input)
            activeRunId = res.runId
            return res
          } catch (e) {
            activeRunId = null
            throw e
          }
        }
      : async (input: { goal: string; acceptance: string[]; requestId?: string }) => {
          if (activeRunId !== null) {
            throw new ValidationError(`a run started from this chat is still active: ${activeRunId}`)
          }
          const runDeps: RunDeps = {
            adapterFor: deps.adapterFor,
            sandboxManager: deps.sandboxManager,
            workerImageProbe: deps.workerImageProbe,
            dockerSpawn: deps.dockerSpawn,
          }
          const { runId, done } = startRunInBackground(
            ctx,
            store,
            projectId,
            {
              goal: input.goal,
              acceptance: input.acceptance,
              ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            },
            runDeps,
          )
          activeRunId = runId
          activeRunDone = done
          void done.then(
            (summary) => {
              if (activeRunId === runId) {
                activeRunId = null
              }
              sessionInstance?.commitLine(`run ${runId} finished: ${summary.outcome ?? summary.state}`)
            },
            (err) => {
              if (activeRunId === runId) {
                activeRunId = null
              }
              const msg = err instanceof Error ? err.message : String(err)
              sessionInstance?.commitLine(`run ${runId} failed: ${msg}`)
            },
          )
          return { runId }
        }

    const limits = toolBridgeLimitsFromRuntime(ctx.loaded.config.runtime)
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir: ctx.rootDir,
      callerMuseId: muse.id,
      limits,
      startRun: runStarter,
    })

    const httpServer = new ToolHttpServer({
      host: isDocker ? '0.0.0.0' : '127.0.0.1',
      port: 0,
    })
    const { url } = await httpServer.start()
    const { token } = httpServer.register(bridge, {
      museId: muse.id,
      taskId: null,
      runId: null,
      label: 'operator',
    })

    const clientUrl = isDocker ? url.replace('0.0.0.0', 'host.docker.internal') : url
    const mcpServers: McpServerSpec[] = [
      {
        kind: 'http',
        name: 'pluton',
        url: clientUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    ]

    let instructions = operatorPreamble(muse)
    if (muse.instructionsFile) {
      try {
        const custom = readFileSync(join(ctx.rootDir, muse.instructionsFile), 'utf8')
        instructions = `${instructions}\n\n${custom}`
      } catch {
        // file missing or unreadable; proceed with preamble
      }
    }

    let eventCursor = store.latestEventSeq(projectId)
    const seenApprovalIds = new Set<string>()

    const defaultPoll = async () => {
      const newEvents = store.eventsSince(projectId, eventCursor, 50)
      if (newEvents.length > 0) {
        eventCursor = newEvents[newEvents.length - 1]!.seq
      }
      const allowedRegex = /^(run|task|verification|approval)\./
      const filtered = newEvents.filter((e) => allowedRegex.test(e.type))
      const eventLines = filtered.slice(0, 20).map((e) => {
        let detail = ''
        if (e.payload && typeof e.payload === 'object') {
          const p = e.payload as Record<string, unknown>
          if (p.summary) detail = String(p.summary)
          else if (p.state) detail = String(p.state)
          else if (p.outcome) detail = String(p.outcome)
          else if (p.reason) detail = String(p.reason)
        }
        const line = detail ? `${e.type}: ${detail}` : `${e.type} (${e.runId ?? e.taskId ?? ''})`
        return {
          seq: e.seq,
          type: e.type,
          line,
        }
      })

      const runs = store.listRuns(1)
      const run = runs.length > 0 && runs[0]!.projectId === projectId ? { id: runs[0]!.id, state: runs[0]!.state } : null

      const pendingApprovals = store.listApprovalsByProject(projectId, { status: 'pending', limit: 100 })
      const approvalsPending = pendingApprovals.length

      const notices: string[] = []
      for (const a of pendingApprovals) {
        if (!seenApprovalIds.has(a.id)) {
          seenApprovalIds.add(a.id)
          notices.push(`approval pending: ${a.id} (${a.action})`)
        }
      }

      return {
        events: eventLines,
        run,
        approvalsPending,
        notices,
      }
    }

    let slashSeq = 0
    let currentChatSession = session

    const slashContext: SlashContext = {
      session: {
        get id() {
          return currentChatSession.id
        },
        set id(newId: string) {
          currentChatSession = store.getChatSession(newId)
        },
      },
      muse: { id: muse.id, slug: muse.slug },
      status: async () => {
        const runs = store.listRuns(1)
        const currentRun = runs.length > 0 && runs[0]!.projectId === projectId ? runs[0]! : null
        const pending = store.listApprovalsByProject(projectId, { status: 'pending', limit: 100 })
        const lines = [
          `Project: ${ctx.loaded.config.project.name} (${projectId})`,
          `Operator: ${muse.slug} (${muse.model})`,
          `Chat session: ${currentChatSession.id} (${currentChatSession.state})`,
          currentRun ? `Current run: ${runLine(currentRun)}` : 'No runs recorded yet',
          `Pending approvals: ${pending.length}`,
        ]
        return lines.join('\n')
      },
      runs: async (limit: number) => {
        const allRuns = store.listRuns(limit)
        if (allRuns.length === 0) return 'no runs recorded'
        const rows = ['ID        STATE              CREATED              GOAL']
        for (const r of allRuns) {
          rows.push(runLine(r))
        }
        return rows.join('\n')
      },
      approvalsList: async () => {
        const pending = store.listApprovalsByProject(projectId, { status: 'pending', limit: 100 })
        if (pending.length === 0) return 'no pending approvals'
        const rows = ['ID                       ACTION          REQUESTED BY     REASON']
        for (const a of pending) {
          rows.push(`${a.id}  ${a.action.padEnd(14)}  ${(a.requestedByMuseId ?? '-').padEnd(15)}  ${a.reason}`)
        }
        return rows.join('\n')
      },
      approve: async (ref: string) => {
        const reqId = `chat-${currentChatSession.id}-slash-${++slashSeq}`
        const report = await decideApproval(ctx, { approvalRef: ref, decision: 'approve', requestId: reqId })
        return `approval ${report.approval.id} (${report.approval.action}) approved by ${report.approval.decidedBy ?? 'operator'}`
      },
      deny: async (ref: string) => {
        const reqId = `chat-${currentChatSession.id}-slash-${++slashSeq}`
        const report = await decideApproval(ctx, { approvalRef: ref, decision: 'deny', requestId: reqId })
        return `approval ${report.approval.id} (${report.approval.action}) denied by ${report.approval.decidedBy ?? 'operator'}`
      },
      startRun: async (goal: string) => {
        const reqId = `chat-${currentChatSession.id}-slash-${++slashSeq}`
        const res = await runStarter({ goal, acceptance: [], requestId: reqId })
        return `started run ${res.runId}`
      },
      newSession: async () => {
        store.updateChatSession(currentChatSession.id, { state: 'closed' })
        const next = store.createChatSession({ projectId, museId: muse.id })
        currentChatSession = next
        return `closed previous session and started new session ${next.id}`
      },
      help: () => defaultSlashHelp(),
    }

    const chatSession = new ChatSession({
      store,
      projectId,
      rootDir: ctx.rootDir,
      muse,
      adapter,
      io,
      session,
      mcpServers,
      instructions,
      resumeToken: session.resumeToken,
      startRun: runStarter,
      slashContext,
      poll: deps.poll ?? defaultPoll,
    })
    sessionInstance = chatSession

    let exitCode = 0
    try {
      await chatSession.start()
      exitCode = await chatSession.run()
    } finally {
      chatSession.stop()
      if (activeRunId !== null && activeRunId !== 'pending') {
        try {
          const run = store.getRun(activeRunId)
          if (!isTerminalRunState(run.state)) {
            store.setRunState(activeRunId, 'cancelled', { finalSummary: 'chat session exited' })
            store.appendEvent({
              projectId,
              runId: activeRunId,
              type: 'run.cancelled',
              payload: { reason: 'chat session exited' },
            })
          }
        } catch {
          // best-effort
        }
      }
      if (activeRunDone !== null) {
        await Promise.race([activeRunDone, new Promise((r) => setTimeout(r, 1000))])
      }
      await httpServer.stop()
    }

    const plan: ChatPlan = {
      ...basePlan,
      bridge: {
        kind: 'http',
        label: 'operator',
        url: clientUrl,
      },
    }

    return { exitCode, plan }
  } finally {
    store.close()
  }
}
