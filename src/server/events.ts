/**
 * Server-Sent Events (SSE) broadcaster for Pluton graphical clients (ADR-0014).
 * Fan-out real-time assistant tokens, tool events, task progress, and approval notices.
 */

import type { ServerResponse } from 'node:http'
import type { ServerSSEEvent } from './types.ts'

export class ServerEventBroadcaster {
  private readonly clients = new Set<ServerResponse>()
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(pingIntervalMs = 15000) {
    if (pingIntervalMs > 0) {
      this.pingTimer = setInterval(() => {
        this.broadcast({ type: 'heartbeat', timestamp: Date.now() })
      }, pingIntervalMs)
      // Unref timer so it does not keep Node process alive
      this.pingTimer.unref()
    }
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
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(data)
      } catch {
        this.clients.delete(client)
      }
    }
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
  }

  get clientCount(): number {
    return this.clients.size
  }
}
