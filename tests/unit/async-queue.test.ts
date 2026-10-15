import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../../src/util/async-queue.ts'

describe('AsyncQueue', () => {
  it('delivers pushed items in FIFO order', async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.push(3)
    q.close()
    const seen: number[] = []
    for await (const n of q) seen.push(n)
    expect(seen).toEqual([1, 2, 3])
  })

  it('wakes a pending reader when an item arrives', async () => {
    const q = new AsyncQueue<string>()
    const read = (async () => {
      const first = await q.next()
      return first
    })()
    await new Promise((r) => setTimeout(r, 5))
    expect(q.push('hello')).toBe(true)
    const result = await read
    expect(result).toEqual({ done: false, value: 'hello' })
    q.close()
  })

  it('refuses pushes when full or closed, without throwing', () => {
    const q = new AsyncQueue<number>(2)
    expect(q.push(1)).toBe(true)
    expect(q.push(2)).toBe(true)
    expect(q.push(3)).toBe(false)
    expect(q.size).toBe(2)
    q.close()
    expect(q.isClosed).toBe(true)
    expect(q.push(4)).toBe(false)
  })

  it('drains queued items after close, then ends iteration', async () => {
    const q = new AsyncQueue<string>()
    q.push('a')
    q.close()
    q.push('late')
    const seen: string[] = []
    for await (const item of q) seen.push(item)
    expect(seen).toEqual(['a'])
  })
})
