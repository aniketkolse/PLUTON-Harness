import { describe, expect, it } from 'vitest'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { getEngineAdapter, listEngineKinds, registerBuiltinEngines } from '../../src/engines/registry.ts'
import { requireCapability } from '../../src/engines/contract/helpers.ts'
import { CapabilityError, ValidationError } from '../../src/domain/errors.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('engine registry', () => {
  it('rejects unknown engines with the known list', () => {
    registerBuiltinEngines()
    expect(() => getEngineAdapter('nope')).toThrowError(ValidationError)
    expect(() => getEngineAdapter('nope')).toThrowError(/known engines: mock/)
  })

  it('lists builtin engines', () => {
    registerBuiltinEngines()
    const kinds = listEngineKinds().map((k) => k.kind)
    expect(kinds).toContain('mock')
  })
})

describe('mock engine adapter', () => {
  it('emits normalized events and a success result', async () => {
    const adapter = new MockEngineAdapter({ script: [{ text: 'hello', events: [{ kind: 'tool', name: 'bash', phase: 'start' }] }] })
    const session = await adapter.startSession({
      muse: { id: 'm1', slug: 'worker-a', role: 'coder', model: 'mock/model-a' },
      workdir: '.',
      env: {},
      configDir: '.',
    })
    const events = await collect(session.sendPrompt({ text: 'do it' }))
    expect(events.map((e) => e.kind)).toEqual(['status', 'tool', 'text', 'result'])
    const result = events.at(-1)
    expect(result).toMatchObject({ kind: 'result', outcome: 'success' })
  })

  it('interrupt turns a pending prompt into cancelled, never success', async () => {
    const adapter = new MockEngineAdapter({ script: [{ delayMs: 5_000, outcome: 'success' }] })
    const session = await adapter.startSession({
      muse: { id: 'm1', slug: 'worker-a', role: 'coder', model: 'mock/model-a' },
      workdir: '.',
      env: {},
      configDir: '.',
    })
    const stream = session.sendPrompt({ text: 'long work' })
    const events: EngineEvent[] = []
    const consume = (async () => {
      for await (const ev of stream) events.push(ev)
    })()
    await new Promise((r) => setTimeout(r, 20))
    await session.interrupt()
    await consume
    const result = events.at(-1)
    expect(result).toMatchObject({ kind: 'result', outcome: 'cancelled' })
  })

  it('protocol crashes surface as error + unknown outcome', async () => {
    const adapter = new MockEngineAdapter({ script: [{ protocolCrash: true }] })
    const session = await adapter.startSession({
      muse: { id: 'm1', slug: 'w', role: 'coder', model: 'mock/model-a' },
      workdir: '.',
      env: {},
      configDir: '.',
    })
    const events = await collect(session.sendPrompt({ text: 'x' }))
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'unknown' })
  })

  it('capability gating fails loudly instead of faking', () => {
    const adapter = new MockEngineAdapter({ capabilities: { approvals: false } })
    expect(() => requireCapability(adapter, 'approvals')).toThrowError(CapabilityError)
    expect(() => requireCapability(adapter, 'interrupt')).not.toThrow()
  })
})
