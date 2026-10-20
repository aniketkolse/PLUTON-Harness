/**
 * `pluton chat` command implementation (ADR-0012).
 * Boots the operator session: resolves Muse, session persistence,
 * tool bridge with operator catalog, container / sandbox setup, and TUI loop.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findManager } from '../../config/load.ts'
import { ConfigError, NotFoundError, StateTransitionError, ValidationError, InternalError } from '../../domain/errors.ts'
import { isTerminalRunState } from '../../domain/state.ts'
import type { ChatSessionRecord, MuseRecord } from '../../domain/models.ts'
import type { AcpSpawnFn } from '../../engines/acp/client.ts'
import { engineAdapterForMuse } from '../../engines/approval.ts'
import { createEngineApprovalChannel } from '../../engines/interactive-approval.ts'
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
import { terminalSafeLine } from '../../util/sanitize.ts'
import { containerAdapterFor, prepareContainerMode, startRunInBackground, type RunDeps } from './run.ts'
import { collectDoctorChecks } from './doctor.ts'
import { PlanManager } from '../../plan/manager.ts'
import { renderPlanGraph } from '../../tui/plan-graph.ts'
import { defaultSlashHelp, type SlashContext } from '../../chat/commands.ts'
import { runTuiDemo } from '../../ui/demo.ts'
import { getUITheme } from '../../ui/theme.ts'

export interface ChatCommandOptions {
  museRef?: string
  resume?: string
  continue?: boolean
  json?: boolean
  demo?: boolean
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

    if (opts.demo) {
      const io = deps.io ?? new TerminalHost({ alternateScreen: true })
      io.start()
      try {
        const theme = getUITheme({ color: io.isTty })
        await runTuiDemo(io, theme)
        return { exitCode: 0, plan: basePlan }
      } finally {
        io.stop()
      }
    }

    const io = deps.io ?? new TerminalHost({ alternateScreen: true })
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

    // Interactive engine policies (ask-* Muse modes) forward engine permission
    // requests to the operator: the request becomes a durable approval shown in
    // the TUI approval card (and the SPA), and the engine waits — fail-closed —
    // until the operator decides through the same decision funnel. The chat
    // poll below discovers it; `/permissions approve|deny` answers it.
    const engineApprovals = createEngineApprovalChannel({
      store,
      projectId,
      runId: null,
      taskId: null,
      museId: muse.id,
      ttlMinutes: ctx.loaded.config.runtime.approval_timeout_minutes,
    })

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
      // Full records drive the canonical approval card; no raw text notices.
      const approvals = pendingApprovals.map((a) => ({
        id: a.id,
        action: a.action,
        reason: a.reason,
        ...(a.requestedByMuseId ? { requestedByMuse: a.requestedByMuseId } : {}),
        scope: a.scope,
        status: a.status,
        runId: a.runId,
        taskId: a.taskId,
        expiresAt: a.expiresAt,
      }))

      return {
        events: eventLines,
        run,
        approvalsPending: pendingApprovals.length,
        approvals,
        notices: [] as string[],
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
          rows.push(
            `${a.id}  ${terminalSafeLine(a.action).padEnd(14)}  ${(a.requestedByMuseId ?? '-').padEnd(15)}  ${terminalSafeLine(a.reason)}`,
          )
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
      cancel: async (runId?: string) => {
        const targetId = (runId ?? '').trim() || activeRunId
        if (!targetId) {
          return 'No active run to cancel. Specify a run ID with /cancel <runId>.'
        }
        const run = store.getRun(targetId)
        if (!run) {
          return `Run '${targetId}' not found.`
        }
        if (['completed', 'failed', 'cancelled'].includes(run.state)) {
          return `Run '${targetId}' is already ${run.state}.`
        }
        try {
          store.setRunState(targetId, 'cancelled')
        } catch (e) {
          // A concurrent terminal write (another cancel source) won the CAS:
          // the intent is satisfied — report the durable winner, no second event.
          if (!(e instanceof StateTransitionError)) throw e
          const fresh = store.getRun(targetId)
          if (!isTerminalRunState(fresh.state)) throw e
          return `Run '${targetId}' is already ${fresh.state}.`
        }
        store.appendEvent({
          projectId,
          runId: targetId,
          type: 'run.cancelled',
          payload: { reason: 'operator cancelled via /cancel' },
        })
        if (activeRunId === targetId) {
          activeRunId = null
        }
        return `Cancelled run ${targetId}.`
      },
      models: async () => {
        const caps = adapter.capabilities()
        if (!caps.modelList) {
          return `Engine '${muse.engineKind}' does not support dynamic model listing. Current model: ${muse.model}`
        }
        try {
          const list = await adapter.listModels()
          if (list.length === 0) {
            return `No models reported by engine '${muse.engineKind}'. Current model: ${muse.model}`
          }
          const lines = [`Available models for engine '${muse.engineKind}':`]
          for (const m of list) {
            const isCurrent = m.id === muse.model ? ' (current)' : ''
            const name = m.label && m.label !== m.id ? ` — ${m.label}` : ''
            lines.push(`  • ${m.id}${name}${isCurrent}`)
          }
          return lines.join('\n')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to list models: ${msg}`
        }
      },
      model: async (targetModel?: string) => {
        const trimmed = (targetModel ?? '').trim()
        if (!trimmed) {
          const currentRun = activeRunId ? store.getRun(activeRunId) : null
          const activeRunInfo = currentRun
            ? `\nActive run (${currentRun.id}) model: ${
                currentRun.managerMuseId ? store.getMuse(currentRun.managerMuseId)?.model ?? 'unknown' : 'none'
              }`
            : ''
          return `Current model for ${muse.slug}: ${muse.model}${activeRunInfo}`
        }

        const caps = adapter.capabilities()
        if (caps.modelList) {
          try {
            const list = await adapter.listModels()
            const match = list.find((m) => m.id === trimmed || m.label === trimmed)
            if (!match && list.length > 0) {
              const available = list.map((m) => m.id).join(', ')
              return `Model '${trimmed}' is not supported by engine '${muse.engineKind}'. Available models: ${available}`
            }
          } catch {
            // If listing fails at runtime, proceed with requested model
          }
        }

        try {
          store.updateMuseModel(muse.id, trimmed)
          muse.model = trimmed
          if (sessionInstance) {
            await sessionInstance.switchModel(trimmed)
          }
          return `Switched model for ${muse.slug} to ${trimmed}. Subsequent turns will use this model.`
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to switch model: ${msg}`
        }
      },
      plan: async (args?: string) => {
        const planMgr = new PlanManager(store, projectId, currentChatSession.id)
        const sub = (args ?? '').trim()

        const showCurrent = () => {
          const current = planMgr.getCurrentPlan()
          if (!current) {
            return 'No active plan for this session. Use /plan <goal> to start a new plan.'
          }
          const activeTasks = current.runId ? store.listTasks(current.runId) : []
          return renderPlanGraph(current, activeTasks)
        }

        if (!sub || sub === 'show') {
          return showCurrent()
        }

        if (sub === 'review') {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan. Use /plan <goal> first.'
          try {
            const p = planMgr.reviewPlan(current.id)
            return renderPlanGraph(p)
          } catch (err) {
            return `Cannot review plan: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        if (sub === 'approve') {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan. Use /plan <goal> first.'
          try {
            const p = planMgr.approvePlan(current.id)
            return renderPlanGraph(p)
          } catch (err) {
            return `Cannot approve plan: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        if (sub === 'run' || sub === 'execute' || sub === 'confirm') {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan. Use /plan <goal> first.'
          if (current.state !== 'APPROVED') {
            return `Plan must be APPROVED before execution (currently ${current.state}). Use /plan review and /plan approve first.`
          }
          try {
            const executed = await planMgr.executePlan(current.id, async (p) => {
              const reqId = `chat-${currentChatSession.id}-plan-${++slashSeq}`
              const res = await runStarter({
                goal: p.goal,
                acceptance: p.tasks.flatMap((t) => t.acceptanceCriteria),
                requestId: reqId,
              })
              const runId = res.runId

              const idMap = new Map<string, string>()
              for (const t of p.tasks) {
                const admitted = store.createTask({
                  runId,
                  parentTaskId: null,
                  title: t.title,
                  brief: t.description || t.title,
                  acceptanceCriteria: t.acceptanceCriteria,
                  assigneeMuseId: muse.id,
                  writeScope: t.writeScope,
                })
                idMap.set(t.id, admitted.id)
              }

              for (const t of p.tasks) {
                const toId = idMap.get(t.id)
                if (toId) {
                  for (const depId of t.dependsOn) {
                    const fromId = idMap.get(depId)
                    if (fromId) {
                      store.addEdge(runId, toId, fromId, 'depends_on')
                    }
                  }
                }
              }

              return runId
            })
            activeRunId = executed.runId
            return `Plan execution started in run ${executed.runId}!\n\n${renderPlanGraph(executed)}`
          } catch (err) {
            return `Execution failed: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        if (sub === 'cancel') {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan to cancel.'
          planMgr.cancelPlan(current.id)
          if (current.runId) {
            try {
              store.setRunState(current.runId, 'cancelled')
            } catch {
              // best effort
            }
          }
          return `Plan ${current.id} cancelled.`
        }

        if (sub === 'reset') {
          const current = planMgr.getCurrentPlan()
          if (current) {
            planMgr.cancelPlan(current.id)
          }
          return 'Plan reset. Use /plan <goal> to start fresh.'
        }

        if (sub.startsWith('add ')) {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan. Use /plan <goal> first.'
          const raw = sub.slice(4).trim()
          const title = raw.split(/\s--/)[0]?.trim() ?? ''
          const assigneeMatch = raw.match(/--assignee\s+([^\s]+)/)
          const needsMatch = raw.match(/--needs\s+([^\s]+)/)
          const descMatch = raw.match(/--desc\s+("([^"]+)"|'([^']+)'|([^\s]+))/)
          const acceptMatch = raw.match(/--accept\s+("([^"]+)"|'([^']+)'|([^\s]+))/)

          const taskId = `task-${current.tasks.length + 1}`
          const assigneeRole = assigneeMatch ? assigneeMatch[1]! : 'developer'
          const dependsOn = needsMatch
            ? needsMatch[1]!
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : []
          const description = descMatch ? (descMatch[2] ?? descMatch[3] ?? descMatch[4] ?? '') : ''
          const acceptanceCriteria = acceptMatch
            ? (acceptMatch[2] ?? acceptMatch[3] ?? acceptMatch[4] ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : ['Task completed and verified']

          try {
            const updated = planMgr.addTask(current.id, {
              id: taskId,
              title,
              description,
              assigneeRole,
              dependsOn,
              acceptanceCriteria,
            })
            return renderPlanGraph(updated)
          } catch (err) {
            return `Cannot add task: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        if (sub.startsWith('remove ')) {
          const current = planMgr.getCurrentPlan()
          if (!current) return 'No active plan.'
          const taskId = sub.slice(7).trim()
          try {
            const updated = planMgr.removeTask(current.id, taskId)
            return renderPlanGraph(updated)
          } catch (err) {
            return `Cannot remove task: ${err instanceof Error ? err.message : String(err)}`
          }
        }

        try {
          const current = planMgr.getCurrentPlan()
          if (current && ['DRAFT', 'REVIEW'].includes(current.state)) {
            const updated = planMgr.setGoal(current.id, sub)
            return renderPlanGraph(updated)
          }
          const created = planMgr.createPlanDraft(sub)
          return `Created plan ${created.id} (DRAFT):\n\n${renderPlanGraph(created)}`
        } catch (err) {
          return `Failed to create plan: ${err instanceof Error ? err.message : String(err)}`
        }
      },
      sessions: async (args?: string) => {
        const sub = (args ?? '').trim()
        if (sub.startsWith('switch ')) {
          const targetId = sub.slice(7).trim()
          const target = store.getChatSessionOrNull(targetId)
          if (!target || target.projectId !== projectId) {
            return `Session '${targetId}' not found for project.`
          }
          currentChatSession = target
          slashContext.session.id = target.id
          return `Switched active session to ${target.id} (${target.title || 'untitled'}).`
        }

        if (sub.startsWith('inspect')) {
          const targetId = sub.slice(7).trim() || currentChatSession.id
          const target = store.getChatSessionOrNull(targetId)
          if (!target || target.projectId !== projectId) {
            return `Session '${targetId}' not found.`
          }
          const msgs = store.listChatMessages(target.id, { limit: 5 })
          const lines = [
            `Session: ${target.id}`,
            `Title: ${target.title || '(untitled)'}`,
            `State: ${target.state}`,
            `Created: ${target.createdAt}`,
            `Updated: ${target.updatedAt}`,
            `Recent messages (${msgs.length}):`,
          ]
          for (const m of msgs) {
            const preview = m.text.replace(/\n/g, ' ').slice(0, 60)
            lines.push(`  [${m.role}] ${preview}`)
          }
          return lines.join('\n')
        }

        const list = store.listChatSessions(projectId, 20)
        if (list.length === 0) return 'No sessions recorded for this project.'
        const lines = ['Available chat sessions:']
        for (const s of list) {
          const isCurrent = s.id === currentChatSession.id ? ' (active)' : ''
          const title = s.title ? ` — ${s.title}` : ''
          lines.push(`  • ${s.id} [${s.state}] updated ${s.updatedAt}${title}${isCurrent}`)
        }
        lines.push('\nUse /sessions switch <id> to switch or /sessions inspect <id> to inspect.')
        return lines.join('\n')
      },
      doctor: async () => {
        try {
          const checks = await collectDoctorChecks({ cwd: ctx.rootDir })
          const lines = ['Runtime Doctor Report:']
          for (const c of checks) {
            let icon = '✓'
            if (c.status === 'warn') icon = '⚠'
            else if (c.status === 'fail') icon = '✗'
            else if (c.status === 'info') icon = 'ℹ'
            lines.push(`  ${icon} [${c.status.toUpperCase()}] ${c.title}: ${c.message}`)
            if (c.fix) {
              lines.push(`     Fix: ${c.fix}`)
            }
          }
          return lines.join('\n')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `Doctor diagnostics failed: ${msg}`
        }
      },
      permissions: async (args?: string) => {
        const sub = (args ?? '').trim()
        if (sub.startsWith('approve ')) {
          const ref = sub.slice(8).trim()
          return slashContext.approve(ref)
        }
        if (sub.startsWith('deny ')) {
          const ref = sub.slice(5).trim()
          return slashContext.deny(ref)
        }

        const lines = ['Effective Permissions by Muse:']
        const muses = store.listMuses().filter((m) => m.projectId === projectId)
        for (const m of muses) {
          lines.push(`  • ${m.slug} (${m.role}): [${m.permissions.join(', ')}]`)
          lines.push(`    Approval mode: ${m.approvalMode}, Policy: ${m.workspacePolicy}`)
        }

        const pending = store.listApprovalsByProject(projectId, { status: 'pending', limit: 50 })
        lines.push('')
        if (pending.length === 0) {
          lines.push('Pending approval requests: (none)')
        } else {
          lines.push(`Pending approval requests (${pending.length}):`)
          for (const a of pending) {
            lines.push(`  • [${a.id}] ${a.action} by ${a.requestedByMuseId ?? 'unknown'}: ${a.reason}`)
          }
          lines.push('\nUse /permissions approve <ref> or /permissions deny <ref> to respond.')
        }
        return lines.join('\n')
      },
      newSession: async () => {
        store.updateChatSession(currentChatSession.id, { state: 'closed' })
        const next = store.createChatSession({ projectId, museId: muse.id })
        currentChatSession = next
        return `closed previous session and started new session ${next.id}`
      },
      help: () => defaultSlashHelp(),
    }

    const exposedTools = bridge.listTools()
    const initialNotices: string[] = []
    if (exposedTools.length === 0) {
      initialNotices.push(
        `Warning: No Pluton operator tools are exposed to muse '${muse.slug}'. To expose operator tools, configure permissions in pluton.yaml: project.status, run.list, run.inspect, run.start, approvals.list`,
      )
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
      engineApprovals,
      initialNotices,
    })
    sessionInstance = chatSession

    let exitCode = 0
    try {
      await chatSession.start()
      exitCode = await chatSession.run()
    } finally {
      // Chat teardown settles any pending engine permission request fail-closed
      // (the engine gets a deny, not a hang).
      engineApprovals.abort('chat session exited')
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
