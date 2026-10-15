import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, parse as parseYaml } from 'yaml'
import { ConfigError, ValidationError } from '../../domain/errors.ts'
import { engineHomesDir, validateConfig } from '../../config/load.ts'
import type { ProjectContext } from '../context.ts'
import type { MuseConfig, PlutonConfig } from '../../config/schema.ts'
import { getEngineAdapter, listEngineKinds } from '../../engines/registry.ts'
import type { EngineDiscovery, EngineAuthStatus, EngineModel } from '../../engines/contract/types.ts'
import { isPermission } from '../../domain/permissions.ts'
import { MUSE_ROLES } from '../../domain/models.ts'

export interface MuseListEntry {
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

export function listMuses(config: PlutonConfig): MuseListEntry[] {
  return Object.entries(config.muses)
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

export interface MuseDetail extends MuseListEntry {
  engineHome: string
  instructionsPath: string | null
  instructionsExists: boolean | null
  discovery: EngineDiscovery | null
  auth: EngineAuthStatus | null
}

export async function showMuse(ctx: ProjectContext, id: string): Promise<MuseDetail> {
  const m = ctx.loaded.config.muses[id]
  if (!m) {
    const known = Object.keys(ctx.loaded.config.muses).join(', ') || '(none configured)'
    throw new ValidationError(`unknown muse '${id}'; configured muses: ${known}`)
  }
  const base = listMuses(ctx.loaded.config).find((e) => e.id === id)
  if (!base) throw new ValidationError(`unknown muse '${id}'`)
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

export async function modelList(ctx: ProjectContext, museId: string): Promise<EngineModel[]> {
  const m = ctx.loaded.config.muses[museId]
  if (!m) throw new ValidationError(`unknown muse '${museId}'`)
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

export interface CreateMuseSpec {
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

export function createMuse(ctx: ProjectContext, spec: CreateMuseSpec): { configPath: string; muse: MuseConfig } {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(spec.id)) {
    throw new ValidationError(
      `invalid muse id '${spec.id}': ids are lowercase slugs (a-z, 0-9, -), starting with a letter`,
    )
  }
  if (ctx.loaded.config.muses[spec.id]) {
    throw new ValidationError(`muse '${spec.id}' already exists in pluton.yaml`)
  }
  // Engine must exist in the registry even before install checks — a typo must fail here.
  getEngineAdapter(spec.engine)
  if (spec.role !== undefined && !(MUSE_ROLES as readonly string[]).includes(spec.role)) {
    throw new ValidationError(`unknown role '${spec.role}'; known roles: ${MUSE_ROLES.join(', ')}`)
  }
  for (const p of spec.permissions ?? []) {
    if (!isPermission(p)) throw new ValidationError(`unknown permission '${p}' (see docs/MUSE_CONFIGURATION.md)`)
  }

  const role = (spec.role as MuseConfig['role']) ?? 'custom'
  // Supervisors must never get a checkout policy — keep the default role-aware so
  // `muse create boss --role supervisor` produces a valid config without extra flags.
  const defaultWorkspace: MuseConfig['workspace_policy'] =
    role === 'supervisor' ? 'coordinator-read-only' : 'isolated-task-checkout'

  const muse: MuseConfig = {
    display_name: spec.displayName ?? spec.id,
    role,
    engine: spec.engine,
    model: spec.model,
    workspace_policy: (spec.workspacePolicy as MuseConfig['workspace_policy']) ?? defaultWorkspace,
    approval_mode: (spec.approvalMode as MuseConfig['approval_mode']) ?? 'ask-for-sensitive-actions',
    ...(spec.instructionsFile ? { instructions_file: spec.instructionsFile } : {}),
    ...(spec.permissions ? { permissions: spec.permissions as MuseConfig['permissions'] } : {}),
  }

  // Edit the YAML document (preserving comments) instead of re-serializing the object model.
  const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'))
  doc.setIn(['muses', spec.id], muse)
  const nextRaw = parseYaml(doc.toString())
  validateConfig(nextRaw, ctx.rootDir, ctx.configPath) // reject before writing anything
  writeFileSync(ctx.configPath, doc.toString({ lineWidth: 0 }))

  return { configPath: ctx.configPath, muse }
}

export interface EditMusePatch {
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
 * Edit fields of an existing Muse in place, preserving YAML comments.
 * The full resulting document is validated before anything is written, so a
 * failed edit never leaves a half-written config behind.
 */
export function editMuse(
  ctx: ProjectContext,
  id: string,
  patch: EditMusePatch,
): { configPath: string; muse: MuseConfig; changed: string[] } {
  if (!ctx.loaded.config.muses[id]) {
    const known = Object.keys(ctx.loaded.config.muses).join(', ') || '(none configured)'
    throw new ValidationError(`unknown muse '${id}'; configured muses: ${known}`)
  }
  if (patch.engine !== undefined) getEngineAdapter(patch.engine)
  if (patch.role !== undefined && !(MUSE_ROLES as readonly string[]).includes(patch.role)) {
    throw new ValidationError(`unknown role '${patch.role}'; known roles: ${MUSE_ROLES.join(', ')}`)
  }
  for (const p of patch.permissions ?? []) {
    if (!isPermission(p)) throw new ValidationError(`unknown permission '${p}' (see docs/MUSE_CONFIGURATION.md)`)
  }

  const changed: string[] = []
  const doc = parseDocument(readFileSync(ctx.configPath, 'utf8'))
  const setField = (field: string, value: unknown): void => {
    doc.setIn(['muses', id, field], value)
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
      'muse edit: nothing to change — pass at least one of --engine, --model, --role, --display-name, ' +
        '--instructions-file, --workspace-policy, --approval-mode, --permission',
    )
  }

  const nextRaw = parseYaml(doc.toString())
  const loaded = validateConfig(nextRaw, ctx.rootDir, ctx.configPath) // reject before writing
  writeFileSync(ctx.configPath, doc.toString({ lineWidth: 0 }))
  const muse = loaded.config.muses[id]
  if (!muse) throw new ValidationError(`muse '${id}' disappeared during edit (internal bug)`)
  return { configPath: ctx.configPath, muse, changed }
}

function tryAdapter(kind: string): ReturnType<typeof getEngineAdapter> | null {
  try {
    return getEngineAdapter(kind)
  } catch {
    return null
  }
}
