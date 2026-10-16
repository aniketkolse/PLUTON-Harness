import { describe, expect, it } from 'vitest'
import { WakeupRegistry } from '../../src/orchestrator/wakeups.ts'

describe('WakeupRegistry', () => {
  it('buffers wakeups with no waiter and drain consumes them exactly once', () => {
    const reg = new WakeupRegistry({ now: () => 1234 })
    reg.notify('parent-1', 'child-a', 'completed')
    reg.notify('parent-1', 'child-b', 'failed')
    expect(reg.pendingCount('parent-1')).toBe(2)
    expect(reg.pendingCount('parent-2')).toBe(0)

    const drained = reg.drain('parent-1')
    expect(drained).toEqual([
      { parentTaskId: 'parent-1', childTaskId: 'child-a', childState: 'completed', at: 1234 },
      { parentTaskId: 'parent-1', childTaskId: 'child-b', childState: 'failed', at: 1234 },
    ])
    expect(reg.drain('parent-1')).toEqual([])
    expect(reg.pendingCount('parent-1')).toBe(0)
    expect(reg.drain('parent-nope')).toEqual([])
  })

  it('delivers immediately to a waiting parent', async () => {
    const reg = new WakeupRegistry({ now: () => 7 })
    const pending = reg.waitFor('parent-1', 500)
    reg.notify('parent-1', 'child-a', 'completed')
    expect(await pending).toEqual([
      { parentTaskId: 'parent-1', childTaskId: 'child-a', childState: 'completed', at: 7 },
    ])
    expect(reg.pendingCount('parent-1')).toBe(0)
  })

  it('resolves immediately from the buffer without waiting for the timeout', async () => {
    const reg = new WakeupRegistry()
    reg.notify('parent-1', 'child-a', 'completed')
    const wakeups = await reg.waitFor('parent-1', 30)
    expect(wakeups.map((w) => w.childTaskId)).toEqual(['child-a'])
  })

  it('only wakes the parent the child belongs to', async () => {
    const reg = new WakeupRegistry()
    const waiter = reg.waitFor('parent-1', 500)
    reg.notify('parent-2', 'child-x', 'completed')
    expect(reg.drain('parent-2').map((w) => w.childTaskId)).toEqual(['child-x'])

    reg.notify('parent-1', 'child-y', 'completed')
    expect((await waiter).map((w) => w.childTaskId)).toEqual(['child-y'])
  })

  it('resolves [] after the timeout when nothing completes', async () => {
    const reg = new WakeupRegistry()
    const start = Date.now()
    await expect(reg.waitFor('parent-1', 25)).resolves.toEqual([])
    // It genuinely waited: the empty result is a timeout, not a synchronous return.
    expect(Date.now() - start).toBeGreaterThanOrEqual(10)
    expect(reg.pendingCount('parent-1')).toBe(0)
  })

  it('delivers each wakeup exactly once (consume-once across buffer and waiter paths)', async () => {
    const reg = new WakeupRegistry()
    reg.notify('parent-1', 'child-a', 'completed')
    expect((await reg.waitFor('parent-1', 30)).length).toBe(1)
    await expect(reg.waitFor('parent-1', 25)).resolves.toEqual([])

    const pending = reg.waitFor('parent-1', 500)
    reg.notify('parent-1', 'child-b', 'completed')
    expect((await pending).length).toBe(1)
    reg.notify('parent-1', 'child-c', 'cancelled')
    expect(reg.drain('parent-1').map((w) => w.childTaskId)).toEqual(['child-c'])
    expect(reg.drain('parent-1')).toEqual([])
  })

  it('ignores a duplicate notify for the same child, but not for a different parent', () => {
    const reg = new WakeupRegistry()
    reg.notify('parent-1', 'child-a', 'completed')
    reg.notify('parent-1', 'child-a', 'completed')
    reg.notify('parent-1', 'child-a', 'failed')
    expect(reg.pendingCount('parent-1')).toBe(1)
    expect(reg.drain('parent-1').map((w) => w.childState)).toEqual(['completed'])

    // Already delivered: a later re-notify of the same pair stays deduplicated.
    reg.notify('parent-1', 'child-a', 'completed')
    expect(reg.pendingCount('parent-1')).toBe(0)

    // The same child can still wake a different parent.
    reg.notify('parent-2', 'child-a', 'completed')
    expect(reg.drain('parent-2').length).toBe(1)
  })

  it('aggregates interleaved children into one waitFor result', async () => {
    const reg = new WakeupRegistry()
    reg.notify('parent-1', 'child-a', 'completed')
    reg.notify('parent-1', 'child-b', 'failed')
    reg.notify('parent-1', 'child-c', 'unknown_outcome')
    const wakeups = await reg.waitFor('parent-1', 40)
    expect(wakeups.map((w) => `${w.childTaskId}:${w.childState}`)).toEqual([
      'child-a:completed',
      'child-b:failed',
      'child-c:unknown_outcome',
    ])
    expect(reg.pendingCount('parent-1')).toBe(0)
  })

  it('hands each wakeup to exactly one of several waiters (FIFO)', async () => {
    const reg = new WakeupRegistry()
    const first = reg.waitFor('parent-1', 500)
    const second = reg.waitFor('parent-1', 30)
    reg.notify('parent-1', 'child-a', 'completed')
    expect((await first).map((w) => w.childTaskId)).toEqual(['child-a'])
    await expect(second).resolves.toEqual([])
  })

  it('keeps waiting parents independent across keys', async () => {
    const reg = new WakeupRegistry()
    const first = reg.waitFor('parent-1', 500)
    const second = reg.waitFor('parent-2', 500)
    reg.notify('parent-2', 'child-b', 'completed')
    reg.notify('parent-1', 'child-a', 'completed')
    expect((await first).map((w) => w.parentTaskId)).toEqual(['parent-1'])
    expect((await second).map((w) => w.parentTaskId)).toEqual(['parent-2'])
  })
})
