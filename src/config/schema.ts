import { z } from 'zod'
import { APPROVAL_MODES, MUSE_ROLES, WORKSPACE_POLICIES } from '../domain/models.ts'
import { PERMISSIONS } from '../domain/permissions.ts'

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

export const museConfigSchema = z
  .object({
    display_name: z.string().min(1),
    role: z.enum(MUSE_ROLES),
    engine: z.string().min(1),
    /** Exact provider-qualified model id; validated against the engine when discovery is possible. */
    model: z.string().min(1),
    instructions_file: z.string().min(1).optional(),
    workspace_policy: z.enum(WORKSPACE_POLICIES).default('isolated-task-checkout'),
    permissions: z.array(z.enum(PERMISSIONS)).min(0).optional(),
    approval_mode: z.enum(APPROVAL_MODES).default('ask-for-sensitive-actions'),
    /** Per-Muse network policy override ('restricted' | 'none' | 'open'). Defaults to runtime.network_policy. */
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

const MUSE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/

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
    /** Worker network policy: 'restricted' = bridge with DNS (not an egress filter — see docs/SECURITY.md). */
    network_policy: z.enum(['restricted', 'none', 'open']).default('restricted'),
    /** Custom Docker network for restricted policy isolation (e.g. internal network with egress disabled). */
    internal_network_name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'valid docker network name')
      .optional(),
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
    max_muse_input_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_muse_output_tokens: z.number().int().min(1).max(1_000_000_000).optional(),
    max_muse_cost_usd: z.number().positive().max(1_000_000).optional(),
  })
  .strict()
  .prefault({})

export const sandboxConfigSchema = z
  .object({
    kind: z.enum(['docker', 'local-process']).default('docker'),
    /** Digest-pinned worker image reference; resolved by scripts/build-worker-image. */
    image: z.string().min(1).optional(),
    /** local-process sandbox is dev-only and must be explicitly acknowledged. */
    local_process_acknowledged: z.boolean().default(false),
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

export const projectConfigSchema = z
  .object({
    name: z.string().min(1),
    repository: z.string().min(1).default('.'),
    default_branch: z.string().min(1).default('main'),
    verification: z.array(verificationCheckSchema).default([]),
  })
  .strict()

export const plutonConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    project: projectConfigSchema,
    runtime: runtimeConfigSchema,
    sandbox: sandboxConfigSchema,
    git: gitConfigSchema,
    muses: z.record(z.string().regex(MUSE_ID_RE, 'muse ids are lowercase slugs: a-z, 0-9, -'), museConfigSchema).default({}),
  })
  .strict()
  // Deliberate guard: refuse configs without a manager — a run cannot start.
  .superRefine((cfg, ctx) => {
    const managers = Object.entries(cfg.muses).filter(([, m]) => m.role === 'supervisor')
    if (Object.keys(cfg.muses).length > 0 && managers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'the team config declares muses but no supervisor (manager) muse',
        path: ['muses'],
      })
    }
    for (const [id, m] of Object.entries(cfg.muses)) {
      if (m.workspace_policy === 'isolated-task-checkout' && m.role === 'supervisor') {
        ctx.addIssue({
          code: 'custom',
          message: `muse '${id}' is a supervisor with an isolated-task-checkout policy — supervisors coordinate, they do not edit checkouts`,
          path: ['muses', id, 'workspace_policy'],
        })
      }
    }
  })

export type PlutonConfig = z.infer<typeof plutonConfigSchema>
export type MuseConfig = z.infer<typeof museConfigSchema>
export type VerificationCheckConfig = z.infer<typeof verificationCheckSchema>
