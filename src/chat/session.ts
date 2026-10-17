/**
 * Interactive chat session loop and event coordinator (ADR-0012).
 * Drives the terminal I/O, editor, streaming assistant turns, tool lines,
 * background run polling, and chat transcript persistence.
 */

import type { EngineAdapter, EngineSession, McpServerSpec } from '../engines/contract/types.ts'
import type { ChatSessionRecord, MuseRecord } from '../domain/models.ts'
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
  renderHeader,
  renderInput,
  renderNotice,
  renderStatusLine,
  renderToolLine,
  type StatusView,
} from '../tui/render.ts'
import { wrapText } from '../tui/width.ts'
import { operatorPreamble } from './prompt.ts'
import { defaultSlashHelp, executeSlash, type SlashContext } from './commands.ts'

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
    notices: string[]
  }>
  pollIntervalMs?: number
  now?: () => number
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

    this.deps.io.commit(header)

    if (isResumed) {
      for (const msg of storedMessages) {
        if (msg.role === 'user') {
          this.deps.io.commit(this.theme.paint('user', `> ${msg.text}`))
        } else if (msg.role === 'assistant') {
          this.deps.io.commit(msg.text)
        } else {
          this.deps.io.commit(this.theme.paint('dim', msg.text))
        }
      }
    }

    this.deps.io.start()
  }

  async run(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.resolveExit = resolve

      this.deps.io.onResize(() => {
        this.scheduleRedraw()
      })

      this.deps.io.onKey((input, key) => {
        const act = keyAction(input, key)
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
        this.editor = { ...this.editor, text: '', cursor: 0 }
        this.scheduleRedraw()
        break

      case 'toggle-tools':
        this.viewState = { ...this.viewState, toolExpanded: !this.viewState.toolExpanded }
        this.scheduleRedraw()
        break

      case 'redraw':
        this.scheduleRedraw()
        break

      case 'interrupt':
        if (this.viewState.busy) {
          void this.engineSession?.interrupt()
        }
        break

      case 'exit':
        void this.exit(0)
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
    this.commitLine(this.theme.paint('user', `> ${userText}`))
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
          const line = renderToolLine(
            ev,
            { expanded: this.viewState.toolExpanded },
            this.deps.io.size().columns,
            this.theme,
          )
          if (line !== null) {
            this.commitLine(line)
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
      this.commitLine(endRes.assistantText)
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

      if (res.events && res.events.length > 0) {
        for (const ev of res.events.slice(0, 20)) {
          this.commitLine(this.theme.paint('dim', ev.line))
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
        approvalsPending: res.approvalsPending,
      }
      this.scheduleRedraw()
    } catch {
      // Ignore background poll errors
    }
  }

  private clearLive(): void {
    this.deps.io.redraw({ lines: [], cursor: { row: 0, col: 0 } })
  }

  commitLine(text: string): void {
    this.clearLive()
    this.deps.io.commit(text)
  }

  private scheduleRedraw(): void {
    const frame = this.renderFrame()
    this.deps.io.redraw(frame)
  }

  private renderFrame(): { lines: string[]; cursor: { row: number; col: number } } {
    const { columns } = this.deps.io.size()
    const statusView: StatusView = {
      museSlug: this.deps.muse.slug,
      engine: this.deps.adapter.kind,
      model: this.deps.muse.model,
      busy: this.viewState.busy,
      run: this.viewState.run,
      approvalsPending: this.viewState.approvalsPending,
      usage: this.viewState.usage,
    }
    const statusLine = renderStatusLine(statusView, columns, this.theme)
    const lines: string[] = [statusLine]

    if (this.viewState.live) {
      const wrapped = wrapText(this.viewState.live, columns)
      for (const l of wrapped) {
        lines.push(l)
      }
    }

    const inputRender = renderInput(this.editor.text, this.editor.cursor, columns, this.theme, {
      prompt: '> ',
    })

    const inputStartRow = lines.length
    for (const l of inputRender.lines) {
      lines.push(l)
    }

    return {
      lines,
      cursor: {
        row: inputStartRow + inputRender.cursor.row,
        col: inputRender.cursor.col,
      },
    }
  }

  private async exit(code: number): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    this.clearLive()
    try {
      await this.engineSession?.close()
    } catch {
      // best-effort
    }
    this.deps.io.stop()

    if (this.resolveExit) {
      this.resolveExit(code)
      this.resolveExit = null
    }
  }
}
