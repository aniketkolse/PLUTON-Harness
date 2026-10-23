import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, parse as parseYaml } from 'yaml'
import { ConfigError, ValidationError } from '../../domain/errors.ts'
import { engineHomesDir, validateConfig } from '../../config/load.ts'
import type { ProjectContext } from '../context.ts'
import type { ShipConfig, PlutonConfig } from '../../config/schema.ts'
import { getEngineAdapter, listEngineKinds } from '../../engines/registry.ts'
import type { EngineDiscovery, EngineAuthStatus, EngineModel } from '../../engines/contract/types.ts'
import { isPermission } from '../../domain/permissions.ts'
import { SHIP_ROLES } from '../../domain/models.ts'

export interface ShipListEntry {
  id: string
  displayName: string
  role: string
  engine: string
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
      model: m.model,
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
  const adapter = tryAdapter(m.engine)
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
  const adapter = getEngineAdapter(m.engine)
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

export interface CreateShipSpec {
  id: string
  displayName?: string
  role?: string
  engine: string
  model: string
  instructionsFile?: string
  workspacePolicy?: string
  approvalMode?: string
  permissions?: string[]
}

export function createShip(ctx: ProjectContext, spec: CreateShipSpec): { configPath: string; ship: ShipConfig } {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(spec.id)) {
    throw new ValidationError(
      `invalid ship id '${spec.id}': ids are lowercase slugs (a-z, 0-9, -), starting with a letter`,
    )
  }
  if (ctx.loaded.config.ships[spec.id]) {
    throw new ValidationError(`ship '${spec.id}' already exists in pluton.yaml`)
  }
  // Engine must exist in the registry even before install checks — a typo must fail here.
  getEngineAdapter(spec.engine)
  if (spec.role !== undefined && !(SHIP_ROLES as readonly string[]).includes(spec.role)) {
    throw new ValidationError(`unknown role '${spec.role}'; known roles: ${SHIP_ROLES.join(', ')}`)
  }
  for (const p of spec.permissions ?? []) {
    if (!isPermission(p)) throw new ValidationError(`unknown permission '${p}' (see docs/SHIPS_CONFIGURATION.md)`)
  }

  const role = (spec.role as ShipConfig['role']) ?? 'custom'
  // Supervisors must never get a checkout policy — keep the default role-aware so
  // `ship create boss --role supervisor` produces a valid config without extra flags.
  const defaultWorkspace: ShipConfig['workspace_policy'] =
    role === 'supervisor' ? 'coordinator-read-only' : 'isolated-task-checkout'

  const ship: ShipConfig = {
    display_name: spec.displayName ?? spec.id,
    role,
    engine: spec.engine,
    model: spec.model,
    workspace_policy: (spec.workspacePolicy as ShipConfig['workspace_policy']) ?? defaultWorkspace,
    approval_mode: (spec.approvalMode as ShipConfig['approval_mode']) ?? 'ask-for-sensitive-actions',
    ...(spec.instructionsFile ? { instructions_file: spec.instructionsFile } : {}),
    ...(spec.permissions ? { permissions: spec.permissions as ShipConfig['permissions'] } : {}),
  }

  // Edit the YAML document (preserving comments) instead of re-serializing the object model.
  const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'))
  const key = doc.has('ships') ? 'ships' : 'muses'
  doc.setIn([key, spec.id], ship)
  const nextRaw = parseYaml(doc.toString())
  validateConfig(nextRaw, ctx.rootDir, ctx.configPath) // reject before writing anything
  writeFileSync(ctx.configPath, doc.toString({ lineWidth: 0 }))

  return { configPath: ctx.configPath, ship }
}

export interface EditShipPatch {
  displayName?: string
  role?: string
  engine?: string
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
  if (patch.engine !== undefined) getEngineAdapter(patch.engine)
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
  if (patch.model !== undefined) setField('model', patch.model)
  if (patch.instructionsFile !== undefined) setField('instructions_file', patch.instructionsFile)
  if (patch.workspacePolicy !== undefined) setField('workspace_policy', patch.workspacePolicy)
  if (patch.approvalMode !== undefined) setField('approval_mode', patch.approvalMode)
  if (patch.permissions !== undefined) setField('permissions', patch.permissions)

  if (changed.length === 0) {
    throw new ValidationError(
      'ship edit: nothing to change — pass at least one of --engine, --model, --role, --display-name, ' +
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

function tryAdapter(kind: string): ReturnType<typeof getEngineAdapter> | null {
  try {
    return getEngineAdapter(kind)
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
