import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../domain/errors.ts'
import type { PlutonConfig } from '../config/schema.ts'
import type { RunResult } from '../util/exec.ts'
import type { SandboxManager, SandboxSpec } from './types.ts'

/**
 * Restricted-network contract (ADR-0004, docs/SECURITY.md).
 *
 * `restricted` is a kernel/Docker-enforced denial of outbound network access:
 * the container is attached to a dedicated `--internal` Docker network, which
 * has no default route, no masquerading and Docker's cross-network firewall
 * rules in front of it. The only reachable off-network address is that
 * network's gateway — the host — which is what the Pluton tool bridge uses.
 *
 * That gateway is also the documented residual exposure: `restricted` is not a
 * defence against a malicious engine attacking host services bound to the
 * Docker gateway. It *is* a defence against the engine reaching the internet,
 * package registries or model providers directly.
 *
 * Fail-closed rules encoded here:
 * - a restricted container never falls back to `bridge`;
 * - the internal network must exist (or be creatable) and must report
 *   `Internal=true`; an existing non-internal network is refused;
 * - the running container is probed from inside before a run starts; if the
 *   probe can reach a public address (or cannot prove it is blocked) the run is
 *   refused instead of silently running with egress.
 *
 * `none` is stricter still (`--network none`) but, unlike `restricted`, the
 * tool bridge is unreachable, so engines cannot call Pluton tools; it exists
 * for the container lifecycle/E2E paths that need a hermetic box.
 */

export type ContainerNetworkPolicy = 'restricted' | 'none' | 'open'

const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const RESERVED_NETWORKS = new Set(['bridge', 'host', 'none'])

/** Default prefix for the per-project internal network. */
export const RESTRICTED_NETWORK_PREFIX = 'pluton-restricted'

/** Public destination used by the runtime probe; a stable, unroutable-under-restricted address. */
export const EGRESS_PROBE_HOST = '1.1.1.1'
export const EGRESS_PROBE_PORT = 443
export const EGRESS_PROBE_OPEN = 'PLUTON_EGRESS_OPEN'
export const EGRESS_PROBE_BLOCKED = 'PLUTON_EGRESS_BLOCKED'

const EGRESS_PROBE_TIMEOUT_MS = 20_000
const EGRESS_PROBE_SCRIPT = [
  "const net=require('node:net');",
  'let done=false;',
  'const s=net.connect({host:process.env.PLUTON_EGRESS_PROBE_HOST,port:Number(process.env.PLUTON_EGRESS_PROBE_PORT)});',
  `function finish(m){if(done)return;done=true;console.log(m);s.destroy()}`,
  's.setTimeout(2500);',
  `s.on('connect',()=>finish('${EGRESS_PROBE_OPEN}'));`,
  `s.on('timeout',()=>finish('${EGRESS_PROBE_BLOCKED}'));`,
  `s.on('error',()=>finish('${EGRESS_PROBE_BLOCKED}'));`,
  `setTimeout(()=>finish('${EGRESS_PROBE_BLOCKED}'),5000).unref()`,
].join('')

const RESTRICTED_PROBE_FIX =
  'restricted runs need a Docker network created with `docker network create --internal`; ' +
  'remove the conflicting network or point runtime.internal_network_name at an internal network, then retry'

/**
 * The Docker network a restricted container must run on. A configured
 * `internal_network_name` is used verbatim; otherwise the name is scoped to the
 * project so two projects never share one internal network.
 */
export function restrictedNetworkName(configured: string | undefined, projectId: string): string {
  const name = configured ?? `${RESTRICTED_NETWORK_PREFIX}-${projectId}`
  if (!NETWORK_NAME_RE.test(name)) {
    throw new ValidationError(
      `restricted network name must be a valid docker network name (letters, digits, '_', '.', '-'), got '${name}'`,
      { details: { network: name } },
    )
  }
  return name
}

/**
 * The exact network set a container must be attached to. Restricted containers
 * require an explicitly resolved internal network; `bridge` is never a valid
 * restricted network (it would silently restore full egress).
 */
export function expectedContainerNetworks(
  spec: Pick<SandboxSpec, 'network' | 'customNetwork'>,
): [string, ...string[]] {
  if (spec.network === 'none') return ['none']
  if (spec.network === 'restricted') {
    const name = spec.customNetwork
    if (name === undefined || name === '') {
      throw new ValidationError(
        'network policy "restricted" requires an internal Docker network; refusing to fall back to bridge',
        { details: { policy: spec.network } },
      )
    }
    if (!NETWORK_NAME_RE.test(name) || RESERVED_NETWORKS.has(name)) {
      throw new ValidationError(
        `network policy "restricted" cannot use '${name}' as its network; it must be a dedicated internal network`,
        { details: { network: name } },
      )
    }
    return [name]
  }
  return [spec.customNetwork ?? 'bridge']
}

