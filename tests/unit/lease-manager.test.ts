import { describe, expect, it } from 'vitest'
import { FileLeaseManager, normalizeFilePath } from '../../src/orchestrator/lease-manager.ts'

describe('FileLeaseManager', () => {
  it('normalizes file paths correctly', () => {
    expect(normalizeFilePath('./src/auth/login.ts')).toBe('src/auth/login.ts')
    expect(normalizeFilePath('.\\src\\auth\\login.ts')).toBe('src/auth/login.ts')
    expect(normalizeFilePath('src/auth/../auth/login.ts')).toBe('src/auth/login.ts')
    expect(normalizeFilePath('/src/auth/login.ts')).toBe('src/auth/login.ts')
  })

  it('allows non-conflicting leases across tasks', () => {
    const manager = new FileLeaseManager()
    const res1 = manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts', 'src/auth/token.ts'])
    expect(res1.conflicts).toHaveLength(0)
    expect(res1.acquired).toEqual(['src/auth/login.ts', 'src/auth/token.ts'])

    const res2 = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/billing/invoice.ts'])
    expect(res2.conflicts).toHaveLength(0)
    expect(res2.acquired).toEqual(['src/billing/invoice.ts'])
  })

  it('detects and rejects overlapping file leases with actionable explanation', () => {
    const manager = new FileLeaseManager()
    manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])

    const res = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/auth/login.ts', 'src/users/profile.ts'])
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]?.path).toBe('src/auth/login.ts')
    expect(res.conflicts[0]?.heldByTaskId).toBe('task-1')
    expect(res.conflicts[0]?.reason).toContain('held by task task-1')
    // Non-conflicting paths are not acquired if there is a conflict in the batch
    expect(res.acquired).toHaveLength(0)
  })

  it('strictly prohibits concurrent modifications to dependency files and lockfiles', () => {
    const manager = new FileLeaseManager()
    const r1 = manager.declareScope('run-1', 'task-1', 'coder-1', ['package.json'])
    expect(r1.conflicts).toHaveLength(0)

    const r2 = manager.declareScope('run-1', 'task-2', 'coder-2', ['package-lock.json'])
    expect(r2.conflicts).toHaveLength(1)
    expect(r2.conflicts[0]?.reason).toContain('concurrent dependency-file modification rejected')
  })

  it('allows same task to renew or expand its own lease', () => {
    const manager = new FileLeaseManager()
    manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])

    const res = manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts', 'src/auth/session.ts'])
    expect(res.conflicts).toHaveLength(0)
    expect(res.acquired).toContain('src/auth/login.ts')
    expect(res.acquired).toContain('src/auth/session.ts')
  })

  it('safely releases leases on task completion, failure, or cancellation', () => {
    const manager = new FileLeaseManager()
    manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts', 'package.json'])
    expect(manager.listActiveLeases('run-1')).toHaveLength(2)

    const released = manager.releaseScope('task-1')
    expect(released).toContain('src/auth/login.ts')
    expect(released).toContain('package.json')
    expect(manager.listActiveLeases('run-1')).toHaveLength(0)

    // Now another task can acquire package.json
    const r2 = manager.declareScope('run-1', 'task-2', 'coder-2', ['package.json'])
    expect(r2.conflicts).toHaveLength(0)
  })

  it('recovers leases by clearing orphaned leases from finished or interrupted tasks', () => {
    const manager = new FileLeaseManager()
    manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])
    manager.declareScope('run-1', 'task-2', 'coder-2', ['src/billing/invoice.ts'])

    // Only task-2 is still active
    manager.recoverLeases(new Set(['task-2']))
    const active = manager.listActiveLeases('run-1')
    expect(active).toHaveLength(1)
    expect(active[0]?.taskId).toBe('task-2')
  })
})
