import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { engineHomesDir, workspaceDir } from '../config/load.ts'
import type { PlutonConfig } from '../config/schema.ts'
import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../domain/errors.ts'
import type { JsonValue, ShipRecord } from '../domain/models.ts'
import { copyAllowlistedEnv } from '../engines/acp/env.ts'
import type { Store } from '../store/store.ts'
import { detectCapabilities } from './capabilities.ts'
import {
  NativeExecutionProvider,
  type ExecutionBridgeSpec,
  type ExecutionEvent,
  type ExecutionNetworkPolicy,
  type ExecutionSessionSpec,
  type NativeSpawnFn,
} from './native.ts'
import {
  assertPolicySupported,
  platformKey,
  resolveEffectiveMode,
  resolveEffectiveNetwork,
  type NativeCapabilities,
} from './policy.ts'

/**
 * Native execution factory and config gates.
 *
 * The native provider is the only execution substrate. `sandbox.kind` must be
 * `native`; Docker and local-process configs fail with migration guidance
 * instead of falling back to a weaker runtime. Every effective mode/network
 * pair is checked against the host capability report before any run row or
 * process exists. `unconfined` additionally requires an explicit operator
 * acknowledgement on every platform.
 */

const NATIVE_PIDS_LIMIT = 512

/**
 * Resolve an existing path through symlinks/junctions for containment checks.
 * A missing path stays lexical; the provider rejects nonexistent workdirs
 * before spawning anything.
 */
function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync.native(path) : resolve(path)
}

/** Effective policy pairs a config can produce on this host. */
function configPolicies(config: PlutonConfig): Array<{
  id: string
  mode: ReturnType<typeof resolveEffectiveMode>
  network: ExecutionNetworkPolicy
}> {
  const native = config.sandbox.native
  const mode = resolveEffectiveMode({
    mode: native.mode,
    modeByPlatform: native.mode_by_platform,
  })
  const ships = config.ships ?? config.muses ?? {}
  const entries = Object.entries(ships)
  if (entries.length === 0) {
    return [
      {
        id: '(runtime)',
        mode,
        network: resolveEffectiveNetwork({ runtimePolicy: config.runtime.network_policy }),
      },
    ]
  }
  return entries.map(([id, ship]) => ({
    id,
    mode,
    network: resolveEffectiveNetwork({
      runtimePolicy: config.runtime.network_policy,
      shipPolicy: ship.network_policy,
    }),
  }))
}

/**
 * Reject a legacy container/dev config before any provider exists. Cheap (no
 * capability probe, no process): callers that only plan or describe work use
 * this so a config that cannot execute is never reported as a usable runtime.
 */
export function assertNativeSandboxKind(config: PlutonConfig): void {
  if (config.sandbox.kind === 'native') return
  const legacy = config.sandbox.kind
  throw new SandboxUnavailableError(
    `sandbox.kind '${legacy}' is no longer supported: native execution is the only substrate`,
    {
      fix:
        legacy === 'docker'
          ? 'remove sandbox.image/worker-image settings and set sandbox.kind: native; see docs/NATIVE_EXECUTION.md for the migration'
          : 'set sandbox.kind: native and choose sandbox.native.mode: unconfined with acknowledge_unconfined: true for development',
    },
  )
}

/**
 * Validate the native sandbox policy before any run row, helper process or
 * engine process is created. Throws when the operator has not acknowledged
 * `unconfined`, or when this host cannot enforce an effective policy.
 */
export function assertNativeSandboxConfig(
  config: PlutonConfig,
  capabilities: NativeCapabilities = detectCapabilities(),
): void {
  assertNativeSandboxKind(config)
  const native = config.sandbox.native
  const effectiveMode = resolveEffectiveMode({
    mode: native.mode,
    modeByPlatform: native.mode_by_platform,
  })
  if (effectiveMode === 'unconfined' && native.acknowledge_unconfined !== true) {
    throw new SandboxUnavailableError(
      `native execution mode 'unconfined' runs engine processes with no filesystem or network confinement on ${process.platform}`,
      {
        fix:
          'set sandbox.native.acknowledge_unconfined: true after reading docs/NATIVE_EXECUTION.md, ' +
          'or choose read-only/workspace-write on Linux',
      },
    )
  }

  for (const policy of configPolicies(config)) {
    assertPolicySupported(
      { platform: capabilities.platform, mode: policy.mode, network: policy.network },
      capabilities,
    )
  }
}

