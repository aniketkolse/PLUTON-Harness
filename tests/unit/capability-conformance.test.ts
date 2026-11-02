import { beforeAll, describe, expect, it } from 'vitest'
import { defaultCapabilities, type EngineCapabilities } from '../../src/engines/contract/types.ts'
import { listEngineKinds, registerBuiltinEngines } from '../../src/engines/registry.ts'

/**
 * A7 conformance: engine capabilities are a *checked contract*, not prose.
 *
 * Every adapter registered in `src/engines/registry.ts` must have exactly one
 * row here, the adapter's `capabilities()` must deep-equal that row, and the
 * row must name every capability in `EngineCapabilities`. Adding an adapter,
 * adding a capability, or silently changing an adapter's feature level fails
 * this test until the table is updated deliberately (which also updates this
 * diff and its review).
 */

const CONFORMANCE: Record<string, EngineCapabilities> = {
  mock: {
    resumeSession: true,
    interrupt: true,
    approvals: false,
    usage: false,
    modelList: true,
    mcpServers: false,
    sessionExport: false,
  },
  opencode: {
    resumeSession: true,
    interrupt: true,
    approvals: true,
    usage: true,
    modelList: true,
    mcpServers: true,
    sessionExport: false,
  },
  'openai-compatible': {
    resumeSession: false,
    interrupt: true,
    approvals: false,
    usage: true,
    modelList: true,
    mcpServers: true,
    sessionExport: false,
  },
}

const CAPABILITY_KEYS = Object.keys(defaultCapabilities()).sort()

beforeAll(() => {
  registerBuiltinEngines()
})

describe('engine capability conformance', () => {
  it('has exactly one table row per registered engine, and no orphan rows', () => {
    const registered = listEngineKinds().map((factory) => factory.kind).sort()
    expect(registered).toEqual(Object.keys(CONFORMANCE).sort())
  })

  it('keeps the conservative default: every capability is false until an adapter proves it', () => {
    expect(defaultCapabilities()).toEqual({
      resumeSession: false,
      interrupt: false,
      approvals: false,
      usage: false,
      modelList: false,
      mcpServers: false,
      sessionExport: false,
    })
  })

  it('reports exactly the recorded capabilities for every adapter', () => {
    for (const factory of listEngineKinds()) {
      const expected = CONFORMANCE[factory.kind]
      expect(expected, `missing conformance row for '${factory.kind}'`).toBeDefined()
      const adapter = factory.create()
      expect(adapter.kind, `factory '${factory.kind}' created an adapter named '${adapter.kind}'`).toBe(factory.kind)
      expect(adapter.capabilities(), `capabilities drifted for '${factory.kind}'`).toEqual(expected)
      expect(
        Object.keys(adapter.capabilities()).sort(),
        `'${factory.kind}' does not declare the full EngineCapabilities vocabulary`,
      ).toEqual(CAPABILITY_KEYS)
    }
  })

  it('labels the mock engine dev-only and the real engine as shippable', () => {
    const byKind = new Map(listEngineKinds().map((factory) => [factory.kind, factory]))
    expect(byKind.get('mock')?.devOnly).toBe(true)
    expect(byKind.get('opencode')?.devOnly).toBe(false)
    for (const factory of byKind.values()) {
      expect(factory.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('does not claim session export until an adapter implements it', () => {
    for (const factory of listEngineKinds()) {
      expect(factory.create().capabilities().sessionExport).toBe(false)
    }
  })
})
