/**
 * PLUTON application server instance lifecycle and discovery (ADR-0014).
 * Ensures single-server semantics per workspace and enables clean CLI reuse.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import type { HealthResponse, ServerInstanceInfo } from './types.ts'

export function serverRunDir(rootDir: string): string {
  return join(rootDir, '.pluton', 'run')
}

export function serverInstancePath(rootDir: string): string {
  return join(serverRunDir(rootDir), 'server.json')
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
                if (resolve(parsed.rootDir) !== resolve(instance.rootDir)) {
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
