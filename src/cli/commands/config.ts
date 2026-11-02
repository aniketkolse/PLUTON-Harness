import { redactProseSecrets } from '../../util/redact.ts'
import { findProjectRoot, loadConfig } from '../../config/load.ts'
import { CONFIG_VERSION } from '../../config/schema.ts'
import { ConfigError } from '../../domain/errors.ts'
import type { PlutonConfig } from '../../config/schema.ts'

/**
 * `pluton config` — safe configuration inspection and validation.
 *
 * Reads pluton.yaml (discovered by walking up from CWD, or via --config /
 * PLUTON_CONFIG) and reports its effective settings. Never exposes secrets,
 * never modifies files, never writes to disk.
 */

export interface ConfigCommandOptions {
  /** Subcommand: 'view' | 'validate' | 'path' | 'ships' */
  subcommand?: string
  json?: boolean
}

export interface ConfigReport {
  configPath: string
  rootDir: string
  version: number
  project: {
    name: string
    repository: string
    default_branch: string
  }
  runtime: {
    max_concurrent_workers: number
    max_team_size: number
    max_delegation_depth: number
    max_tasks_per_run: number
    max_run_minutes: number
    default_task_minutes: number
    network_policy: string
    max_prompt_chars: number
    has_usage_budgets: boolean
  }
  sandbox: {
    kind: string
    mode: string
    acknowledge_unconfined: boolean
  }
  git: {
    protected_paths: string[]
    require_approval_for_main_branch_integration: boolean
    base_branch: string | null
  }
  ships: Array<{
    id: string
    display_name: string
    role: string
    engine: string
    model: string | null
    workspace_policy: string
    permission_count: number
  }>
  models: {
    discovery_refresh_interval_ms: number
    selection_cost_preference: string
    selection_latency_preference: string
  }
}

/** Redact any value that could be a secret or credential. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    // Never show full tokens/keys; show only first 4 + last 4 chars if long enough
    if (value.length > 8 && /[A-Za-z0-9]{20,}/.test(value)) {
      return `${value.slice(0, 4)}…${value.slice(-4)} (redacted)`
    }
    return value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase()
      if (
        lower.includes('key') ||
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('password') ||
        lower.includes('credential') ||
        lower.includes('api_key') ||
        lower.includes('apikey')
      ) {
        out[k] = '[redacted]'
      } else {
        out[k] = redact(v)
      }
    }
    return out
  }
  return value
}

function loadConfigSafe(cwd: string): { config: PlutonConfig; rootDir: string; configPath: string } {
  const root = findProjectRoot(cwd)
  if (!root) {
    throw new ConfigError(
      `no pluton.yaml found in ${cwd} or any parent directory — run \`pluton init\` to create one`,
    )
  }
  return loadConfig(root)
}

export async function configView(cwd: string): Promise<ConfigReport> {
  const { config, rootDir, configPath } = loadConfigSafe(cwd)
  const runtime = config.runtime ?? {}
  const sandbox = config.sandbox ?? {}
  const native = sandbox.native ?? {}
  const git = config.git ?? {}
  const models = (config.models ?? {}) as { discovery?: { refreshIntervalMs?: number }; selection?: { costPreference?: string; latencyPreference?: string } }
  const discovery = models.discovery ?? {}
  const selection = models.selection ?? {}
  const ships = Object.entries(config.ships).map(([id, ship]) => ({
    id,
    display_name: ship.display_name,
    role: ship.role,
    engine: ship.engine,
    model: ship.model ?? null,
    workspace_policy: ship.workspace_policy,
    permission_count: ship.permissions?.length ?? 0,
  }))

  return {
    configPath,
    rootDir,
    version: config.version ?? CONFIG_VERSION,
    project: {
      name: config.project.name,
      repository: config.project.repository,
      default_branch: config.project.default_branch,
    },
    runtime: {
      max_concurrent_workers: runtime.max_concurrent_workers ?? 3,
      max_team_size: runtime.max_team_size ?? 8,
      max_delegation_depth: runtime.max_delegation_depth ?? 3,
      max_tasks_per_run: runtime.max_tasks_per_run ?? 20,
      max_run_minutes: runtime.max_run_minutes ?? 90,
      default_task_minutes: runtime.default_task_minutes ?? 30,
      network_policy: runtime.network_policy ?? 'open',
      max_prompt_chars: runtime.max_prompt_chars ?? 60_000,
      has_usage_budgets: Boolean(
        runtime.max_run_input_tokens ||
          runtime.max_run_output_tokens ||
          runtime.max_run_cost_usd ||
          runtime.max_ship_input_tokens ||
          runtime.max_ship_output_tokens ||
          runtime.max_ship_cost_usd,
      ),
    },
    sandbox: {
      kind: sandbox.kind ?? 'native',
      mode: native.mode ?? 'workspace-write',
      acknowledge_unconfined: Boolean(native.acknowledge_unconfined),
    },
    git: {
      protected_paths: git.protected_paths ?? [],
      require_approval_for_main_branch_integration: git.require_approval_for_main_branch_integration ?? true,
      base_branch: git.base_branch ?? null,
    },
    ships,
    models: {
      discovery_refresh_interval_ms: (discovery as { refreshIntervalMs?: number }).refreshIntervalMs ?? 0,
      selection_cost_preference: (selection as { costPreference?: string }).costPreference ?? 'balanced',
      selection_latency_preference: (selection as { latencyPreference?: string }).latencyPreference ?? 'balanced',
    },
  }
}

export async function configValidate(cwd: string): Promise<{ valid: true; configPath: string }> {
  const { configPath } = loadConfigSafe(cwd)
  return { valid: true, configPath }
}

export async function configPath(cwd: string): Promise<{ configPath: string; rootDir: string }> {
  const { configPath, rootDir } = loadConfigSafe(cwd)
  return { configPath, rootDir }
}

export async function configShips(cwd: string): Promise<Array<{ id: string; role: string; engine: string }>> {
  const { config } = loadConfigSafe(cwd)
  return Object.entries(config.ships).map(([id, ship]) => ({
    id,
    role: ship.role,
    engine: ship.engine,
  }))
}