/** Create the native provider after enforcing every config-level gate. */
export function createNativeExecutionProvider(args: {
  config: PlutonConfig
  rootDir: string
  /**
   * Additional super-roots a session's allowed roots may live under. Needed for
   * session workspaces outside the server project root: the provider still
   * rejects every path outside `rootDir ∪ extraRoots`.
   */
  extraRoots?: string[]
  hostEnv?: Record<string, string | undefined>
  onEvent?: (event: ExecutionEvent) => void
  spawnFn?: NativeSpawnFn
  killTreeFn?: (pid: number, signal: NodeJS.Signals) => Promise<void>
  now?: () => Date
  /** Test seam: reuse a capability report instead of probing again. */
  capabilities?: NativeCapabilities
}): NativeExecutionProvider {
  const capabilities = args.capabilities ?? detectCapabilities()
  assertNativeSandboxConfig(args.config, capabilities)
  const native = args.config.sandbox.native
  mkdirSync(workspaceDir(args.rootDir), { recursive: true })
  mkdirSync(engineHomesDir(args.rootDir), { recursive: true })
  mkdirSync(join(args.rootDir, '.pluton', 'tmp', 'sessions'), { recursive: true, mode: 0o700 })
  return new NativeExecutionProvider({
    rootDir: args.rootDir,
    capabilities,
    ...(args.extraRoots !== undefined ? { extraRoots: args.extraRoots } : {}),
    ...(args.hostEnv !== undefined ? { hostEnv: args.hostEnv } : {}),
    ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
    ...(args.spawnFn !== undefined ? { spawnFn: args.spawnFn } : {}),
    ...(args.killTreeFn !== undefined ? { killTreeFn: args.killTreeFn } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
    maxOutputBytes: native.max_output_bytes ?? 1_048_576,
    terminateGraceMs: Math.round((native.terminate_grace_seconds ?? 2) * 1_000),
    sessionTimeoutMs: (native.session_timeout_minutes ?? 0) * 60_000,
  })
}

/**
 * Build the per-session native policy for a Ship.
 *
 * The mode is a hard ceiling, not a hint: chat and coordinator sessions are
 * read-only, and only a worker with a proven isolated task checkout receives
 * workspace-write. On a platform whose effective mode is `unconfined`, that
 * explicit mode wins because the operator acknowledged it in config.
 */
export function nativeSpecForShip(args: {
  config: PlutonConfig
  rootDir: string
  projectId: string
  ship?: Pick<ShipRecord, 'id' | 'engineKind' | 'workspacePolicy'>
  /** @deprecated Use `ship`; kept for backward compatibility. */
  muse?: Pick<ShipRecord, 'id' | 'engineKind' | 'workspacePolicy'>
  workdir: string
  engineHome: string
  isolatedCheckout: boolean
  sessionKind: 'run' | 'chat'
  /** Extra absolute roots this session may use as its cwd (session workspace). */
  extraAllowedRoots?: string[]
  /** Host tool-bridge endpoint; required for restricted network sessions. */
  bridge?: ExecutionBridgeSpec
  hostEnv?: Record<string, string | undefined>
}): ExecutionSessionSpec {
  if (args.config.sandbox.kind !== 'native') {
    throw new ValidationError('nativeSpecForShip requires sandbox.kind: native')
  }
  const ship = args.ship ?? args.muse
  if (!ship) {
    throw new ValidationError('nativeSpecForShip requires ship or muse')
  }
  const native = args.config.sandbox.native
  const shipConfig = args.config.ships[ship.id]
  const network: ExecutionNetworkPolicy = resolveEffectiveNetwork({
    runtimePolicy: args.config.runtime.network_policy,
    shipPolicy: shipConfig?.network_policy,
  })

  const requiresIsolatedCheckout =
    args.sessionKind === 'run' && ship.workspacePolicy === 'isolated-task-checkout'
  if (requiresIsolatedCheckout && !args.isolatedCheckout) {
    throw new PolicyDeniedError(
      `isolated worker '${ship.id}' must run in an isolated task checkout; ` +
        'the caller reported isolatedCheckout: false',
    )
  }

  const effectiveMode = resolveEffectiveMode({
    mode: native.mode,
    modeByPlatform: native.mode_by_platform,
  })
  const mode =
    effectiveMode === 'unconfined'
      ? 'unconfined'
      : effectiveMode === 'read-only'
        ? 'read-only'
        : args.sessionKind === 'chat'
          ? 'read-only'
          : args.isolatedCheckout && ship.workspacePolicy === 'isolated-task-checkout'
            ? 'workspace-write'
            : 'read-only'

  if (network === 'restricted' && args.bridge === undefined) {
    throw new PolicyDeniedError(
      `ship '${ship.id}' uses network_policy: restricted but no session tool bridge is available; ` +
        'orchestrated sessions must provide an AF_UNIX bridge endpoint for the loopback proxy',
    )
  }

  // An isolated worker must run in its own task checkout, not merely somewhere
  // inside the (broader) provider roots. The supervisor already passes the
  // workspace path; this second check keeps a future wiring regression from
  // silently running a worker at the project root or in an engine home.
  //
  // Canonicalize existing paths first: a symlink/junction placed under
  // `.pluton/workspaces/` can otherwise pass a lexical prefix check while
  // resolving to the project root, which the provider's broader allowedRoots
  // would accept. Missing paths stay lexical; the provider rejects them later.
  if (args.isolatedCheckout) {
    const workspacesRoot = canonicalPath(workspaceDir(args.rootDir))
    const workdir = canonicalPath(args.workdir)
    const rel = relative(workspacesRoot, workdir)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PolicyDeniedError(
        `isolated worker '${ship.id}' must run inside a task checkout under '${workspacesRoot}', got '${workdir}'`,
      )
    }
  }

  // An isolated worker gets only its own checkout and its own engine home. The
  // project root, the shared workspace directory, every engine home and any
  // session extra roots are manager/chat capabilities: granting them to a
  // worker would expose sibling Ships' credentials and `.pluton` state even
  // though the worker only needs its checkout. The provider still adds host
  // runtime roots needed to execute Node/the engine binary.
  const isolatedWorker =
    args.sessionKind === 'run' &&
    args.isolatedCheckout &&
    ship.workspacePolicy === 'isolated-task-checkout'
  if (isolatedWorker) {
    // The provider refuses a missing allowed root. A worker's own engine home
    // is a required runtime resource (auth/config/caches), so create it here
    // rather than widening the roots when a caller has not pre-created it.
    mkdirSync(args.engineHome, { recursive: true, mode: 0o700 })
  }
  const allowedRoots = isolatedWorker
    ? [canonicalPath(args.workdir), canonicalPath(args.engineHome)]
    : [
        args.rootDir,
        workspaceDir(args.rootDir),
        join(engineHomesDir(args.rootDir)),
        ...(args.extraAllowedRoots ?? []),
      ]

  return {
    projectId: args.projectId,
    shipId: ship.id,
    engineKind: ship.engineKind,
    hostWorkdir: args.workdir,
    hostEngineHome: args.engineHome,
    allowedRoots,
    mode,
    network,
    ...(args.bridge !== undefined && network === 'restricted' ? { bridge: args.bridge } : {}),
    env: copyAllowlistedEnv(native.env_allowlist, args.hostEnv ?? process.env),
    limits: {
      cpus: shipConfig?.limits?.cpu ?? args.config.runtime.default_cpu_limit,
      memoryMb: shipConfig?.limits?.memory_mb ?? args.config.runtime.default_memory_mb,
      pids: shipConfig?.limits?.pids ?? NATIVE_PIDS_LIMIT,
    },
  }
}

/** @deprecated Use `nativeSpecForShip`; kept for backward compatibility. */
export const nativeSpecForMuse = nativeSpecForShip

/**
 * Persist execution facts through the existing durable event log. Payloads
 * contain lifecycle metadata only: no env values, command lines, or prompts.
 */
export function appendExecutionEvent(
  store: Store,
  projectId: string,
  runId: string | null,
  event: ExecutionEvent,
): void {
  const payload = {
    provider: event.provider,
    sessionId: event.sessionId,
    engineKind: event.engineKind,
    ...(event.pid !== undefined ? { pid: event.pid } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.signal !== undefined ? { signal: event.signal } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
    ...(event.names !== undefined ? { names: event.names } : {}),
  } as unknown as JsonValue
  store.appendEvent({
    projectId,
    runId,
    shipId: event.shipId,
    type: event.type,
    payload,
  })
}

/** Export for doctor/status callers that need the effective platform key. */
export { platformKey }
