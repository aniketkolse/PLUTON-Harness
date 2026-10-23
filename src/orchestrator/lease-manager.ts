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

export class FileLeaseManager {
  private readonly leases = new Map<string, FileLease>()

  normalize(path: string): string {
    return normalizeFilePath(path)
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

      // Direct file match
      if (lease.path === norm) {
        return {
          conflicted: true,
          heldByTaskId: lease.taskId,
          heldByShipId: lease.shipId,
          reason: `file '${norm}' is actively held by task ${lease.taskId} (${lease.shipId})`,
        }
      }

      // Dependency & lockfile cross-conflict
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
    const now = new Date().toISOString()

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
        acquired.push(p)
      } else {
        const lease: FileLease = {
          id: newId('attempt'),
          runId,
          taskId,
          shipId,
          path: p,
          symbols: syms,
          acquiredAt: now,
          state: 'active',
        }
        this.leases.set(lease.id, lease)
        acquired.push(p)
      }
    }

    return { acquired, conflicts: [] }
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
}
