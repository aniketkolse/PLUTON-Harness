import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, parse as parseYaml } from 'yaml'
import { ConfigError, ValidationError } from '../../domain/errors.ts'
import { engineHomesDir, validateConfig } from '../../config/load.ts'
import type { ProjectContext } from '../context.ts'
import type { ShipConfig, PlutonConfig } from '../../config/schema.ts'
import { getEngineAdapter, listEngineKinds, type EngineCreateOptions } from '../../engines/registry.ts'
import type { EngineDiscovery, EngineAuthStatus, EngineModel } from '../../engines/contract/types.ts'
import { isPermission } from '../../domain/permissions.ts'
import { SHIP_ROLES } from '../../domain/models.ts'
import { resolveProviderForEngine } from '../../providers/store.ts'

export interface ShipListEntry {
  id: string
  displayName: string
  role: string
  engine: string
  provider: string | null
  model: string
  workspacePolicy: string
  approvalMode: string
  permissions: string[]
  instructionsFile: string | null
  source: 'config' | 'dynamic'
}

export function listShips(config: PlutonConfig): ShipListEntry[] {
  return Object.entries(config.ships)
    .map(([id, m]) => ({
      id,
      displayName: m.display_name,
      role: m.role,
      engine: m.engine,
      provider: m.provider ?? null,
      model: m.model ?? '',
      workspacePolicy: m.workspace_policy,
      approvalMode: m.approval_mode,
      permissions: m.permissions ?? [],
      instructionsFile: m.instructions_file ?? null,
      source: 'config' as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export interface ShipDetail extends ShipListEntry {
  engineHome: string
  instructionsPath: string | null
  instructionsExists: boolean | null
  discovery: EngineDiscovery | null
  auth: EngineAuthStatus | null
}

export async function showShip(ctx: ProjectContext, id: string): Promise<ShipDetail> {
  const m = ctx.loaded.config.ships[id]
  if (!m) {
    const known = Object.keys(ctx.loaded.config.ships).join(', ') || '(none configured)'
    throw new ValidationError(`unknown ship '${id}'; configured ships: ${known}`)
  }
  const base = listShips(ctx.loaded.config).find((e) => e.id === id)
  if (!base) throw new ValidationError(`unknown ship '${id}'`)
  const engineHome = join(engineHomesDir(ctx.rootDir), id)
  const instructionsPath = m.instructions_file ? join(ctx.rootDir, m.instructions_file) : null
  let discovery: EngineDiscovery | null = null
  let auth: EngineAuthStatus | null = null
  const adapter = tryAdapter(m.engine, { rootDir: ctx.rootDir, providerId: m.provider })
  if (adapter) {
    discovery = await adapter.discover()
    auth = await adapter.authStatus(engineHome)
  }
  return {
    ...base,
    engineHome,
    instructionsPath,
    instructionsExists: instructionsPath ? existsSync(instructionsPath) : null,
    discovery,
    auth,
  }
}

export interface EngineListEntry {
  kind: string
  description: string
  devOnly: boolean
  discovery: EngineDiscovery | null
}

export async function engineList(): Promise<EngineListEntry[]> {
  const out: EngineListEntry[] = []
  for (const f of listEngineKinds()) {
    let discovery: EngineDiscovery | null = null
    try {
      discovery = await f.create().discover()
    } catch {
      discovery = null
    }
    out.push({ kind: f.kind, description: f.description, devOnly: f.devOnly, discovery })
  }
  return out
}

export async function modelList(ctx: ProjectContext, shipId: string): Promise<EngineModel[]> {
  const m = ctx.loaded.config.ships[shipId]
  if (!m) throw new ValidationError(`unknown ship '${shipId}'`)
  const adapter = getEngineAdapter(m.engine, { rootDir: ctx.rootDir, providerId: m.provider })
  const disc = await adapter.discover()
  if (!disc.installed) {
    throw new ValidationError(`engine '${m.engine}' is not installed. ${disc.fix}`)
  }
  if (!adapter.capabilities().modelList) {
    throw new ValidationError(
      `engine '${m.engine}' does not expose a model catalogue; use its own docs to choose a model id and set it in pluton.yaml`,
    )
  }
  return adapter.listModels()
}

import { createShip, type CreateShipSpec } from '../../orchestrator/service.ts'
export { createShip, type CreateShipSpec }

export interface EditShipPatch {
  displayName?: string
  role?: string
  engine?: string
  provider?: string
  model?: string
  instructionsFile?: string
  workspacePolicy?: string
  approvalMode?: string
  permissions?: string[]
}

/**
 * Edit fields of an existing Ship in place, preserving YAML comments.
 * The full resulting document is validated before anything is written, so a
 * failed edit never leaves a half-written config behind.
 */
export function editShip(
  ctx: ProjectContext,
  id: string,
  patch: EditShipPatch,
): { configPath: string; ship: ShipConfig; changed: string[] } {
  if (!ctx.loaded.config.ships[id]) {
    const known = Object.keys(ctx.loaded.config.ships).join(', ') || '(none configured)'
    throw new ValidationError(`unknown ship '${id}'; configured ships: ${known}`)
  }
  const targetEngine = patch.engine ?? ctx.loaded.config.ships[id]?.engine
  const targetProvider = patch.provider !== undefined ? patch.provider : ctx.loaded.config.ships[id]?.provider
  if (targetEngine !== undefined) {
    if (targetProvider !== undefined || targetEngine === 'openai-compatible') {
      resolveProviderForEngine(ctx.rootDir, targetEngine, targetProvider)
    }
    getEngineAdapter(targetEngine, { rootDir: ctx.rootDir, providerId: targetProvider })
  }
  if (patch.role !== undefined && !(SHIP_ROLES as readonly string[]).includes(patch.role)) {
    throw new ValidationError(`unknown role '${patch.role}'; known roles: ${SHIP_ROLES.join(', ')}`)
  }
  for (const p of patch.permissions ?? []) {
    if (!isPermission(p)) throw new ValidationError(`unknown permission '${p}' (see docs/SHIPS_CONFIGURATION.md)`)
  }

  const changed: string[] = []
  const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'))
  const key = doc.has('ships') ? 'ships' : 'muses'
  const setField = (field: string, value: unknown): void => {
    doc.setIn([key, id, field], value)
    changed.push(field)
  }
  if (patch.displayName !== undefined) setField('display_name', patch.displayName)
  if (patch.role !== undefined) setField('role', patch.role)
  if (patch.engine !== undefined) setField('engine', patch.engine)
  if (patch.provider !== undefined) setField('provider', patch.provider)
  if (patch.model !== undefined) setField('model', patch.model)
  if (patch.instructionsFile !== undefined) setField('instructions_file', patch.instructionsFile)
  if (patch.workspacePolicy !== undefined) setField('workspace_policy', patch.workspacePolicy)
  if (patch.approvalMode !== undefined) setField('approval_mode', patch.approvalMode)
  if (patch.permissions !== undefined) setField('permissions', patch.permissions)

  if (changed.length === 0) {
    throw new ValidationError(
      'ship edit: nothing to change — pass at least one of --engine, --provider, --model, --role, --display-name, ' +
        '--instructions-file, --workspace-policy, --approval-mode, --permission',
    )
  }

  const nextRaw = parseYaml(doc.toString())
  const loaded = validateConfig(nextRaw, ctx.rootDir, ctx.configPath) // reject before writing
  writeFileSync(ctx.configPath, doc.toString({ lineWidth: 0 }))
  const ship = loaded.config.ships[id]
  if (!ship) throw new ValidationError(`ship '${id}' disappeared during edit (internal bug)`)
  return { configPath: ctx.configPath, ship, changed }
}

function tryAdapter(kind: string, opts?: EngineCreateOptions): ReturnType<typeof getEngineAdapter> | null {
  try {
    return getEngineAdapter(kind, opts)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible alias exports — callers can migrate incrementally.
// ---------------------------------------------------------------------------

/** @deprecated Use `listShips`; kept for backward compatibility. */
export const listMuses = listShips
/** @deprecated Use `showShip`; kept for backward compatibility. */
export const showMuse = showShip
/** @deprecated Use `createShip`; kept for backward compatibility. */
export const createMuse = createShip
/** @deprecated Use `editShip`; kept for backward compatibility. */
export const editMuse = editShip
/** @deprecated Use `ShipListEntry`; kept for backward compatibility. */
export type MuseListEntry = ShipListEntry
/** @deprecated Use `ShipDetail`; kept for backward compatibility. */
export type MuseDetail = ShipDetail
/** @deprecated Use `CreateShipSpec`; kept for backward compatibility. */
export type CreateMuseSpec = CreateShipSpec
/** @deprecated Use `EditShipPatch`; kept for backward compatibility. */
export type EditMusePatch = EditShipPatch
