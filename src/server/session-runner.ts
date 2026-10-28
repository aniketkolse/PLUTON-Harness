import type { EngineAdapter, EngineSession, McpServerSpec } from '../engines/contract/types.ts'
import { createEngineApprovalChannel, type EnginePermissionChannel } from '../engines/interactive-approval.ts'
import type { ChatSessionRecord, InboxItemRecord, ShipRecord } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import type { ServerEventBroadcaster } from './events.ts'
import type { ServerSSEEvent } from './types.ts'

export interface SessionRunnerOptions {
  store: Store
  broadcaster: ServerEventBroadcaster
  projectId: string
  adapterResolver: (ship: ShipRecord, workspaceRoot: string) => EngineAdapter
  workspaceResolver: (sessionId: string) => string
  mcpServersResolver?: (
    sessionId: string,
    ship: ShipRecord,
    adapter: EngineAdapter,
    workspaceRoot: string,
  ) => Promise<McpServerSpec[]>
  onSessionDropped?: (sessionId: string) => void
  approvalTimeoutMinutes: number
}

export interface ActiveEngineEntry {
  session: EngineSession
  approvals: EnginePermissionChannel
  interrupted?: boolean
}

export class SessionRunner {
  private readonly store: Store
  private readonly broadcaster: ServerEventBroadcaster
  private readonly options: SessionRunnerOptions
  private readonly activeEngineSessions = new Map<string, ActiveEngineEntry>()
  private readonly activeDrains = new Set<string>()

  constructor(options: SessionRunnerOptions) {
    this.options = options
    this.store = options.store
    this.broadcaster = options.broadcaster
    // Recover any orphaned items from previous server process crash
    this.store.recoverStaleInboxItems?.()
  }

  enqueue(sessionId: string, text: string, mode: string = 'chat'): InboxItemRecord {
    const item = this.store.enqueueInboxItem({ sessionId, text, mode })
    void this.wake(sessionId)
    return item
  }

  isBusy(sessionId: string): boolean {
    return this.activeDrains.has(sessionId)
  }

  getQueueLength(sessionId: string): number {
    return this.store.listPendingInbox(sessionId).filter((i) => i.state === 'enqueued').length
  }

  getActiveEntry(sessionId: string): ActiveEngineEntry | undefined {
    return this.activeEngineSessions.get(sessionId)
  }

