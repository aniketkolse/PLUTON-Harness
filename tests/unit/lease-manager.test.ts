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

  describe('directory-prefix conflict detection (Batch 4)', () => {
    it('rejects a file inside a directory already leased by another task', () => {
      const manager = new FileLeaseManager()
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/'])

      const res = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/auth/login.ts'])
      expect(res.conflicts).toHaveLength(1)
      expect(res.conflicts[0]?.path).toBe('src/auth/login.ts')
      expect(res.acquired).toHaveLength(0)
    })

    it('rejects a directory lease when a nested file is already leased', () => {
      const manager = new FileLeaseManager()
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])

      const res = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/auth/'])
      expect(res.conflicts).toHaveLength(1)
      expect(res.acquired).toHaveLength(0)
    })

    it('allows two files in the same directory prefix when they are distinct files', () => {
      const manager = new FileLeaseManager()
      const r1 = manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])
      expect(r1.conflicts).toHaveLength(0)

      const r2 = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/auth/token.ts'])
      expect(r2.conflicts).toHaveLength(0)
      expect(r2.acquired).toEqual(['src/auth/token.ts'])
    })

    it('treats normalized paths consistently for prefix conflicts', () => {
      const manager = new FileLeaseManager()
      manager.declareScope('run-1', 'task-1', 'coder-1', ['./src/auth/login.ts'])

      const res = manager.declareScope('run-1', 'task-2', 'coder-2', ['src/auth/'])
      expect(res.conflicts).toHaveLength(1)
      expect(res.acquired).toHaveLength(0)
    })
  })

  describe('lease TTL and renewal (Batch 4)', () => {
    let clock = 1_000_000_000_000
    const makeManager = (ttlSeconds?: number) =>
      new FileLeaseManager({
        leaseTtlSeconds: ttlSeconds,
        now: () => clock,
      })

    it('does not expire leases when no TTL is configured', () => {
      const manager = makeManager()
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])
      expect(manager.staleLeases('run-1')).toHaveLength(0)
      expect(manager.expireStaleLeases('run-1')).toHaveLength(0)
    })

    it('marks a lease stale after TTL expires', () => {
      const manager = makeManager(60)
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])
      // Not stale yet (acquired at clock)
      expect(manager.staleLeases('run-1')).toHaveLength(0)

      // Advance the clock past the TTL without renewing
      clock += 120_000 // 2 minutes later
      const stale = manager.staleLeases('run-1')
      expect(stale).toHaveLength(1)
      expect(stale[0]?.taskId).toBe('task-1')

      const released = manager.expireStaleLeases('run-1')
      expect(released).toContain('src/auth/login.ts')
      expect(manager.listActiveLeases('run-1')).toHaveLength(0)
    })

    it('renewing a lease keeps it alive past TTL', () => {
      const manager = makeManager(60)
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])

      // Advance the clock past the TTL, then renew
      clock += 120_000
      expect(manager.staleLeases('run-1')).toHaveLength(1)
      manager.renewScope('task-1')
      expect(manager.staleLeases('run-1')).toHaveLength(0)
      expect(manager.listActiveLeases('run-1')).toHaveLength(1)
    })

    it('does not expire leases of other runs', () => {
      const manager = makeManager(1)
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts'])
      manager.declareScope('run-2', 'task-2', 'coder-2', ['src/billing/invoice.ts'])

      clock += 2_000 // past run-1's TTL
      const released = manager.expireStaleLeases('run-1')
      expect(released).toContain('src/auth/login.ts')
      expect(manager.listActiveLeases('run-2')).toHaveLength(1)
    })

    it('releases a single path via releaseLease', () => {
      const manager = makeManager()
      manager.declareScope('run-1', 'task-1', 'coder-1', ['src/auth/login.ts', 'src/billing/invoice.ts'])

      const released = manager.releaseLease('task-1', 'src/auth/login.ts')
      expect(released).toBe(true)
      expect(manager.listActiveLeases('run-1')).toHaveLength(1)
      expect(manager.listActiveLeases('run-1')[0]?.path).toBe('src/billing/invoice.ts')

      // Releasing a non-existent path is a no-op
      expect(manager.releaseLease('task-1', 'src/nonexistent.ts')).toBe(false)
    })
  })
})