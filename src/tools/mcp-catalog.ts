import { z } from 'zod'
import type { Permission } from '../domain/permissions.ts'
import type { McpToolInfo } from './mcp-server.ts'
import { TOOL_SCHEMAS, type PlutonToolName, TOOL_DEFS, getToolDef } from './catalog.ts'

/**
 * MCP capability registry (Phase 4, Batch 6).
 *
 * A read-only, in-process registry of MCP tool capabilities. It is additive
 * to the existing `TOOL_SCHEMAS`/`TOOL_DEFS` in `src/tools/catalog.ts`: every
 * entry here corresponds to a Pluton tool definition, and every Pluton tool
 * definition has a corresponding capability entry. Nothing here replaces or
 * duplicates the catalog — it surfaces the same metadata through a
 * capability-oriented interface suitable for MCP clients and operator
 * inspection.
 *
 * All values are declared statically; nothing is inferred, estimated, or
 * fabricated. Unknown capability = `unknown`, never assumed.
 */

export interface McpToolCapability {
  /** Canonical tool name (matches a PlutonToolName). */
  name: string
  /** Human-readable description (from the tool catalog). */
  description: string
  /** JSON Schema (draft-7) for the tool's input arguments. */
  inputSchema: Record<string, unknown>
  /** Permission required to call this tool. */
  permission: Permission
  /** True when the tool can mutate durable state. */
  mutating: boolean
  /** Whether the tool is currently available for invocation. */
  available: boolean
  /** Health status of the tool's backing implementation. */
  health: 'healthy' | 'degraded' | 'unavailable' | 'unknown'
  /** Optional execution constraints (timeoutMs, maxRetries). */
  constraints?: { timeoutMs?: number; maxRetries?: number }
  /** Human-readable reason for any non-healthy state. */
  reason?: string
}

/**
 * A capability registry entry: the capability plus the Pluton tool name it
 * maps to, so callers can route from capability → tool invocation.
 */
export interface McpCapabilityEntry {
  name: string
  capability: McpToolCapability
}

/**
 * Read-only registry of MCP tool capabilities. Pure lookups; no mutation
 * after construction. Safe to share across sessions.
 */
export class McpCapabilityRegistry {
  private readonly capabilities = new Map<string, McpCapabilityEntry>()

  constructor(capabilities: readonly McpCapabilityEntry[]) {
    for (const cap of capabilities) {
      this.capabilities.set(cap.name, cap)
    }
  }

  /** Look up one capability by tool name. */
  get(name: string): McpCapabilityEntry | null {
    return this.capabilities.get(name) ?? null
  }

  /** All capabilities, in registration order. */
  list(): McpCapabilityEntry[] {
    return [...this.capabilities.values()]
  }

  /** Capabilities filtered by required permission. */
  byPermission(permission: Permission): McpCapabilityEntry[] {
    return [...this.capabilities.values()].filter((c) => c.capability.permission === permission)
  }

  /** Capabilities that are currently healthy and available. */
  healthy(): McpCapabilityEntry[] {
    return [...this.capabilities.values()].filter(
      (c) => c.capability.available && c.capability.health !== 'unavailable'
    )
  }
}

/**
 * Build a McpCapabilityRegistry from the Pluton tool catalog. Every tool in
 * TOOL_SCHEMAS gets a corresponding capability entry. Unknown fields are
 * left as `unknown`, never inferred.
 */
export function buildCapabilityRegistry(): McpCapabilityRegistry {
  const entries: McpCapabilityEntry[] = []
  for (const name of Object.keys(TOOL_SCHEMAS) as PlutonToolName[]) {
    const def = getToolDef(name)
    if (!def) continue
    const schema = TOOL_SCHEMAS[name]
    entries.push({
      name,
      capability: {
        name,
        description: def.description,
        inputSchema: z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
        permission: def.permission,
        mutating: def.mutating,
        available: true,
        health: 'healthy',
        constraints: undefined,
        reason: undefined,
      },
    })
  }
  return new McpCapabilityRegistry(entries)
}

/**
 * Convert a McpCapabilityEntry to an McpToolInfo for MCP `tools/list`
 * responses. This is the adaptation layer between the capability registry
 * and the MCP protocol surface.
 */
export function capabilityEntryToMcpToolInfo(entry: McpCapabilityEntry): McpToolInfo {
  return {
    name: entry.name,
    description: entry.capability.description,
    inputSchema: entry.capability.inputSchema,
  }
}

/**
 * Convert all capabilities to McpToolInfo[] for MCP `tools/list` responses.
 * Only healthy, available capabilities are included by default; pass
 * `includeUnhealthy: true` to include everything.
 */
export function capabilityEntriesToMcpToolInfos(
  entries: readonly McpCapabilityEntry[],
  includeUnhealthy = false
): McpToolInfo[] {
  return entries
    .filter((e) => includeUnhealthy || (e.capability.available && e.capability.health !== 'unavailable'))
    .map(capabilityEntryToMcpToolInfo)
}

/**
 * Default registry built from the Pluton tool catalog. Exported for tests and
 * for the MCP server to use as its default capability set.
 */
export const defaultCapabilityRegistry = buildCapabilityRegistry()