/** Per-Ship override wins over the runtime default, exactly as before. */
export function resolveShipNetworkPolicy(config: PlutonConfig, shipId: string): ContainerNetworkPolicy {
  return config.ships[shipId]?.network_policy ?? config.runtime.network_policy
}

export interface ShipNetworkPlan {
  policy: ContainerNetworkPolicy
  /** Present only for `restricted`; the internal network the container must join. */
  customNetwork?: string
}

export interface PlanShipNetworkOptions {
  manager: SandboxManager
  config: PlutonConfig
  shipId: string
  projectId: string
  /** Per-run cache so N Ships on one internal network pay one `docker network inspect`. */
  ensured?: Set<string>
}

/**
 * Resolve a Ship's policy and, for restricted, ensure the internal network
 * exists and is genuinely internal. Managers that cannot provide one (the
 * dev-only local-process sandbox) fail closed.
 */
export async function planShipNetwork(opts: PlanShipNetworkOptions): Promise<ShipNetworkPlan> {
  const policy = resolveShipNetworkPolicy(opts.config, opts.shipId)
  if (policy !== 'restricted') return { policy }

  const name = restrictedNetworkName(opts.config.runtime.internal_network_name, opts.projectId)
  if (opts.ensured?.has(name) === true) return { policy, customNetwork: name }

  const ensure = opts.manager.ensureInternalNetwork
  if (typeof ensure !== 'function') {
    throw new SandboxUnavailableError(
      `sandbox manager '${opts.manager.kind}' cannot enforce network policy "restricted" ` +
        '(no internal-network support); refusing to run with unrestricted egress',
      { fix: 'use sandbox.kind: docker with a reachable Docker daemon, or set runtime.network_policy: open explicitly' },
    )
  }
  await ensure.call(opts.manager, name)
  opts.ensured?.add(name)
  return { policy, customNetwork: name }
}

/**
 * Prove from inside the running container that the internet is unreachable.
 * Any other outcome — a successful connection, a probe that cannot run, a
 * daemon timeout — refuses the run. The destination is passed through the
 * environment, never interpolated into the script or argv.
 */
export async function verifyRestrictedEgress(
  manager: SandboxManager,
  containerName: string,
  opts: { host?: string; port?: number } = {},
): Promise<void> {
  const host = opts.host ?? EGRESS_PROBE_HOST
  const port = opts.port ?? EGRESS_PROBE_PORT
  let result: RunResult
  try {
    result = await manager.exec(containerName, ['node', '-e', EGRESS_PROBE_SCRIPT], {
      timeoutMs: EGRESS_PROBE_TIMEOUT_MS,
      env: { PLUTON_EGRESS_PROBE_HOST: host, PLUTON_EGRESS_PROBE_PORT: String(port) },
    })
  } catch (cause) {
    throw new SandboxUnavailableError(
      `restricted network probe could not run in '${containerName}': ${(cause as Error).message}`,
      { fix: RESTRICTED_PROBE_FIX },
    )
  }

  if (result.stdout.includes(EGRESS_PROBE_OPEN)) {
    throw new SandboxUnavailableError(
      `restricted network enforcement is not in place for '${containerName}': the container reached ${host}:${String(port)}`,
      {
        fix: RESTRICTED_PROBE_FIX,
        details: { containerName, host, port },
      },
    )
  }
  if (result.stdout.includes(EGRESS_PROBE_BLOCKED)) return

  const why = result.timedOut
    ? `probe timed out after ${String(EGRESS_PROBE_TIMEOUT_MS)}ms`
    : `probe produced no verdict (exit ${String(result.exitCode)}): ${result.stderr.slice(0, 200)}`
  throw new SandboxUnavailableError(
    `cannot prove restricted network enforcement for '${containerName}': ${why}`,
    { fix: RESTRICTED_PROBE_FIX, details: { containerName } },
  )
}

/** Exposed for tests: the exact script the container runs. */
export const RESTRICTED_EGRESS_PROBE_SCRIPT = EGRESS_PROBE_SCRIPT

/** Guard for callers that want to reject restricted/none on a non-enforcing host. */
export function assertNetworkPolicyEnforceable(kind: string, policy: ContainerNetworkPolicy): void {
  if (policy === 'open') return
  throw new PolicyDeniedError(
    `${kind} cannot enforce network policy '${policy}': commands run directly on the host; ` +
      'use sandbox.kind: docker for restricted/none, or set runtime.network_policy: open explicitly',
    { policy },
  )
}
