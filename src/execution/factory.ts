import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { engineHomesDir, workspaceDir } from '../config/load.ts'
import type { PlutonConfig } from '../config/schema.ts'
import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../domain/errors.ts'
import type { JsonValue, MuseRecord } from '../domain/models.ts'
import { copyAllowlistedEnv } from '../engines/acp/env.ts'
import type { Store } from '../store/store.ts'
import {
  NativeExecutionProvider,
  type ExecutionEvent,
  type ExecutionNetworkPolicy,
  type ExecutionSessionSpec,
  type NativeSpawnFn,
} from './native.ts'

/**
 * Native execution factory and config gates.
 *
 * The native provider is never selected implicitly: `sandbox.kind` must be
 * `native`, both partial-enforcement acknowledgements must be present, and the
 * effective network policy must be `open`. When those gates fail, dispatch
 * fails closed with actionable text; it never falls back to Docker,
 * local-process, or an unrestricted host run.
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

/**
 * Validate the native sandbox policy before any run row, container, or engine
 * process is created. Throws when the operator has not acknowledged the
 * provider's real limits.
 */
export function assertNativeSandboxConfig(config: PlutonConfig): void {
  if (config.sandbox.kind !== 'native') {
    throw new ValidationError(
      `native execution requested but sandbox.kind is '${config.sandbox.kind}'`,
    )
  }
  const native = config.sandbox.native
  if (!native.acknowledge_partial_enforcement) {
    throw new SandboxUnavailableError(
      'sandbox.kind: native runs engine processes directly on the host with partial enforcement ' +
        '(no OS filesystem, network, or resource confinement)',
      {
        fix:
          'set sandbox.native.acknowledge_partial_enforcement: true after reading docs/NATIVE_EXECUTION.md, ' +
          'or use sandbox.kind: docker',
      },
    )
  }
  if (!native.acknowledge_host_network) {
    throw new SandboxUnavailableError(
      'sandbox.kind: native uses the host network; network isolation is not available',
      {
        fix:
          'set sandbox.native.acknowledge_host_network: true and runtime.network_policy: open, ' +
          'or use sandbox.kind: docker when network isolation is required',
      },
    )
  }

  const policies: Array<{ id: string; policy: ExecutionNetworkPolicy }> = []
  for (const [id, muse] of Object.entries(config.muses)) {
    policies.push({ id, policy: muse.network_policy ?? config.runtime.network_policy })
  }
  if (policies.length === 0) {
    policies.push({ id: '(runtime)', policy: config.runtime.network_policy })
  }
  for (const { id, policy } of policies) {
    if (policy !== 'open') {
      throw new SandboxUnavailableError(
        `native execution cannot enforce network_policy '${policy}' for ${id}: host processes share the host network`,
        {
          fix:
            'set runtime.network_policy: open (and remove per-Muse restricted/none overrides) and ' +
            'sandbox.native.acknowledge_host_network: true, or use sandbox.kind: docker',
        },
      )
    }
  }
}

/** Create the native provider after enforcing every config-level gate. */
export function createNativeExecutionProvider(args: {
  config: PlutonConfig
  rootDir: string
  hostEnv?: Record<string, string | undefined>
  onEvent?: (event: ExecutionEvent) => void
  spawnFn?: NativeSpawnFn
  killTreeFn?: (pid: number, signal: NodeJS.Signals) => Promise<void>
  now?: () => Date
}): NativeExecutionProvider {
  assertNativeSandboxConfig(args.config)
  const native = args.config.sandbox.native
  mkdirSync(workspaceDir(args.rootDir), { recursive: true })
  mkdirSync(engineHomesDir(args.rootDir), { recursive: true })
  return new NativeExecutionProvider({
    rootDir: args.rootDir,
    ...(args.hostEnv !== undefined ? { hostEnv: args.hostEnv } : {}),
    ...(args.onEvent !== undefined ? { onEvent: args.onEvent } : {}),
    ...(args.spawnFn !== undefined ? { spawnFn: args.spawnFn } : {}),
    ...(args.killTreeFn !== undefined ? { killTreeFn: args.killTreeFn } : {}),
    ...(args.now !== undefined ? { now: args.now } : {}),
    maxOutputBytes: native.max_output_bytes,
    terminateGraceMs: Math.round(native.terminate_grace_seconds * 1_000),
    sessionTimeoutMs: native.session_timeout_minutes * 60_000,
  })
}

/**
 * Build the per-session native policy for a Muse.
 *
 * The mode is a hard ceiling, not a hint: chat and coordinator sessions are
 * read-only, and only a worker with a proven isolated task checkout receives
 * workspace-write. The provider cannot enforce writes, so reporting the
 * narrower mode is deliberate and the facts still say `partial`.
 */
export function nativeSpecForMuse(args: {
  config: PlutonConfig
  rootDir: string
  projectId: string
  muse: Pick<MuseRecord, 'id' | 'engineKind' | 'workspacePolicy'>
  workdir: string
  engineHome: string
  isolatedCheckout: boolean
  sessionKind: 'run' | 'chat'
  hostEnv?: Record<string, string | undefined>
}): ExecutionSessionSpec {
  if (args.config.sandbox.kind !== 'native') {
    throw new ValidationError('nativeSpecForMuse requires sandbox.kind: native')
  }
  const native = args.config.sandbox.native
  const museConfig = args.config.muses[args.muse.id]
  const network: ExecutionNetworkPolicy =
    museConfig?.network_policy ?? args.config.runtime.network_policy
  if (network !== 'open') {
    throw new PolicyDeniedError(
      `native execution cannot run muse '${args.muse.id}' with network_policy '${network}'; ` +
        'host processes share the host network. Set runtime.network_policy: open and ' +
        'sandbox.native.acknowledge_host_network: true, or use sandbox.kind: docker.',
    )
  }

  const requiresIsolatedCheckout =
    args.sessionKind === 'run' && args.muse.workspacePolicy === 'isolated-task-checkout'
  if (requiresIsolatedCheckout && !args.isolatedCheckout) {
    throw new PolicyDeniedError(
      `isolated worker '${args.muse.id}' must run in an isolated task checkout; ` +
        'the caller reported isolatedCheckout: false',
    )
  }

  const mode =
    native.mode === 'read-only'
      ? 'read-only'
      : args.sessionKind === 'chat'
        ? 'read-only'
        : args.isolatedCheckout && args.muse.workspacePolicy === 'isolated-task-checkout'
          ? 'workspace-write'
          : 'read-only'

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
        `isolated worker '${args.muse.id}' must run inside a task checkout under '${workspacesRoot}', got '${workdir}'`,
      )
    }
  }

  return {
    projectId: args.projectId,
    museId: args.muse.id,
    engineKind: args.muse.engineKind,
    hostWorkdir: args.workdir,
    hostEngineHome: args.engineHome,
    allowedRoots: [
      args.rootDir,
      workspaceDir(args.rootDir),
      join(engineHomesDir(args.rootDir)),
    ],
    mode,
    network,
    env: copyAllowlistedEnv(native.env_allowlist, args.hostEnv ?? process.env),
    limits: {
      cpus: museConfig?.limits?.cpu ?? args.config.runtime.default_cpu_limit,
      memoryMb: museConfig?.limits?.memory_mb ?? args.config.runtime.default_memory_mb,
      pids: museConfig?.limits?.pids ?? NATIVE_PIDS_LIMIT,
    },
  }
}

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
    museId: event.museId,
    type: event.type,
    payload,
  })
}
