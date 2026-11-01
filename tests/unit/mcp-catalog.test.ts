import { describe, expect, it } from 'vitest'
import {
  McpCapabilityRegistry,
  buildCapabilityRegistry,
  capabilityEntryToMcpToolInfo,
  capabilityEntriesToMcpToolInfos,
  type McpCapabilityEntry,
  type McpToolCapability,
} from '../../src/tools/mcp-catalog.ts'

function makeCapability(overrides: Partial<McpToolCapability> = {}): McpToolCapability {
  return {
    name: 'test.tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    permission: 'task.inspect',
    mutating: false,
    available: true,
    health: 'healthy',
    constraints: undefined,
    reason: undefined,
    ...overrides,
  }
}

describe('McpCapabilityRegistry', () => {
  it('is empty when constructed with no entries', () => {
    const registry = new McpCapabilityRegistry([])
    expect(registry.list()).toEqual([])
    expect(registry.get('nonexistent')).toBeNull()
  })

  it('stores and retrieves capabilities by name', () => {
    const cap = makeCapability({ name: 'tool.create' })
    const registry = new McpCapabilityRegistry([{ name: 'tool.create', capability: cap }])
    expect(registry.get('tool.create')?.capability).toEqual(cap)
    expect(registry.get('nonexistent')).toBeNull()
  })

  it('lists capabilities in registration order', () => {
    const a = makeCapability({ name: 'tool.create' })
    const b = makeCapability({ name: 'task.inspect' })
    const registry = new McpCapabilityRegistry([
      { name: 'tool.create', capability: a },
      { name: 'task.inspect', capability: b },
    ])
    expect(registry.list().map((e) => e.name)).toEqual(['tool.create', 'task.inspect'])
  })

  it('filters by permission', () => {
    const registry = new McpCapabilityRegistry([
      { name: 'task.create', capability: makeCapability({ name: 'task.create', permission: 'task.create' }) },
      { name: 'task.inspect', capability: makeCapability({ name: 'task.inspect', permission: 'task.inspect' }) },
      { name: 'task.cancel', capability: makeCapability({ name: 'task.cancel', permission: 'task.cancel' }) },
    ])
    const inspect = registry.byPermission('task.inspect')
    expect(inspect.map((e) => e.name)).toEqual(['task.inspect'])
  })

  it('filters by healthy availability', () => {
    const registry = new McpCapabilityRegistry([
      { name: 'healthy.tool', capability: makeCapability({ name: 'healthy.tool', available: true, health: 'healthy' }) },
      { name: 'degraded.tool', capability: makeCapability({ name: 'degraded.tool', available: true, health: 'degraded' }) },
      { name: 'unavailable.tool', capability: makeCapability({ name: 'unavailable.tool', available: false, health: 'unavailable' }) },
    ])
    const healthy = registry.healthy()
    expect(healthy.map((e) => e.name)).toEqual(['healthy.tool', 'degraded.tool'])
    expect(healthy.map((e) => e.name)).not.toContain('unavailable.tool')
  })
})

describe('buildCapabilityRegistry', () => {
  it('produces an entry for every Pluton tool', () => {
    const registry = buildCapabilityRegistry()
    expect(registry.list().length).toBeGreaterThan(0)
    expect(registry.get('task.create')).not.toBeNull()
    expect(registry.get('task.inspect')).not.toBeNull()
    expect(registry.get('review.report')).not.toBeNull()
  })

  it('entries have required fields', () => {
    const registry = buildCapabilityRegistry()
    const entry = registry.get('task.create')
    expect(entry).not.toBeNull()
    expect(entry?.capability.name).toBe('task.create')
    expect(typeof entry?.capability.description).toBe('string')
    expect(entry?.capability.inputSchema).toBeDefined()
    expect(typeof entry?.capability.permission).toBe('string')
    expect(typeof entry?.capability.mutating).toBe('boolean')
    expect(typeof entry?.capability.available).toBe('boolean')
    expect(['healthy', 'degraded', 'unavailable', 'unknown']).toContain(entry?.capability.health)
  })
})

describe('capabilityEntryToMcpToolInfo', () => {
  it('converts a capability entry to an McpToolInfo', () => {
    const cap = makeCapability({ name: 'task.create', description: 'Create a task', inputSchema: { type: 'object' } })
    const entry: McpCapabilityEntry = { name: 'task.create', capability: cap }
    const info = capabilityEntryToMcpToolInfo(entry)
    expect(info.name).toBe('task.create')
    expect(info.description).toBe('Create a task')
    expect(info.inputSchema).toEqual({ type: 'object' })
  })
})

describe('capabilityEntriesToMcpToolInfos', () => {
  it('filters out unhealthy entries by default', () => {
    const healthy = makeCapability({ name: 'healthy.tool', available: true, health: 'healthy' })
    const unhealthy = makeCapability({ name: 'unhealthy.tool', available: false, health: 'unavailable' })
    const entries: McpCapabilityEntry[] = [
      { name: 'healthy.tool', capability: healthy },
      { name: 'unhealthy.tool', capability: unhealthy },
    ]
    const infos = capabilityEntriesToMcpToolInfos(entries)
    expect(infos.map((i) => i.name)).toEqual(['healthy.tool'])
    expect(infos.map((i) => i.name)).not.toContain('unhealthy.tool')
  })

  it('includes unhealthy entries when includeUnhealthy is true', () => {
    const healthy = makeCapability({ name: 'healthy.tool', available: true, health: 'healthy' })
    const unhealthy = makeCapability({ name: 'unhealthy.tool', available: false, health: 'unavailable' })
    const entries: McpCapabilityEntry[] = [
      { name: 'healthy.tool', capability: healthy },
      { name: 'unhealthy.tool', capability: unhealthy },
    ]
    const infos = capabilityEntriesToMcpToolInfos(entries, true)
    expect(infos.map((i) => i.name)).toEqual(['healthy.tool', 'unhealthy.tool'])
  })
})