  hasActiveEngineSession(sessionId: string): boolean {
    return this.activeEngineSessions.has(sessionId)
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeEngineSessions.keys())
  }

  setSession(sessionId: string, entry: ActiveEngineEntry): void {
    this.activeEngineSessions.set(sessionId, entry)
  }

  async dropSession(sessionId: string): Promise<void> {
    const entry = this.activeEngineSessions.get(sessionId)
    if (entry) {
      entry.interrupted = true
      entry.approvals.abort('session dropped')
      try {
        await entry.session.interrupt()
      } catch {}
      try {
        await entry.session.close()
      } catch {}
      this.activeEngineSessions.delete(sessionId)
      this.options.onSessionDropped?.(sessionId)
    }
  }

  async cancel(sessionId: string): Promise<boolean> {
    const entry = this.activeEngineSessions.get(sessionId)
    let cancelledAny = false
    if (entry) {
      entry.interrupted = true
      entry.approvals.abort('turn cancelled by operator')
      try {
        await entry.session.interrupt()
      } catch {}
      cancelledAny = true
    }
    const cancelledQueued = this.store.cancelPendingInbox(sessionId)
    if (cancelledQueued > 0) cancelledAny = true
    return cancelledAny
  }

  async wake(sessionId: string): Promise<void> {
    if (this.activeDrains.has(sessionId)) return
    this.activeDrains.add(sessionId)

    let drainCompleted = false
    try {
      await this.drain(sessionId)
      drainCompleted = true
    } catch (err) {
      // A drain is a background operation kicked off by enqueue(). It must
      // never reject into an unhandled promise or leave the session marked
      // busy forever; report the failure and let the durable inbox row say
      // what happened.
      const message = err instanceof Error ? err.message : String(err)
      this.safeBroadcast({ type: 'token', sessionId, text: `\n[Queue failure: ${message}]` })
      this.safeBroadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
    } finally {
      this.activeDrains.delete(sessionId)
      // Close the enqueue/drain race: a prompt can land after drain() saw an
      // empty queue but before this marker is removed. wake() returns early
      // while a drain is active, so that prompt would otherwise stay
      // 'enqueued' until an unrelated prompt arrived. Re-check durable state
      // (never in-memory state) and start one more drain when needed.
      //
      // Only re-check after a successful drain: if the drain failed (for
      // example the store could not mark the row 'processing'), immediately
      // re-entering would spin forever on the same unreadable row. The row
      // stays 'enqueued' and the next enqueue or operator action retries it.
      if (drainCompleted && this.hasEnqueuedWork(sessionId)) {
        void this.wake(sessionId)
      }
    }
  }

  private hasEnqueuedWork(sessionId: string): boolean {
    try {
      return this.store.listPendingInbox(sessionId).some((item) => item.state === 'enqueued')
    } catch {
      // The store is the source of truth; if it cannot be read, the next
      // enqueue or server restart recovery will surface the problem.
      return false
    }
  }

  private async drain(sessionId: string): Promise<void> {
    const session = this.store.getChatSessionOrNull(sessionId)
    if (!session) {
      try {
        this.store.cancelPendingInbox(sessionId)
      } catch {
        // Best effort: session is gone, clear any orphan inbox entries.
      }
      return
    }

    const ship = this.store.getShip(session.shipId)
    if (!ship) {
      this.safeBroadcast({ type: 'token', sessionId, text: `\n[Error: Ship '${session.shipId}' not found]` })
      this.safeBroadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
      this.store.cancelPendingInbox(sessionId)
      return
    }

    while (true) {
      const pending = this.store.listPendingInbox(sessionId)
      const nextItem = pending.find((i) => i.state === 'enqueued')
      if (!nextItem) break

      // Marking the row 'processing' is the ownership claim. If this write
      // fails, do not process the prompt: leave it enqueued and let wake()
      // report the queue failure. Retrying here would spin on the same row.
      this.store.updateInboxState(nextItem.id, 'processing')
      try {
        await this.executeItem(session, ship, nextItem)
      } catch (err) {
        // executeItem's own finally handles engine failures, but a store or
        // broadcasting failure before/around it would otherwise leave the row
        // in 'processing' until the next server restart. Fail the row now and
        // keep draining the remaining prompts.
        //
        // Never downgrade a row that executeItem already settled: its final
        // state write can commit and a later broadcast can still throw.
        let alreadySettled = false
        try {
          const current = this.store.getInboxItem(nextItem.id)
          if (current && current.state !== 'processing') {
            alreadySettled = true
          } else {
            this.store.updateInboxState(nextItem.id, 'failed')
          }
        } catch {
          // Best effort: the queue loop must survive a failing store.
        }
        if (!alreadySettled) {
          const message = err instanceof Error ? err.message : String(err)
          this.safeBroadcast({ type: 'token', sessionId, text: `\n[Turn failure: ${message}]` })
          this.safeBroadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
        }
      }
    }
  }

  private async executeItem(session: ChatSessionRecord, ship: ShipRecord, item: InboxItemRecord): Promise<void> {
    const sessionId = session.id
    const userText = item.text
    const mode = item.mode

    // Append to chat messages
    this.store.appendChatMessage({
      sessionId,
      role: 'user',
      text: userText,
    })
    this.safeBroadcast({ type: 'turn_start', sessionId, userText, mode })

    const sessionWorkspace = this.options.workspaceResolver(sessionId)
    const adapter = this.options.adapterResolver(ship, sessionWorkspace)

    let entry = this.activeEngineSessions.get(sessionId)
    if (!entry) {
      const approvals = createEngineApprovalChannel({
        store: this.store,
        projectId: this.options.projectId,
        runId: null,
        taskId: null,
        shipId: ship.id,
        ttlMinutes: this.options.approvalTimeoutMinutes,
        onRequested: (approval) => {
          this.safeBroadcast({ type: 'approval_requested', approval })
        },
        onSettled: (approval, settlement) => {
          if (settlement !== 'decision') {
            this.safeBroadcast({ type: 'approval_decided', approval })
          }
        },
      })

      let engineSession: EngineSession
      try {
        const mcpServers = this.options.mcpServersResolver
          ? await this.options.mcpServersResolver(sessionId, ship, adapter, sessionWorkspace)
          : []

        engineSession = await adapter.startSession({
          ship: {
            id: ship.id,
            slug: ship.slug,
            role: ship.role,
            model: ship.model,
          },
          workdir: sessionWorkspace,
          env: {},
          configDir: ship.engineHome,
          instructions: `You are ${ship.displayName}, working inside ${sessionWorkspace}. Assist the user directly with code and tasks.`,
          approvals,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
        })
      } catch (err) {
        this.options.onSessionDropped?.(sessionId)
        const message = err instanceof Error ? err.message : String(err)
        this.safeBroadcast({ type: 'token', sessionId, text: `\n[Error: ${message}]` })
        this.safeBroadcast({ type: 'turn_end', sessionId, interrupted: false, failed: true })
        this.store.updateInboxState(item.id, 'failed')
        approvals.abort('engine session failed to start')
        return
      }

      entry = { session: engineSession, approvals, interrupted: false }
      this.activeEngineSessions.set(sessionId, entry)
    }

    entry.interrupted = false
    let assistantText = ''
    let thoughtText = ''
    let failed = false

    try {
      const promptPayload =
        mode === 'plan'
          ? `[PLAN MODE] Please formulate a detailed architectural and implementation plan for the following goal without making workspace edits:\n\n${userText}`
          : userText

      for await (const ev of entry.session.sendPrompt({ text: promptPayload })) {
        if (entry.interrupted) {
          break
        }
        switch (ev.kind) {
          case 'text':
            assistantText += ev.text
            this.safeBroadcast({ type: 'token', sessionId, text: ev.text })
            break
          case 'thought':
            thoughtText += ev.text
            this.safeBroadcast({ type: 'thought', sessionId, text: ev.text })
            break
          case 'tool':
            this.safeBroadcast({
              type: 'tool',
              sessionId,
              tool: {
                id: ev.callId ?? ev.name,
                name: ev.name,
                summary: ev.summary ?? '',
                status: ev.phase === 'start' ? 'running' : ev.isError ? 'failed' : 'succeeded',
                input: ev.input,
                output: ev.output,
              },
            })
            break
          case 'usage':
            this.safeBroadcast({
              type: 'usage',
              sessionId,
              inputTokens: ev.inputTokens ?? 0,
              outputTokens: ev.outputTokens ?? 0,
              costUsd: ev.costUsd ?? null,
            })
            break
          case 'error':
            failed = true
            this.safeBroadcast({ type: 'token', sessionId, text: `\n[Error: ${ev.message}]` })
            break
        }
      }
    } catch (err) {
      failed = true
      const errMsg = err instanceof Error ? err.message : String(err)
      this.safeBroadcast({ type: 'token', sessionId, text: `\n[Engine failure: ${errMsg}]` })
    } finally {
      const persistedText =
        thoughtText.trim().length > 0
          ? `<think>\n${thoughtText.trim()}\n</think>${assistantText.trim().length > 0 ? `\n\n${assistantText.trim()}` : ''}`
          : assistantText
      if (persistedText.trim().length > 0) {
        this.store.appendChatMessage({
          sessionId,
          role: 'assistant',
          text: persistedText,
        })
      }
      const wasInterrupted = (entry as { interrupted?: boolean }).interrupted === true
      if (wasInterrupted) {
        this.store.updateInboxState(item.id, 'cancelled')
      } else if (failed) {
        this.store.updateInboxState(item.id, 'failed')
      } else {
        this.store.updateInboxState(item.id, 'delivered')
      }
      this.safeBroadcast({
        type: 'turn_end',
        sessionId,
        interrupted: wasInterrupted,
        failed: failed && !wasInterrupted,
      })
    }
  }

  private safeBroadcast(event: ServerSSEEvent): void {
    try {
      this.broadcaster.broadcast(event)
    } catch {
      // Best-effort delivery: a broken broadcast subscriber or serialization
      // failure must not crash the drain loop or fail durable state transitions.
    }
  }

  async close(): Promise<void> {
    for (const [, entry] of this.activeEngineSessions) {
      entry.interrupted = true
      entry.approvals.abort('session runner closing')
      try {
        await entry.session.interrupt()
      } catch {}
    }
    this.activeEngineSessions.clear()
    this.activeDrains.clear()
  }
}
