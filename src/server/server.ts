/**
 * Pluton Local Application Server (ADR-0014).
 * Serves the shared graphical Single-Page Application and provides REST + SSE APIs
 * over a secure loopback connection with cryptographic token auth.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LoadedConfig } from '../config/load.ts'
import type { Store } from '../store/store.ts'
import { InternalError } from '../domain/errors.ts'
import { ServerEventBroadcaster } from './events.ts'
import { clearServerInstance, writeServerInstance } from './instance.ts'
import { ApiRouter } from './routes.ts'
import {
  generateServerToken,
  isLoopbackRequest,
  validateOriginAndHost,
  verifyToken,
} from './security.ts'
import { STATIC_ASSETS } from './static-assets.ts'
import type { ServerInstanceInfo } from './types.ts'

export interface AppServerOptions {
  store: Store
  projectId: string
  loaded: LoadedConfig
  port?: number
  token?: string
}

export interface AppServerInstance {
  server: Server
  port: number
  token: string
  url: string
  info: ServerInstanceInfo
  broadcaster: ServerEventBroadcaster
  router: ApiRouter
  close: () => Promise<void>
}

export async function startAppServer(options: AppServerOptions): Promise<AppServerInstance> {
  const token = options.token ?? generateServerToken()
  const broadcaster = new ServerEventBroadcaster()
  const router = new ApiRouter({
    store: options.store,
    projectId: options.projectId,
    loaded: options.loaded,
    broadcaster,
  })

  let boundPort = options.port ?? 0

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 1. Loopback-only enforcement
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Forbidden: loopback connections only' }))
      return
    }

    // 2. DNS rebinding & Origin validation
    if (!validateOriginAndHost(req, boundPort)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Forbidden: invalid origin or host header' }))
      return
    }

    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`)
    const pathname = parsedUrl.pathname

    // 3. Static Assets (accessible over loopback to load the SPA)
    const assetKey = pathname === '/' ? '/index.html' : pathname
    if (req.method === 'GET' && STATIC_ASSETS[assetKey]) {
      const asset = STATIC_ASSETS[assetKey]!
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': Buffer.byteLength(asset.content, 'utf8'),
        'Cache-Control': 'no-cache',
        // The session token travels in the page URL; never forward it via Referer.
        'Referrer-Policy': 'no-referrer',
      })
      res.end(asset.content)
      return
    }

    // 4. Token validation for all API routes and SSE streams
    if (!verifyToken(req, token)) {
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized: missing or invalid X-Pluton-Token' }))
      return
    }

    // 5. Server-Sent Events stream
    if (req.method === 'GET' && pathname === '/api/events') {
      broadcaster.addClient(res)
      return
    }

    // 6. REST API routes
    const handled = await router.handle(req, res)
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `Route '${pathname}' not found` }))
    }
  })

  // Start listening strictly on 127.0.0.1
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new InternalError(
            `port ${String(boundPort)} on 127.0.0.1 is already in use — stop the process using it, or pick another port with \`pluton --port <number>\``,
            { cause: err, details: { port: boundPort, code: err.code } },
          ),
        )
        return
      }
      if (err.code === 'EACCES') {
        reject(
          new InternalError(
            `permission denied binding 127.0.0.1:${String(boundPort)} — choose a port above 1024 with \`pluton --port <number>\``,
            { cause: err, details: { port: boundPort, code: err.code } },
          ),
        )
        return
      }
      reject(err)
    })
    server.listen(boundPort, '127.0.0.1', () => {
      resolvePromise()
    })
  })

  const address = server.address() as AddressInfo
  boundPort = address.port

  const url = `http://127.0.0.1:${boundPort}/?token=${token}`
  const info: ServerInstanceInfo = {
    pid: process.pid,
    port: boundPort,
    token,
    url,
    rootDir: options.loaded.rootDir,
    startedAt: new Date().toISOString(),
  }

  // Register running instance for discovery
  writeServerInstance(options.loaded.rootDir, info)

  const cleanup = (): void => {
    clearServerInstance(options.loaded.rootDir)
  }

  process.once('exit', cleanup)

  let isClosing = false
  const close = async (): Promise<void> => {
    if (isClosing) return
    isClosing = true
    process.removeListener('exit', cleanup)
    cleanup()
    broadcaster.close()
    await router.close()
    await new Promise<void>((resolveClose) => {
      server.close(() => {
        resolveClose()
      })
    })
  }

  return {
    server,
    port: boundPort,
    token,
    url,
    info,
    broadcaster,
    router,
    close,
  }
}
