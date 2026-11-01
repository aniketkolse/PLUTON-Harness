import { newId } from '../domain/ids.ts'

export const DEPENDENCY_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lockb',
  'cargo.toml',
  'cargo.lock',
  'requirements.txt',
  'pipfile',
  'pipfile.lock',
  'pyproject.toml',
  'poetry.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
])

export function normalizeFilePath(raw: string): string {
  let s = raw.replace(/\\/g, '/').trim()
  while (s.startsWith('/')) s = s.slice(1)
  while (s.startsWith('./')) s = s.slice(2)

  const parts = s.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (resolved.length > 0) resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

export function isDependencyOrLockfile(path: string): boolean {
  const norm = normalizeFilePath(path).toLowerCase()
  const base = norm.split('/').pop() ?? norm
  return DEPENDENCY_FILES.has(base)
}

export interface FileLease {
  id: string
  runId: string
  taskId: string
  shipId: string
  path: string
  symbols: string[]
  acquiredAt: string
  /** Last renewal timestamp (ms ISO). Undefined = never renewed; staleness is measured from acquiredAt. */
  renewedAt?: string
  state: 'active' | 'released'
}

export interface LeaseConflict {
  path: string
  heldByTaskId: string
  heldByShipId: string
  reason: string
}

export interface DeclareScopeResult {
  acquired: string[]
  conflicts: LeaseConflict[]
}

export interface LeaseTtlOptions {
  /** Lease time-to-live in seconds; undefined = no expiry (leases held for task lifetime). */
  leaseTtlSeconds?: number
  /** Injectable clock; defaults to Date.now. */
  now?: () => number
}

export class FileLeaseManager {
  private readonly leases = new Map<string, FileLease>()
  private readonly leaseTtlSeconds: number | undefined
  private readonly now: () => number

  constructor(opts: LeaseTtlOptions = {}) {
    this.leaseTtlSeconds = opts.leaseTtlSeconds
    this.now = opts.now ?? Date.now
  }

  normalize(path: string): string {
    return normalizeFilePath(path)
  }

  /**
   * True when two normalized paths overlap: exact match, or one is a directory
   * prefix of the other (`src/auth.ts` overlaps `src/auth/` and vice versa).
   * Prevents a task from silently overwriting another task's nested file.
   */
  pathsOverlap(a: string, b: string): boolean {
    if (a === b) return true
    const aDir = `${a}/`
    const bDir = `${b}/`
    return a.startsWith(bDir) || b.startsWith(aDir)
  }

  hasConflict(
    runId: string,
    taskId: string,
    path: string,
  ): { conflicted: boolean; heldByTaskId?: string; heldByShipId?: string; reason?: string } {
    const norm = this.normalize(path)
    const isDep = isDependencyOrLockfile(norm)

    for (const lease of this.leases.values()) {
      if (lease.runId !== runId || lease.state !== 'active') continue
      if (lease.taskId === taskId) continue // same task already owns it

      // Direct file match or directory-prefix overlap.
      if (this.pathsOverlap(norm, lease.path)) {
        return {
          conflicted: true,
          heldByTaskId: lease.taskId,
          heldByShipId: lease.shipId,
          reason: `file '${norm}' is actively held by task ${lease.taskId} (${lease.shipId})`,
        }
      }

      // Dependency & lockfile cross-conflict.
      if (isDep && isDependencyOrLockfile(lease.path)) {
        return {
          conflicted: true,
          heldByTaskId: lease.taskId,
          heldByShipId: lease.shipId,
          reason: `concurrent dependency-file modification rejected: held by task ${lease.taskId} (${lease.shipId}) on '${lease.path}'`,
        }
      }
    }

    return { conflicted: false }
  }

  declareScope(
    runId: string,
    taskId: string,
    shipId: string,
    paths: string[],
    symbols?: Record<string, string[]>,
  ): DeclareScopeResult {
    const normalizedPaths = paths.map((p) => this.normalize(p)).filter(Boolean)
    const conflicts: LeaseConflict[] = []

    for (const p of normalizedPaths) {
      const check = this.hasConflict(runId, taskId, p)
      if (check.conflicted) {
        conflicts.push({
          path: p,
          heldByTaskId: check.heldByTaskId!,
          heldByShipId: check.heldByShipId!,
          reason: check.reason!,
        })
      }
    }

    if (conflicts.length > 0) {
      return { acquired: [], conflicts }
    }

    const acquired: string[] = []
    const now = this.now()
    const nowIso = new Date(now).toISOString()

    for (const p of normalizedPaths) {
      // Find existing active lease for this task + path
      let existing: FileLease | undefined
      for (const l of this.leases.values()) {
        if (l.runId === runId && l.taskId === taskId && l.path === p && l.state === 'active') {
          existing = l
          break
        }
      }

      const syms = symbols?.[p] ?? []
      if (existing) {
        existing.symbols = Array.from(new Set([...existing.symbols, ...syms]))
        existing.renewedAt = nowIso
        acquired.push(p)
      } else {
        const lease: FileLease = {
          id: newId('attempt'),
          runId,
          taskId,
          shipId,
          path: p,
          symbols: syms,
          acquiredAt: nowIso,
          renewedAt: nowIso,
          state: 'active',
        }
        this.leases.set(lease.id, lease)
        acquired.push(p)
      }
    }

    return { acquired, conflicts: [] }
  }

  /**
   * Renew all active leases for a task (called at each dispatch tick). Returns
   * the paths renewed. A task that is still in flight keeps its write scope;
   * a task that has gone silent will have its leases expire at TTL.
   */
  renewScope(taskId: string): string[] {
    const renewed: string[] = []
    const nowIso = new Date(this.now()).toISOString()
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId && lease.state === 'active') {
        lease.renewedAt = nowIso
        renewed.push(lease.path)
      }
    }
    return renewed
  }

  /**
   * Active leases older than the configured TTL (measured from renewedAt, then
   * acquiredAt). Undefined TTL = no expiry; returns empty.
   */
  staleLeases(runId: string): FileLease[] {
    if (this.leaseTtlSeconds === undefined) return []
    const cutoff = this.now() - this.leaseTtlSeconds * 1000
    const stale: FileLease[] = []
    for (const lease of this.leases.values()) {
      if (lease.runId !== runId || lease.state !== 'active') continue
      const renewedMs = lease.renewedAt ? Date.parse(lease.renewedAt) : Date.parse(lease.acquiredAt)
      if (Number.isFinite(renewedMs) && renewedMs < cutoff) stale.push({ ...lease })
    }
    return stale
  }

  releaseScope(taskId: string): string[] {
    const released: string[] = []
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId && lease.state === 'active') {
        lease.state = 'released'
        released.push(lease.path)
      }
    }
    return released
  }

  releaseLease(taskId: string, path: string): boolean {
    const norm = this.normalize(path)
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId && lease.state === 'active' && this.pathsOverlap(norm, lease.path)) {
        lease.state = 'released'
        return true
      }
    }
    return false
  }

  listActiveLeases(runId: string): FileLease[] {
    const list: FileLease[] = []
    for (const lease of this.leases.values()) {
      if (lease.runId === runId && lease.state === 'active') {
        list.push({ ...lease })
      }
    }
    return list
  }

  getTaskLeases(taskId: string): FileLease[] {
    const list: FileLease[] = []
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId && lease.state === 'active') {
        list.push({ ...lease })
      }
    }
    return list
  }

  recoverLeases(activeTaskIds: Set<string>): void {
    for (const lease of this.leases.values()) {
      if (lease.state === 'active' && !activeTaskIds.has(lease.taskId)) {
        lease.state = 'released'
      }
    }
  }

  /** Release every active lease whose TTL has expired. Returns the paths released. */
  expireStaleLeases(runId: string): string[] {
    if (this.leaseTtlSeconds === undefined) return []
    const cutoff = this.now() - this.leaseTtlSeconds * 1000
    const released: string[] = []
    for (const lease of this.leases.values()) {
      if (lease.runId !== runId || lease.state !== 'active') continue
      const renewedMs = lease.renewedAt ? Date.parse(lease.renewedAt) : Date.parse(lease.acquiredAt)
      if (Number.isFinite(renewedMs) && renewedMs < cutoff) {
        lease.state = 'released'
        released.push(lease.path)
      }
    }
    return released
  }
}
