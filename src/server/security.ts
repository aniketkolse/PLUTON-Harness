/**
 * Local application server security gates (ADR-0014).
 * Enforces loopback binding, origin verification, token auth, and path sandboxing.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

/** Cryptographically random 256-bit token for local server authentication. */
export function generateServerToken(): string {
  return randomBytes(32).toString('hex')
}

/** Check if the incoming request originates from a local loopback interface. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (!remote) return false
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote === 'localhost'
  )
}

/** Timing-safe token comparison. */
export function verifyToken(req: IncomingMessage, expectedToken: string): boolean {
  const headerToken = req.headers['x-pluton-token']
  let providedToken: string | undefined

  if (typeof headerToken === 'string') {
    providedToken = headerToken
  } else if (Array.isArray(headerToken) && headerToken.length > 0) {
    providedToken = headerToken[0]
  } else {
    // Check query string
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      providedToken = url.searchParams.get('token') ?? undefined
    } catch {
      providedToken = undefined
    }
  }

  if (!providedToken || typeof providedToken !== 'string') return false
  if (providedToken.length !== expectedToken.length) return false

  try {
    const a = Buffer.from(providedToken, 'utf8')
    const b = Buffer.from(expectedToken, 'utf8')
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Validate Origin and Host headers against DNS rebinding and cross-origin attacks.
 * Rejects requests with unauthorized third-party Origin headers.
 */
export function validateOriginAndHost(req: IncomingMessage, boundPort: number): boolean {
  const origin = req.headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      const allowedHosts = ['127.0.0.1', 'localhost']
      if (!allowedHosts.includes(parsed.hostname)) return false
      if (parsed.port && Number(parsed.port) !== boundPort) return false
    } catch {
      return false
    }
  }

  const host = req.headers.host
  if (host) {
    try {
      const [hostname, port] = host.split(':')
      const allowedHosts = ['127.0.0.1', 'localhost']
      if (hostname && !allowedHosts.includes(hostname)) return false
      if (port && Number(port) !== boundPort) return false
    } catch {
      return false
    }
  }

  return true
}

/**
 * Safely resolve a path relative to rootDir, preventing directory traversal.
 * Returns null if the target escapes rootDir.
 */
export function safeResolvePath(rootDir: string, relativePath: string): string | null {
  const cleanRelative = relativePath.replace(/^[\/\\]+/, '')
  const resolved = resolve(rootDir, cleanRelative)
  const normRoot = normalize(rootDir)
  const normResolved = normalize(resolved)

  // Ensure resolved path starts with rootDir + separator (or equals rootDir)
  if (normResolved === normRoot) return normResolved
  if (normResolved.startsWith(normRoot + sep)) return normResolved
  return null
}
