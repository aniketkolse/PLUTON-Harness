/**
 * Server-Sent Events (SSE) broadcaster for Pluton graphical clients (ADR-0014).
 * Fan-out real-time assistant tokens, tool events, task progress, and approval notices.
 */

import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { JsonValue } from '../domain/models.ts'
import type { Store } from '../store/store.ts'
import { redactDeep } from '../util/redact.ts'
import { stripControlChars, stripControlDeep } from '../util/sanitize.ts'
import type { ServerSSEEvent, WorkerSSEEvent } from './types.ts'

const MAX_PAYLOAD_STRING_CHARS = 4000
const MAX_PAYLOAD_JSON_CHARS = 7000

function boundPayloadValue(v: JsonValue, maxStrLen = MAX_PAYLOAD_STRING_CHARS): JsonValue {
  if (typeof v === 'string') {
    if (v.length > maxStrLen) {
      return `${v.slice(0, maxStrLen)}… [truncated ${v.length - maxStrLen} chars]`
    }
    return v
  }
  if (Array.isArray(v)) {
    const capped = v.slice(0, 50)
    return capped.map((item) => boundPayloadValue(item as JsonValue, maxStrLen))
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, val] of Object.entries(v)) {
      out[key] = boundPayloadValue(val as JsonValue, maxStrLen)
    }
    return out
  }
  return v
}

function sanitizeWorkerPayload(raw?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined
  let cleaned = redactDeep(raw as JsonValue)
  cleaned = stripControlDeep(cleaned)
  cleaned = boundPayloadValue(cleaned, MAX_PAYLOAD_STRING_CHARS)
  let json = JSON.stringify(cleaned)
  if (json.length > MAX_PAYLOAD_JSON_CHARS) {
    cleaned = boundPayloadValue(cleaned, 500)
    json = JSON.stringify(cleaned)
    if (json.length > MAX_PAYLOAD_JSON_CHARS) {
      cleaned = {
        _truncated: true,
        summary: '[Payload truncated: size exceeded limit]',
      }
    }
  }
  return cleaned as Record<string, unknown>
}

export class ServerEventBroadcaster extends EventEmitter {
  private readonly clients = new Set<ServerResponse>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private store?: Store
  private projectId?: string

  constructor(
    pingIntervalMs = 15000,
    storeOrOpts?: Store | { store?: Store; projectId?: string },
    projectId?: string,
  ) {
    super()
    if (storeOrOpts && typeof (storeOrOpts as any).appendEvent === 'function') {
      this.store = storeOrOpts as Store
      this.projectId = projectId
    } else if (storeOrOpts && typeof storeOrOpts === 'object') {
      this.store = (storeOrOpts as any).store
      this.projectId = (storeOrOpts as any).projectId ?? projectId
    }
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        this.broadcast({ type: 'heartbeat', timestamp: Date.now() })
      }, pingIntervalMs)
      // Unref timer so it does not keep Node process alive
      this.pingTimer.unref()
    }
  }

  setStoreContext(store: Store, projectId?: string): void {
    this.store = store
    if (projectId) this.projectId = projectId
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    })

    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`)
    this.clients.add(res)

    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res)
    if (!res.writableEnded) {
      res.end()
    }
  }

  broadcast(event: ServerSSEEvent): void {
    this.emit('event', event)
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(data)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  broadcastWorkerEvent(event: WorkerSSEEvent, store?: Store, projectId?: string): void {
    const timestamp = event.timestamp ?? Date.now()
    const sanitizedPayload = sanitizeWorkerPayload(event.payload)
    const finalEvent: WorkerSSEEvent = {
      type: event.type,
      runId: event.runId,
      taskId: event.taskId,
      role: typeof event.role === 'string' ? stripControlChars(event.role) : event.role,
      ...(event.model !== undefined ? { model: stripControlChars(event.model) } : {}),
      ...(event.workspace !== undefined ? { workspace: stripControlChars(event.workspace) } : {}),
      ...(sanitizedPayload !== undefined ? { payload: sanitizedPayload } : {}),
      timestamp,
    }

    const effectiveStore = store ?? this.store
    let effectiveProjectId = projectId ?? this.projectId
    if (!effectiveProjectId && effectiveStore && typeof (effectiveStore as any).getRunOrNull === 'function') {
      try {
        const run = (effectiveStore as any).getRunOrNull(finalEvent.runId)
        if (run?.projectId) {
          effectiveProjectId = run.projectId
        }
      } catch {
        // ignore
      }
    }
    if (!effectiveProjectId) {
      effectiveProjectId = 'default'
    }

    if (effectiveStore && typeof effectiveStore.appendEvent === 'function') {
      try {
        effectiveStore.appendEvent({
          projectId: effectiveProjectId,
          runId: finalEvent.runId,
          taskId: finalEvent.taskId,
          shipId: finalEvent.role,
          museId: finalEvent.role,
          type: finalEvent.type,
          payload: {
            role: finalEvent.role,
            ...(finalEvent.model !== undefined ? { model: finalEvent.model } : {}),
            ...(finalEvent.workspace !== undefined ? { workspace: finalEvent.workspace } : {}),
            ...(finalEvent.payload !== undefined ? { payload: finalEvent.payload } : {}),
            ...(finalEvent.payload ?? {}),
          } as JsonValue,
        })
      } catch {
        // Best-effort durable persistence; do not drop SSE broadcast on store error
      }
    }

    this.emit('worker_event', finalEvent)
    this.broadcast(finalEvent)
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // Ignore
      }
    }
    this.clients.clear()
    this.removeAllListeners()
  }

  get clientCount(): number {
    return this.clients.size
  }
}
