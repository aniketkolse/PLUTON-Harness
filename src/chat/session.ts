/**
 * Interactive chat session loop and event coordinator (ADR-0012).
 * Drives the terminal I/O, editor, streaming assistant turns, tool lines,
 * background run polling, and chat transcript persistence.
 */

import type { EngineAdapter, EngineSession, McpServerSpec } from '../engines/contract/types.ts'
import type { ChatSessionRecord, MuseRecord, TaskRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import type { OperatorToolEnv } from '../tools/operator-catalog.ts'
import { createTheme, type Theme } from '../tui/theme.ts'
import type { ChatIo } from '../tui/terminal.ts'
import {
  editorBackspace,
  editorDelete,
  editorHistory,
  editorInsert,
  editorKill,
  editorMove,
  expandPastes,
  initialEditor,
  type EditorState,
} from '../tui/editor.ts'
import { keyAction } from '../tui/keys.ts'
import {
  applyEngineEvent,
  beginTurn,
  endTurn,
  initialViewState,
  type ChatViewState,
} from '../tui/state.ts'
import {
  renderFullScreenFrame,
  renderHeader,
  renderInput,
  renderNotice,
  renderStatusLine,
  renderToolLine,
  type FullScreenFrameOptions,
  type StatusView,
} from '../tui/render.ts'
import { renderMarkdown } from '../tui/markdown.ts'
import {
  createToolActivity,
  updateToolActivity,
  renderToolActivity,
  type ToolActivityState,
} from '../tui/activity.ts'
import {
  renderApprovalCard,
  renderEngineRequestNotice,
  type ApprovalViewData,
} from '../tui/approval.ts'
import type { ApprovalRecord } from '../domain/models.ts'
import { wrapText } from '../tui/width.ts'
import { operatorPreamble } from './prompt.ts'
import type {
  OrchestraInspectorData,
  MuseInspectorItem,
  TaskInspectorItem,
  EventInspectorItem,
} from '../tui/orchestra.ts'
import {
  defaultSlashHelp,
  executeSlash,
  getCommandSuggestions,
  type SlashContext,
} from './commands.ts'

/** Map a durable approval record to its UI view data (target only when scope names one). */
function approvalRecordToView(record: ApprovalRecord): ApprovalViewData {
  let target: string | undefined
  const scope = record.scope
  if (scope !== null && typeof scope === 'object' && !Array.isArray(scope)) {
    const t = (scope as Record<string, unknown>)['target']
    if (typeof t === 'string' && t.length > 0) target = t
  }
  return {
    id: record.id,
    action: record.action,
    reason: record.reason,
    ...(target !== undefined ? { target } : {}),
    ...(record.requestedByMuseId ? { requestedByMuse: record.requestedByMuseId } : {}),
    scope: record.scope,
    status: record.status,
    runId: record.runId,
    taskId: record.taskId,
    expiresAt: record.expiresAt,
  }
}

export interface ChatSessionDeps {
  store: Store
  projectId: string
  rootDir: string
  muse: MuseRecord
  adapter: EngineAdapter
  io: ChatIo
  session: ChatSessionRecord
  mcpServers: McpServerSpec[]
  instructions?: string
  resumeToken?: string | null
  startRun?: OperatorToolEnv['startRun']
  slashContext?: SlashContext
  poll?: () => Promise<{
    events: { seq: number; type: string; line: string }[]
    run: { id: string; state: string } | null
    approvalsPending: number
    /** Full pending approval records; when provided they drive the canonical card. */
    approvals?: ApprovalViewData[]
    notices: string[]
  }>
  pollIntervalMs?: number
  now?: () => number
  initialNotices?: string[]
}

export class ChatSession {
  private readonly deps: ChatSessionDeps
  private readonly theme: Theme
  private engineSession: EngineSession | null = null
  private editor: EditorState
  private viewState: ChatViewState
  private pollTimer: NodeJS.Timeout | null = null
  private resolveExit: ((code: number) => void) | null = null
  private activeTurnPromise: Promise<void> | null = null
  private sigintExitPending = false
  private sigintTimer: NodeJS.Timeout | null = null
  private transcriptLines: string[] = []
  private inFlightTools: Map<string, ToolActivityState> = new Map()
  /** Canonical pending approval inbox, upserted by stable backend id. */
  private approvalInbox: Map<string, ApprovalViewData> = new Map()
  /** Engine-level permission requests already surfaced (deduped by request id). */
  private seenEngineRequests: Set<string> = new Set()
  /** Last observed state per run id: run transitions emit exactly one notice. */
  private lastRunStates: Map<string, string> = new Map()
  /** Milestone event sequences already surfaced as transcript notices (deduped). */
  private seenMilestoneSeqs: Set<number> = new Set()
  /** Read-only approval details overlay; never approves. */
  private detailsOpen = false

  constructor(deps: ChatSessionDeps) {
    this.deps = deps
    this.theme = createTheme()
    this.editor = initialEditor()
    this.viewState = initialViewState()
  }

  async start(): Promise<void> {
    const engineSession = await this.deps.adapter.startSession({
      muse: {
        id: this.deps.muse.id,
        slug: this.deps.muse.slug,
        role: this.deps.muse.role,
        model: this.deps.muse.model,
      },
      workdir: this.deps.rootDir,
      env: {},
      configDir: this.deps.muse.engineHome,
      instructions: this.deps.instructions ?? operatorPreamble(this.deps.muse),
      resumeToken: this.deps.resumeToken ?? undefined,
      mcpServers: this.deps.mcpServers,
    })
    this.engineSession = engineSession

    this.deps.store.updateChatSession(this.deps.session.id, {
      engineSessionId: engineSession.info.id,
      nativeSessionId: engineSession.info.nativeSessionId,
      resumeToken: engineSession.info.resumeToken,
    })

    const storedMessages = this.deps.store.listChatMessages(this.deps.session.id)
    const isResumed = storedMessages.length > 0

    const projectName = this.deps.store.getProject(this.deps.projectId)?.name ?? this.deps.projectId
    const header = renderHeader(
      {
        projectName,
        rootDir: this.deps.rootDir,
        museSlug: this.deps.muse.slug,
        engine: this.deps.adapter.kind,
        model: this.deps.muse.model,
        mode: 'container',
        sessionId: this.deps.session.id,
        resumed: isResumed,
        messageCount: storedMessages.length,
      },
      this.theme,
    )

    this.commitLine(header)

    if (this.deps.initialNotices) {
      for (const n of this.deps.initialNotices) {
        this.commitLine(renderNotice(n, this.deps.io.size().columns, this.theme))
      }
    }

    if (isResumed) {
      for (const msg of storedMessages) {
        if (msg.role === 'user') {
          this.commitLine(this.theme.paint('user', `> ${msg.text}`))
        } else if (msg.role === 'assistant') {
          const rendered = renderMarkdown(msg.text, this.deps.io.size().columns, this.theme)
          for (const l of rendered) {
            this.commitLine(l)
          }
        } else {
          this.commitLine(this.theme.paint('dim', msg.text))
        }
      }
    }

    this.deps.io.start()
    this.scheduleRedraw()
  }

  get museModel(): string {
    return this.deps.muse.model
  }

  async switchModel(newModel: string): Promise<void> {
    if (this.engineSession) {
      await this.engineSession.close()
    }
    this.deps.muse.model = newModel
    const nextEngineSession = await this.deps.adapter.startSession({
      muse: {
        id: this.deps.muse.id,
        slug: this.deps.muse.slug,
        role: this.deps.muse.role,
        model: newModel,
      },
      workdir: this.deps.rootDir,
      env: {},
      configDir: this.deps.muse.engineHome,
      instructions: this.deps.instructions ?? operatorPreamble(this.deps.muse),
      resumeToken: undefined,
      mcpServers: this.deps.mcpServers,
    })
    this.engineSession = nextEngineSession
    this.deps.store.updateChatSession(this.deps.session.id, {
      engineSessionId: nextEngineSession.info.id,
      nativeSessionId: nextEngineSession.info.nativeSessionId,
      resumeToken: nextEngineSession.info.resumeToken,
    })
    this.scheduleRedraw()
  }

  async run(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.resolveExit = resolve

      this.deps.io.onResize(() => {
        this.scheduleRedraw()
      })

      this.deps.io.onKey((input, key) => {
        const act = keyAction(input, key, {
          approvalPending: this.approvalInbox.size > 0,
          draftEmpty: this.editor.text.trim().length === 0,
        })
        this.handleAction(act)
      })

      if (this.deps.poll) {
        const intervalMs = this.deps.pollIntervalMs ?? 1500
        this.pollTimer = setInterval(() => {
          void this.runPollTick()
        }, intervalMs)
      }

      this.scheduleRedraw()
    })
  }

  private async handleAction(act: ReturnType<typeof keyAction>): Promise<void> {
    switch (act.action) {
      case 'insert':
        if (act.text) {
          this.editor = editorInsert(this.editor, act.text)
          this.scheduleRedraw()
        }
        break

      case 'backspace':
        this.editor = editorBackspace(this.editor)
        this.scheduleRedraw()
        break

      case 'delete':
        this.editor = editorDelete(this.editor)
        this.scheduleRedraw()
        break

      case 'cursor-left':
        this.editor = editorMove(this.editor, 'left')
        this.scheduleRedraw()
        break

      case 'cursor-right':
        this.editor = editorMove(this.editor, 'right')
        this.scheduleRedraw()
        break

      case 'home':
        this.editor = editorMove(this.editor, 'home')
        this.scheduleRedraw()
        break

      case 'end':
        this.editor = editorMove(this.editor, 'end')
        this.scheduleRedraw()
        break

      case 'kill-to-end':
        this.editor = editorKill(this.editor, 'toEnd')
        this.scheduleRedraw()
        break

      case 'kill-to-start':
        this.editor = editorKill(this.editor, 'toStart')
        this.scheduleRedraw()
        break

      case 'kill-word':
        this.editor = editorKill(this.editor, 'word')
        this.scheduleRedraw()
        break

      case 'history-prev':
        this.editor = editorHistory(this.editor, 'prev')
        this.scheduleRedraw()
        break

      case 'history-next':
        this.editor = editorHistory(this.editor, 'next')
        this.scheduleRedraw()
        break

      case 'newline':
        this.editor = editorInsert(this.editor, '\n')
        this.scheduleRedraw()
        break

      case 'clear-input':
        if (this.editor.text.length > 0) {
          this.editor = { ...this.editor, text: '', cursor: 0, pastes: [] }
          this.sigintExitPending = false
          this.scheduleRedraw()
        } else if (this.viewState.busy) {
          void this.engineSession?.interrupt()
          this.sigintExitPending = false
        } else {
          if (this.sigintExitPending) {
            void this.exit(0)
          } else {
            this.sigintExitPending = true
            this.commitLine(this.theme.paint('dim', 'Press Ctrl+C again to exit'))
            if (this.sigintTimer !== null) clearTimeout(this.sigintTimer)
            this.sigintTimer = setTimeout(() => {
              this.sigintExitPending = false
            }, 2000)
            this.scheduleRedraw()
          }
        }
        break

      case 'toggle-tools':
        this.sigintExitPending = false
        this.viewState = { ...this.viewState, toolExpanded: !this.viewState.toolExpanded }
        this.scheduleRedraw()
        break

      case 'toggle-inspector':
        this.sigintExitPending = false
        this.viewState = { ...this.viewState, inspectorOpen: !this.viewState.inspectorOpen }
        this.scheduleRedraw()
        break

      case 'scroll-up':
        this.viewState = { ...this.viewState, scrollOffset: this.viewState.scrollOffset + 5 }
        this.scheduleRedraw()
        break

      case 'scroll-down':
        this.viewState = {
          ...this.viewState,
          scrollOffset: Math.max(0, this.viewState.scrollOffset - 5),
        }
        this.scheduleRedraw()
        break

      case 'palette':
      case 'help': {
        const ctx = this.getSlashContext()
        this.commitLine(ctx.help())
        this.scheduleRedraw()
        break
      }

      case 'approve': {
        const firstApproval = this.firstInboxApproval()
        if (firstApproval) {
          const ctx = this.getSlashContext()
          try {
            const res = await ctx.approve(firstApproval.id)
            this.reconcileApproval(firstApproval.id)
            this.commitLine(
              this.theme.paint('success', res),
            )
          } catch (err: unknown) {
            // Backend refused (expired, already decided, unknown ref): keep the
            // card and show the authoritative error. Never assume success.
            const msg = err instanceof Error ? err.message : String(err)
            this.commitLine(this.theme.paint('error', `approval not applied: ${msg}`))
            this.reconcileApproval(firstApproval.id)
          }
          this.scheduleRedraw()
        }
        break
      }

      case 'deny': {
        const firstApproval = this.firstInboxApproval()
        if (firstApproval) {
          const ctx = this.getSlashContext()
          try {
            const res = await ctx.deny(firstApproval.id)
            this.reconcileApproval(firstApproval.id)
            this.commitLine(
              this.theme.paint('warn', res),
            )
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            this.commitLine(this.theme.paint('error', `denial not applied: ${msg}`))
            this.reconcileApproval(firstApproval.id)
          }
          this.scheduleRedraw()
        }
        break
      }

      case 'view-details': {
        if (this.firstInboxApproval()) {
          // Read-only overlay: opening details never approves or denies.
          this.detailsOpen = true
          this.scheduleRedraw()
        }
        break
      }

      case 'redraw':
        this.scheduleRedraw()
        break

      case 'interrupt':
        this.sigintExitPending = false
        if (this.detailsOpen) {
          // Esc dismisses the topmost overlay first.
          this.detailsOpen = false
          this.scheduleRedraw()
        } else if (this.viewState.busy) {
          void this.engineSession?.interrupt()
        }
        break

      case 'exit':
        if (this.editor.text.length === 0) {
          void this.exit(0)
        } else {
          this.editor = editorDelete(this.editor)
          this.scheduleRedraw()
        }
        break

      case 'send': {
        const fullText = expandPastes(this.editor).trim()
        if (!fullText) return

        this.editor = {
          ...this.editor,
          history: [...this.editor.history, fullText],
          historyIndex: null,
          text: '',
          cursor: 0,
          pastes: [],
        }

        if (fullText.startsWith('/')) {
          const ctx = this.getSlashContext()
          try {
            const slashRes = await executeSlash(ctx, fullText)
            if (slashRes !== null) {
              this.commitLine(this.theme.paint('dim', slashRes.output))
              if (slashRes.exit) {
                void this.exit(0)
                return
              }
              if (slashRes.newSession) {
                await this.handleNewSession()
                return
              }
              return
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            this.commitLine(this.theme.paint('error', msg))
            return
          }
        }

        if (this.viewState.busy) {
          this.viewState.queue.push(fullText)
          this.commitLine(this.theme.paint('dim', `queued: ${fullText}`))
          return
        }

        this.activeTurnPromise = this.dispatchTurn(fullText)
        break
      }

      case 'ignore':
        break
    }
  }

  private getSlashContext(): SlashContext {
    if (this.deps.slashContext) return this.deps.slashContext
    return {
      session: { id: this.deps.session.id },
      muse: { id: this.deps.muse.id, slug: this.deps.muse.slug },
      status: async () => 'Status not configured',
      runs: async () => 'No runs',
      approvalsList: async () => 'No approvals',
      approve: async () => 'Approve not configured',
      deny: async () => 'Deny not configured',
      startRun: async () => 'Start run not configured',
      newSession: async () => 'New session not configured',
      help: () => defaultSlashHelp(),
    }
  }

  private async handleNewSession(): Promise<void> {
    try {
      await this.engineSession?.close()
    } catch {
      // best-effort
    }

    const activeSessionId = this.deps.slashContext?.session.id ?? this.deps.session.id
    let newSession = this.deps.store.getChatSession(activeSessionId)
    if (newSession.state === 'closed') {
      newSession = this.deps.store.createChatSession({
        projectId: this.deps.projectId,
        museId: this.deps.muse.id,
      })
      if (this.deps.slashContext) {
        this.deps.slashContext.session.id = newSession.id
      }
    }
    this.deps.session = newSession

    const engineSession = await this.deps.adapter.startSession({
      muse: {
        id: this.deps.muse.id,
        slug: this.deps.muse.slug,
        role: this.deps.muse.role,
        model: this.deps.muse.model,
      },
      workdir: this.deps.rootDir,
      env: {},
      configDir: this.deps.muse.engineHome,
      instructions: this.deps.instructions ?? operatorPreamble(this.deps.muse),
      mcpServers: this.deps.mcpServers,
    })
    this.engineSession = engineSession
    this.deps.store.updateChatSession(newSession.id, {
      engineSessionId: engineSession.info.id,
      nativeSessionId: engineSession.info.nativeSessionId,
      resumeToken: engineSession.info.resumeToken,
    })

    const projectName = this.deps.store.getProject(this.deps.projectId)?.name ?? this.deps.projectId
    const header = renderHeader(
      {
        projectName,
        rootDir: this.deps.rootDir,
        museSlug: this.deps.muse.slug,
        engine: this.deps.adapter.kind,
        model: this.deps.muse.model,
        mode: 'container',
        sessionId: newSession.id,
        resumed: false,
        messageCount: 0,
      },
      this.theme,
    )
    this.commitLine(header)
    this.scheduleRedraw()
  }

  private async dispatchTurn(userText: string): Promise<void> {
    this.viewState = beginTurn(this.viewState, userText)
    if (this.transcriptLines.length > 0) this.transcriptLines.push('')
    this.transcriptLines.push(this.theme.paint('focus', 'You'))
    this.commitLine(userText)
    this.deps.store.appendChatMessage({
      sessionId: this.deps.session.id,
      role: 'user',
      text: userText,
    })
    this.scheduleRedraw()

    let outcome: string = 'success'
    let interrupted = false
    let failed = false

    try {
      for await (const ev of this.engineSession!.sendPrompt({ text: userText })) {
        this.viewState = applyEngineEvent(this.viewState, ev)

        if (ev.kind === 'tool') {
          const toolId = ev.callId ?? `${ev.name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
          let act = this.inFlightTools.get(toolId)
          if (!act) {
            act = createToolActivity({
              id: toolId,
              name: ev.name,
              summary: ev.summary,
              input: ev.input,
            })
          }
          if (ev.phase === 'start') {
            this.inFlightTools.set(toolId, act)
            // inFlightTools handles live viewport rendering during execution
          } else {
            const finishedAct = updateToolActivity(act, {
              status: ev.isError ? 'failed' : 'succeeded',
              summary: ev.summary ?? act.summary,
              output: ev.output ?? ev.summary,
            })
            this.inFlightTools.delete(toolId)
            const lines = renderToolActivity(
              finishedAct,
              this.viewState.toolExpanded,
              this.deps.io.size().columns,
              this.theme,
            )
            for (const line of lines) {
              this.commitLine(line)
            }
          }
        } else if (ev.kind === 'approval_request') {
          // Engine-level permission requests have no interactive approval channel
          // in this build: adapters auto-deny fail-closed. Surface one honest,
          // non-actionable notice — never a fake approve/deny card.
          if (!this.seenEngineRequests.has(ev.requestId)) {
            this.seenEngineRequests.add(ev.requestId)
            const noticeLines = renderEngineRequestNotice(
              ev.requestId,
              ev.description,
              this.deps.io.size().columns,
              this.theme,
            )
            for (const line of noticeLines) {
              this.commitLine(line)
            }
          }
        } else if (ev.kind === 'error') {
          failed = true
          this.commitLine(this.theme.paint('error', `${ev.code}: ${ev.message}`))
        } else if (ev.kind === 'result') {
          outcome = ev.outcome
          if (ev.outcome === 'cancelled') interrupted = true
          if (ev.outcome === 'failure') failed = true
        }

        this.scheduleRedraw()
      }
    } catch (err: unknown) {
      failed = true
      const msg = err instanceof Error ? err.message : String(err)
      this.commitLine(this.theme.paint('error', msg))
    }

    const endRes = endTurn(this.viewState, { interrupted, failed })
    this.viewState = endRes.state

    if (endRes.assistantText) {
      if (this.transcriptLines.length > 0) this.transcriptLines.push('')
      this.transcriptLines.push(this.theme.paint('header', 'PLUTON'))
      const renderedMd = renderMarkdown(
        endRes.assistantText,
        this.deps.io.size().columns,
        this.theme,
      )
      for (const line of renderedMd) {
        this.commitLine(line)
      }
      if (interrupted) {
        this.commitLine(this.theme.paint('warn', '[interrupted]'))
      }
      this.deps.store.appendChatMessage({
        sessionId: this.deps.session.id,
        role: 'assistant',
        text: endRes.assistantText,
        meta: { interrupted, outcome },
      })
    }

    this.scheduleRedraw()

    // Drain queue
    if (this.viewState.queue.length > 0) {
      const nextPrompt = this.viewState.queue.shift()!
      this.activeTurnPromise = this.dispatchTurn(nextPrompt)
    }
  }

  private async runPollTick(): Promise<void> {
    if (!this.deps.poll) return
    try {
      const res = await this.deps.poll()
      const { columns } = this.deps.io.size()

      // Lifecycle events feed the Orchestra inspector only. They are never
      // interleaved into the conversation transcript as raw lines.
      if (res.events && res.events.length > 0) {
        this.viewState = {
          ...this.viewState,
          orchestra: {
            ...this.viewState.orchestra,
            events: res.events.map((e) => ({
              seq: e.seq,
              type: e.type,
              summary: e.line,
            })),
          },
        }

        // Meaningful milestone events (task started/completed/failed, verification passed/failed)
        // emit clean, deduped notices into the transcript.
        const milestoneTypes = /^(task\.(started|completed|failed)|verification\.(passed|failed))/
        for (const e of res.events) {
          if (milestoneTypes.test(e.type) && !this.seenMilestoneSeqs.has(e.seq)) {
            this.seenMilestoneSeqs.add(e.seq)
            this.commitLine(renderNotice(e.line, columns, this.theme))
          }
        }
      }

      // Canonical approvals: upsert by stable id so replay/duplicate delivery
      // cannot duplicate the card; drop it only when the authoritative backend
      // record is no longer pending (confirmed decision or expiry).
      if (res.approvals) {
        const present = new Set(res.approvals.map((a) => a.id))
        for (const a of res.approvals) {
          this.approvalInbox.set(a.id, a)
        }
        for (const id of [...this.approvalInbox.keys()]) {
          if (!present.has(id)) {
            const record = this.deps.store.getApprovalOrNull(id)
            if (!record || record.status !== 'pending') {
              this.approvalInbox.delete(id)
            }
          }
        }
      }

      // Run state: exactly one compact system line per transition.
      if (res.run) {
        const prev = this.lastRunStates.get(res.run.id)
        if (prev !== res.run.state) {
          this.lastRunStates.set(res.run.id, res.run.state)
          this.commitLine(
            renderNotice(`run ${res.run.id} → ${res.run.state}`, columns, this.theme),
          )
        }
      }

      if (res.notices && res.notices.length > 0) {
        for (const n of res.notices) {
          this.commitLine(renderNotice(n, columns, this.theme))
        }
      }

      this.viewState = {
        ...this.viewState,
        run: res.run,
        approvalsPending: this.approvalInbox.size,
      }
      this.scheduleRedraw()
    } catch {
      // Ignore background poll errors
    }
  }

  private reconcileApproval(id: string): void {
    const record = this.deps.store.getApprovalOrNull(id)
    if (!record || record.status !== 'pending') {
      this.approvalInbox.delete(id)
      return
    }
    this.approvalInbox.set(id, approvalRecordToView(record))
  }

  private clearLive(): void {
    // Retained for API compatibility; full-screen frames manage viewport atomically
  }

  commitLine(text: string): void {
    const parts = text.split('\n')
    for (const p of parts) {
      this.transcriptLines.push(p)
    }
    this.deps.io.commit(text)
    this.scheduleRedraw()
  }

  private scheduleRedraw(): void {
    const frame = this.renderFrame()
    this.deps.io.redraw(frame)
  }

  private buildOrchestraData(): OrchestraInspectorData {
    const musesList = this.deps.store.listMuses().filter((m) => m.projectId === this.deps.projectId && m.enabled)
    const tasks: TaskInspectorItem[] = []
    const museActiveTasks = new Map<string, TaskRecord[]>()

    if (this.viewState.run?.id) {
      try {
        const runTasks = this.deps.store.listTasks(this.viewState.run.id)
        const edges = this.deps.store.listEdges(this.viewState.run.id)
        const depMap = new Map<string, string[]>()
        for (const e of edges) {
          const list = depMap.get(e.fromTaskId) ?? []
          list.push(e.toTaskId)
          depMap.set(e.fromTaskId, list)
        }

        for (const t of runTasks) {
          if (t.assigneeMuseId) {
            const list = museActiveTasks.get(t.assigneeMuseId) ?? []
            list.push(t)
            museActiveTasks.set(t.assigneeMuseId, list)
          }

          let taskState: TaskInspectorItem['state'] = 'pending'
          if (t.state === 'running' || t.state === 'verifying') taskState = 'running'
          else if (t.state === 'completed') taskState = 'completed'
          else if (t.state === 'failed' || t.state === 'cancelled') taskState = 'failed'
          else if (
            t.state === 'needs_approval' ||
            t.state === 'needs_input' ||
            t.state === 'interrupted' ||
            t.state === 'unknown_outcome'
          ) {
            taskState = 'blocked'
          }

          let ownerSlug: string | undefined
          if (t.assigneeMuseId) {
            const assignee = musesList.find((m) => m.id === t.assigneeMuseId)
            ownerSlug = assignee?.slug
          }

          let verificationSummary: string | undefined
          if (t.result && typeof t.result === 'object' && 'verificationSummary' in t.result) {
            verificationSummary = String((t.result as Record<string, unknown>)['verificationSummary'])
          }

          tasks.push({
            id: t.id,
            title: t.title,
            state: taskState,
            ownerMuseSlug: ownerSlug,
            dependencies: depMap.get(t.id),
            writeScope: t.writeScope,
            retries: t.attempt > 0 ? t.attempt : undefined,
            verificationSummary,
          })
        }
      } catch {
        // ignore if tasks cannot be read
      }
    }

    const muses: MuseInspectorItem[] = musesList.map((m) => {
      let state: MuseInspectorItem['state'] = 'idle'
      if (this.viewState.busy && m.id === this.deps.muse.id) {
        state = 'working'
      } else {
        const assigned = museActiveTasks.get(m.id)
        if (assigned && assigned.length > 0) {
          if (assigned.some((t) => t.state === 'running' || t.state === 'verifying')) {
            state = 'working'
          } else if (assigned.some((t) => t.state === 'needs_approval' || t.state === 'needs_input')) {
            state = 'waiting'
          } else if (assigned.some((t) => t.state === 'failed')) {
            state = 'failed'
          } else if (assigned.every((t) => t.state === 'completed')) {
            state = 'done'
          }
        }
      }
      return {
        id: m.id,
        slug: m.slug,
        role: m.role,
        engine: m.engineKind,
        model: m.model,
        state,
      }
    })

    const pendingApprovals = this.deps.store.listApprovalsByProject(this.deps.projectId, {
      status: 'pending',
      limit: 10,
    })
    const approvals = pendingApprovals.map((a) => ({
      id: a.id,
      action: a.action,
      reason: a.reason,
    }))

    const events: EventInspectorItem[] = (this.viewState.orchestra.events ?? []).map((e) => ({
      seq: e.seq,
      type: e.type,
      summary: e.summary,
    }))

    let usage: OrchestraInspectorData['usage'] = undefined
    if (this.viewState.run?.id) {
      const u = this.deps.store.getRunUsage(this.viewState.run.id)
      if (u.totalInputTokens > 0 || u.totalOutputTokens > 0) {
        usage = {
          totalInputTokens: u.totalInputTokens,
          totalOutputTokens: u.totalOutputTokens,
          totalCostUsd: u.totalCostUsd,
        }
      }
    }

    return {
      muses,
      tasks,
      approvals,
      events,
      usage,
    }
  }

  /** First pending approval in the inbox (stable order by insertion). */
  private firstInboxApproval(): ApprovalViewData | null {
    for (const a of this.approvalInbox.values()) return a
    return null
  }

  private renderFrame(): { lines: string[]; cursor: { row: number; col: number } } {
    const { columns, rows } = this.deps.io.size()
    const projectName = this.deps.store.getProject(this.deps.projectId)?.name ?? this.deps.projectId

    const statusView: StatusView = {
      museSlug: this.deps.muse.slug,
      engine: this.deps.adapter.kind,
      model: this.deps.muse.model,
      busy: this.viewState.busy,
      run: this.viewState.run,
      approvalsPending: this.approvalInbox.size,
      usage: this.viewState.usage,
    }

    const header = {
      projectName,
      rootDir: this.deps.rootDir,
      museSlug: this.deps.muse.slug,
      engine: this.deps.adapter.kind,
      model: this.deps.muse.model,
      runState: this.viewState.run ? `run:${this.viewState.run.id} (${this.viewState.run.state})` : undefined,
    }

    // Build active transcript including live streaming Markdown and in-flight tools
    const activeTranscript = [...this.transcriptLines]
    for (const act of this.inFlightTools.values()) {
      const lines = renderToolActivity(
        act,
        this.viewState.toolExpanded,
        Math.max(20, columns - 4),
        this.theme,
      )
      activeTranscript.push(...lines)
    }
    if (this.viewState.live) {
      const chatWidth = Math.max(20, Math.round(columns * 0.72))
      activeTranscript.push(this.theme.paint('header', 'PLUTON'))
      const liveMd = renderMarkdown(this.viewState.live + ' ▌', chatWidth, this.theme)
      activeTranscript.push(...liveMd)
    }

    // Slash command autocomplete suggestions
    let autocomplete: Array<{ syntax: string; description: string }> | null = null
    if (this.editor.text.startsWith('/')) {
      const suggestions = getCommandSuggestions(this.editor.text, 5)
      if (suggestions.length > 0) {
        autocomplete = suggestions
      }
    }

    const orchestraData = this.buildOrchestraData()
    const firstApproval = this.firstInboxApproval()

    let contextPct: number | undefined
    if (this.viewState?.usage) {
      const totalTokens = this.viewState.usage.inputTokens + this.viewState.usage.outputTokens
      if (totalTokens > 0) {
        contextPct = Math.min(100, Math.round((totalTokens / 200000) * 100))
      }
    }

    return renderFullScreenFrame({
      header,
      transcriptLines: activeTranscript,
      orchestra: orchestraData,
      editor: {
        text: this.editor.text,
        cursor: this.editor.cursor,
      },
      statusView,
      autocomplete,
      approvalCard: firstApproval,
      approvalDetails: this.detailsOpen ? firstApproval : null,
      placeholder: 'Ask Pluton to plan, implement, investigate…',
      museCount: orchestraData.muses.length,
      scrollOffset: this.viewState.scrollOffset,
      columns,
      rows,
      theme: this.theme,
      inspectorOpen: this.viewState.inspectorOpen,
      brandHeader: true,
      mode: 'chat',
      contextPct,
    })
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.sigintTimer !== null) {
      clearTimeout(this.sigintTimer)
      this.sigintTimer = null
    }
    this.clearLive()
    this.deps.io.stop()
  }

  private async exit(code: number): Promise<void> {
    this.stop()
    try {
      await this.engineSession?.close()
    } catch {
      // best-effort
    }

    if (this.resolveExit) {
      this.resolveExit(code)
      this.resolveExit = null
    }
  }
}
