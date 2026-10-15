import { describe, expect, it } from 'vitest'
import { KeyedMutex } from '../../src/orchestrator/mutex.ts'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('KeyedMutex', () => {
  it('serializes work on the same key (no overlap)', async () => {
    const mutex = new KeyedMutex()
    let active = 0
    let maxActive = 0
    const order: string[] = []

    const work = (name: string, gate: Promise<void>): Promise<void> =>
      mutex.withLock('muse-a', async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`${name}:in`)
        await gate
        order.push(`${name}:out`)
        active -= 1
      })

    const gate1 = deferred()
    const gate2 = deferred()
    const p1 = work('first', gate1.promise)
    const p2 = work('second', gate2.promise)

    // Give the second call a chance to (incorrectly) start.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['first:in'])

    gate1.resolve()
    await p1
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['first:in', 'first:out', 'second:in'])

    gate2.resolve()
    await p2
    expect(maxActive).toBe(1)
    expect(order).toEqual(['first:in', 'first:out', 'second:in', 'second:out'])
  })

  it('does not serialize across different keys', async () => {
    const mutex = new KeyedMutex()
    const gateA = deferred()
    const gateB = deferred()
    let startedA = false
    let startedB = false

    const pA = mutex.withLock('muse-a', async () => {
      startedA = true
      await gateA.promise
    })
    const pB = mutex.withLock('muse-b', async () => {
      startedB = true
      await gateB.promise
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(startedA).toBe(true)
    expect(startedB).toBe(true)

    gateA.resolve()
    gateB.resolve()
    await Promise.all([pA, pB])
  })

  it('releases the lock when the holder throws', async () => {
    const mutex = new KeyedMutex()
    await expect(
      mutex.withLock('muse-a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const result = await mutex.withLock('muse-a', async () => 'after-error')
    expect(result).toBe('after-error')
  })

  it('returns values from locked work', async () => {
    const mutex = new KeyedMutex()
    const value = await mutex.withLock('k', async () => 42)
    expect(value).toBe(42)
  })
})
