import { z } from 'zod'
import {
  APPROVAL_MODES,
  SHIP_ROLES,
  WORKSPACE_POLICIES,
} from '../domain/models.ts'
import { normalizePermission, PERMISSIONS } from '../domain/permissions.ts'

export const CONFIG_VERSION = 1

/** Commands are argv arrays — never shell strings. */
const argvSchema = z
  .array(z.string().min(1))
  .min(1, 'command must have at least one element (argv array, not a shell string)')

export const verificationCheckSchema = z
  .object({
    name: z.string().min(1),
    command: argvSchema,
  })
  .strict()

export const shipConfigSchema = z
  .object({
    display_name: z.string().min(1),
    role: z.enum(SHIP_ROLES),
    engine: z.string().min(1),
    /** Optional provider id defined in `.pluton/providers.json`. */
    provider: z.string().min(1).optional(),
    /** Exact provider-qualified model id. When omitted, automatic model selection is used.
     * Validated against the engine when discovery is possible. */
    model: z.string().min(1).optional(),
    /** Optional task-level hints used for automatic model selection. */
    model_requirements: z
      .object({
        taskType: z.enum(['research', 'coding', 'testing', 'simple', 'planning']).optional(),
        requiredCapabilities: z.array(z.enum(['research', 'coding', 'testing', 'simple'])).optional(),
        requiresToolCalling: z.boolean().optional(),
        requiresMultimodal: z.boolean().optional(),
        minContextWindow: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    /** Optional selection preferences for automatic model selection. */
    model_preferences: z
      .object({
        costPreference: z.enum(['low', 'balanced', 'indifferent']).optional(),
        latencyPreference: z.enum(['low', 'balanced', 'indifferent']).optional(),
        maxCostUsdPerMillionTokens: z.number().positive().optional(),
        maxLatencyMs: z.number().int().min(1).optional(),
        minContextWindow: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    instructions_file: z.string().min(1).optional(),
    workspace_policy: z.enum(WORKSPACE_POLICIES).default('isolated-task-checkout'),
    permissions: z.array(z.enum(PERMISSIONS)).min(0).optional(),
    approval_mode: z.enum(APPROVAL_MODES).default('ask-for-sensitive-actions'),
    /** Per-Ship network policy override ('restricted' | 'none' | 'open'). Defaults to runtime.network_policy. */
    network_policy: z.enum(['restricted', 'none', 'open']).optional(),
    limits: z
      .object({
        cpu: z.number().positive().max(64).optional(),
        memory_mb: z.number().int().positive().max(262_144).optional(),
        pids: z.number().int().positive().max(65_536).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

/** @deprecated Use `shipConfigSchema`; kept as export alias for backward compatibility. */
export const museConfigSchema = shipConfigSchema

/** Regex for Ship IDs — lowercase slugs. */
export const SHIP_ID_RE = /^[a-z][a-z0-9-]{0,47}$/
/** @deprecated Use `SHIP_ID_RE`; kept for backward compatibility. */
export const MUSE_ID_RE = SHIP_ID_RE

/**
 * Backward-compatible config preprocessing.
 * Renames legacy `muses` → `ships`, `max_muse_*` → `max_ship_*`, and normalizes
 * deprecated permission strings (`muse.propose_create` → `ship.propose_create`).
 * After this pass the canonical schema (strict, new names) validates the data.
 */
function normalizeConfigInput(val: unknown): unknown {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
  const obj = { ...(val as Record<string, unknown>) }

  // muses <-> ships
  if (obj.ships !== undefined && obj.muses !== undefined && typeof obj.ships === 'object' && typeof obj.muses === 'object') {
    const merged = { ...(obj.muses as Record<string, unknown>), ...(obj.ships as Record<string, unknown>) }
    obj.ships = merged
    obj.muses = merged
  } else if (obj.ships === undefined && obj.muses !== undefined) {
    obj.ships = obj.muses
  } else if (obj.muses === undefined && obj.ships !== undefined) {
    obj.muses = obj.ships
  }

  // max_muse_* → max_ship_* in runtime
  if (obj.runtime && typeof obj.runtime === 'object' && !Array.isArray(obj.runtime)) {
    const runtime = { ...(obj.runtime as Record<string, unknown>) }
    const aliases: Record<string, string> = {
      max_muse_input_tokens: 'max_ship_input_tokens',
      max_muse_output_tokens: 'max_ship_output_tokens',
      max_muse_cost_usd: 'max_ship_cost_usd',
    }
    for (const [oldKey, newKey] of Object.entries(aliases)) {
      if (runtime[newKey] === undefined && runtime[oldKey] !== undefined) {
        runtime[newKey] = runtime[oldKey]
      }
      if (runtime[oldKey] === undefined && runtime[newKey] !== undefined) {
        runtime[oldKey] = runtime[newKey]
      }
    }
    obj.runtime = runtime
  }

  // Normalize permissions in each ship config
  if (obj.ships && typeof obj.ships === 'object' && !Array.isArray(obj.ships)) {
    const ships = { ...(obj.ships as Record<string, unknown>) }
    for (const [id, ship] of Object.entries(ships)) {
      if (ship && typeof ship === 'object' && !Array.isArray(ship)) {
        const shipObj = { ...(ship as Record<string, unknown>) }
        if (shipObj.permissions && Array.isArray(shipObj.permissions)) {
          shipObj.permissions = shipObj.permissions.map(normalizePermission)
        }
        ships[id] = shipObj
      }
    }
    obj.ships = ships
  }

  // Keep muses and ships synchronized for backward compatibility
  if (obj.ships !== undefined && obj.muses === undefined) {
    obj.muses = obj.ships
  } else if (obj.muses !== undefined && obj.ships === undefined) {
    obj.ships = obj.muses
  }

  return obj
}

export const runtimeConfigSchema = z
  .object({
    max_concurrent_workers: z.number().int().min(1).max(32).default(3),
    max_team_size: z.number().int().min(1).max(64).default(8),
    max_delegation_depth: z.number().int().min(0).max(12).default(3),
    max_child_tasks_per_task: z.number().int().min(0).max(100).default(5),
    max_tasks_per_run: z.number().int().min(1).max(500).default(20),
    max_run_minutes: z.number().int().min(5).max(1_440).default(90),
    default_task_minutes: z.number().int().min(1).max(480).default(30),
    default_cpu_limit: z.number().positive().max(64).default(2),
    default_memory_mb: z.number().int().min(256).max(262_144).default(4096),
    max_retries_per_task: z.number().int().min(0).max(10).default(1),
    /** Per-task cap on manager-requested revisions of failed tasks; 0 = revisions disabled. */
    max_revisions_per_task: z.number().int().min(0).max(10).default(1),
    /**
     * Worker network policy. `open` = host network (explicit egress opt-in);
     * `restricted` = private network namespace with loopback only, where the
     * session tool bridge is reached through a per-session proxy; `none` = no
     * network at all. See docs/NATIVE_EXECUTION.md and src/execution/policy.ts.
     */
    network_policy: z.enum(['restricted', 'none', 'open']).default('open'),
    max_prompt_chars: z.number().int().min(1_000).max(1_000_000).default(60_000),
    max_event_payload_chars: z.number().int().min(1_000).max(1_000_000).default(8_000),
    max_tool_result_chars: z.number().int().min(1_000).max(4_000_000).default(120_000),
    heartbeat_seconds: z.number().int().min(2).max(600).default(30),
    /** Minutes until a pending approval expires and is swept to `expired`; 0 = approvals never expire. */
    approval_timeout_minutes: z.number().int().min(0).max(10_080).default(60),

    // Usage budgets (PR-1): absent = no limit on that axis. The supervisor
    // interrupts the session at the first usage event that pushes recorded
    // usage past a configured limit. Token counts are the dependable axis —
    // engines may report `cost_usd` as 0 on free/local models.
    max_run_input_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_run_output_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_run_cost_usd: z.number().positive().max(1_000_000).optional(),
    max_ship_input_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_ship_output_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_ship_cost_usd: z.number().positive().max(1_000_000).optional(),
    /** @deprecated Use `max_ship_input_tokens`; kept for backward compatibility. */
    max_muse_input_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    /** @deprecated Use `max_ship_output_tokens`; kept for backward compatibility. */
    max_muse_output_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    /** @deprecated Use `max_ship_cost_usd`; kept for backward compatibility. */
    max_muse_cost_usd: z.number().positive().max(1_000_000).optional(),
  })
  .strict()
  .prefault({})

/**
 * Native host execution policy.
 *
 * `mode` is the filesystem policy. Confined modes require the verified native
 * helper; `unconfined` is an explicit escape hatch for platforms without a
 * verified filesystem/network sandbox (currently macOS and Windows). The old
 * acknowledgement fields are read only so existing configs keep loading; they
 * no longer grant any capability.
 */
export const nativeSandboxConfigSchema = z
  .object({
    mode: z.enum(['read-only', 'workspace-write', 'unconfined']).default('workspace-write'),
    /**
     * Per-platform mode override. A single checkout can run confined on Linux
     * and explicitly unconfined on a developer desktop without silently
     * weakening the Linux policy.
     */
    mode_by_platform: z
      .object({
        linux: z.enum(['read-only', 'workspace-write', 'unconfined']).optional(),
        darwin: z.enum(['read-only', 'workspace-write', 'unconfined']).optional(),
        win32: z.enum(['read-only', 'workspace-write', 'unconfined']).optional(),
      })
      .strict()
      .optional(),
    /** Required before an effective `unconfined` mode can run anywhere. */
    acknowledge_unconfined: z.boolean().optional(),
    /** @deprecated Retained for config compatibility; no longer grants enforcement. */
    acknowledge_partial_enforcement: z.boolean().default(false),
    /** @deprecated Retained for config compatibility; use runtime.network_policy. */
    acknowledge_host_network: z.boolean().default(false),
    /** Additional host environment variable NAMES copied into native processes. */
    env_allowlist: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'valid environment variable name'))
      .default([]),
    /** Grace between SIGTERM and SIGKILL for process trees. */
    terminate_grace_seconds: z.number().min(0).max(60).default(2),
    /** Wall-clock bound for one engine session; 0 disables the bound. */
    session_timeout_minutes: z.number().int().min(0).max(1_440).default(0),
    /** Hard cap for a single bounded `exec` stream. */
    max_output_bytes: z.number().int().min(1_024).max(16_777_216).default(1_048_576),
  })
  .strict()
  .prefault({})

export const sandboxConfigSchema = z
  .object({
    /**
     * Native host execution is the only supported substrate. The legacy values
     * are accepted by the schema so an existing config fails with explicit
     * migration guidance from `assertNativeSandboxConfig`, never with a generic
     * parse error and never by silently falling back to a weaker runtime.
     */
    kind: z.enum(['docker', 'local-process', 'native']).default('native'),
    /** @deprecated Docker worker-image key; retained only so legacy configs load and are rejected with guidance. */
    image: z.string().min(1).optional(),
    /** @deprecated Legacy local-process acknowledgement; ignored. */
    local_process_acknowledged: z.boolean().default(false),
    native: nativeSandboxConfigSchema,
  })
  .strict()
  .prefault({})

export const gitConfigSchema = z
  .object({
    protected_paths: z.array(z.string().min(1)).default([]),
    require_approval_for_main_branch_integration: z.boolean().default(true),
    base_branch: z.string().optional(),
  })
  .strict()
  .prefault({})

export const modelDiscoveryConfigSchema = z
  .object({
    refreshIntervalMs: z.number().int().min(0).default(0),
    providers: z
      .object({
        allowlist: z.array(z.string().min(1)).default([]),
        denylist: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({})

export const modelSelectionConfigSchema = z
  .object({
    taskFit: z.record(z.string(), z.array(z.enum(['research', 'coding', 'testing', 'simple']))).optional(),
    costPreference: z.enum(['low', 'balanced', 'indifferent']).default('balanced'),
    latencyPreference: z.enum(['low', 'balanced', 'indifferent']).default('balanced'),
  })
  .strict()
  .prefault({})

export const modelFallbackConfigSchema = z
  .object({
    maxRetriesPerModel: z.number().int().min(0).max(10).default(2),
    cooldownMs: z.number().int().min(0).default(300_000),
    maxTotalFallbacks: z.number().int().min(0).max(100).default(5),
    scope: z.enum(['task', 'provider', 'global']).default('task'),
  })
  .strict()
  .prefault({})

export const modelsConfigSchema = z
  .object({
    discovery: modelDiscoveryConfigSchema.optional(),
    selection: modelSelectionConfigSchema.optional(),
    fallback: modelFallbackConfigSchema.optional(),
  })
  .strict()
  .prefault({})

export const projectConfigSchema = z
  .object({
    name: z.string().min(1),
    repository: z.string().min(1).default('.'),
    default_branch: z.string().min(1).default('main'),
    verification: z.array(verificationCheckSchema).default([]),
  })
  .strict()

export const plutonConfigSchema = z.preprocess(
  normalizeConfigInput,
  z
    .object({
      version: z.literal(CONFIG_VERSION),
      project: projectConfigSchema,
      runtime: runtimeConfigSchema,
      sandbox: sandboxConfigSchema,
      git: gitConfigSchema,
      /** Ship registry — maps Ship IDs to their configs. Accepts legacy `muses` key as a backward-compatible alias. */
      ships: z.record(z.string().regex(SHIP_ID_RE, 'ship ids are lowercase slugs: a-z, 0-9, -'), shipConfigSchema).default({}),
      /** @deprecated Use `ships`; kept for backward compatibility with code referencing config.muses. */
      muses: z.record(z.string().regex(SHIP_ID_RE, 'ship ids are lowercase slugs: a-z, 0-9, -'), shipConfigSchema).default({}),
    /** Model intelligence configuration (optional; defaults preserve current behavior). */
    models: modelsConfigSchema.optional(),
    })
    .strict()
    // Deliberate guard: refuse configs without a manager — a run cannot start.
    .superRefine((cfg, ctx) => {
      const managers = Object.entries(cfg.ships).filter(([, s]) => s.role === 'supervisor')
      if (Object.keys(cfg.ships).length > 0 && managers.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'the team config declares ships but no supervisor (manager) ship',
          path: ['ships'],
        })
      }
      for (const [id, s] of Object.entries(cfg.ships)) {
        if (s.workspace_policy === 'isolated-task-checkout' && s.role === 'supervisor') {
          ctx.addIssue({
            code: 'custom',
            message: `ship '${id}' is a supervisor with an isolated-task-checkout policy — supervisors coordinate, they do not edit checkouts`,
            path: ['ships', id, 'workspace_policy'],
          })
        }
      }
      const native = cfg.sandbox.native
      const configuredModes = [
        native.mode,
        ...Object.values(native.mode_by_platform ?? {}).filter(
          (mode): mode is 'read-only' | 'workspace-write' | 'unconfined' => mode !== undefined,
        ),
      ]
      if (configuredModes.includes('unconfined') && native.acknowledge_unconfined !== true) {
        ctx.addIssue({
          code: 'custom',
          message:
            "mode 'unconfined' runs engines directly on the host with no filesystem or network confinement; " +
            'set sandbox.native.acknowledge_unconfined: true to confirm this is intentional',
          path: ['sandbox', 'native', 'acknowledge_unconfined'],
        })
      }
    })
)

export type PlutonConfig = z.infer<typeof plutonConfigSchema>
export type ShipConfig = z.infer<typeof shipConfigSchema>
/** @deprecated Use `ShipConfig`; kept as type alias for backward compatibility. */
export type MuseConfig = ShipConfig
export type VerificationCheckConfig = z.infer<typeof verificationCheckSchema>
