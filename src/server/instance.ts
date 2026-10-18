/**
 * PLUTON application server instance lifecycle and discovery (ADR-0014).
 * Ensures single-server semantics per workspace and enables clean CLI reuse.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { request } from 'node:http'
import type { HealthResponse, ServerInstanceInfo } from './types.ts'

export function serverRunDir(rootDir: string): string {
  return join(rootDir, '.pluton', 'run')
}

export function serverInstancePath(rootDir: string): string {
  return join(serverRunDir(rootDir), 'server.json')
}

/**
 * Mutual-exclusion claim for the workspace's single server slot (release gate).
 * The instance file alone cannot prevent two simultaneous launches from both
 * passing the reuse check and binding separate ports: claim-then-start makes the
 * "one workspace => one server" invariant deterministic instead of racy.
 */
export function serverClaimPath(rootDir: string): string {
  return join(serverRunDir(rootDir), 'server.claim')
}

export interface ServerClaim {
  pid: number
  startedAt: string
}

export function readServerClaim(rootDir: string): ServerClaim | null {
  try {
    const parsed = JSON.parse(readFileSync(serverClaimPath(rootDir), 'utf8')) as Partial<ServerClaim>
    if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'string') {
      return parsed as ServerClaim
    }
    return null
  } catch {
    return null
  }
}

/** Atomically create the workspace claim. Returns false when another claim exists. */
export function claimServerInstance(rootDir: string): boolean {
  mkdirSync(serverRunDir(rootDir), { recursive: true })
  try {
    const fd = openSync(serverClaimPath(rootDir), 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** Remove the claim file. Only removes our own claim unless `force` is set. */
export function releaseServerClaim(rootDir: string, force = false): void {
  if (!force) {
    const claim = readServerClaim(rootDir)
    if (claim && claim.pid !== process.pid) return
  }
  try {
    unlinkSync(serverClaimPath(rootDir))
  } catch {
    // Ignore cleanup error
  }
}

export function writeServerInstance(rootDir: string, info: ServerInstanceInfo): void {
  const dir = serverRunDir(rootDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(serverInstancePath(rootDir), JSON.stringify(info, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function readServerInstance(rootDir: string): ServerInstanceInfo | null {
  const file = serverInstancePath(rootDir)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ServerInstanceInfo>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.url === 'string' &&
      typeof parsed.rootDir === 'string'
    ) {
      return parsed as ServerInstanceInfo
    }
    return null
  } catch {
    return null
  }
}

export function clearServerInstance(rootDir: string): void {
  const file = serverInstancePath(rootDir)
  if (existsSync(file)) {
    try {
      unlinkSync(file)
    } catch {
      // Ignore cleanup error
    }
  }
}

/** Check if process with given PID is alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Compare two directory paths with platform path semantics.
 * Windows and macOS filesystems are case-insensitive by default, so `y:\Pluton` and
 * `Y:\Pluton` name the same workspace. A byte-wise comparison would reject a healthy
 * server as an unintended service and spawn a duplicate instance (release-gate fix).
 */
export function sameDirPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const na = normalize(resolve(a))
  const nb = normalize(resolve(b))
  if (platform === 'win32' || platform === 'darwin') {
    return na.toLowerCase() === nb.toLowerCase()
  }
  return na === nb
}

/** Check whether a running server instance responds to /api/health with its token. */
export function checkServerHealth(instance: ServerInstanceInfo, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolveResult) => {
    if (!isPidAlive(instance.pid)) {
      return resolveResult(false)
    }

    const req = request(
      {
        hostname: '127.0.0.1',
        port: instance.port,
        path: '/api/health',
        method: 'GET',
        headers: {
          'x-pluton-token': instance.token,
          connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolveResult(false)
          return
        }

        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as Partial<HealthResponse>
            if (parsed.ok === true && typeof parsed.version === 'string') {
              if (parsed.rootDir && instance.rootDir) {
                if (!sameDirPath(parsed.rootDir, instance.rootDir)) {
                  resolveResult(false)
                  return
                }
              }
              resolveResult(true)
              return
            }
            resolveResult(false)
          } catch {
            resolveResult(false)
          }
        })
      },
    )

    req.on('timeout', () => {
      req.destroy()
      resolveResult(false)
    })

    req.on('error', () => {
      resolveResult(false)
    })

    req.end()
  })
}
