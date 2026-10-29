import { PolicyDeniedError, SandboxUnavailableError } from '../domain/errors.ts'
import type { ExecutionMode, ExecutionNetworkPolicy } from '../domain/models.ts'

/**
 * Native execution policy vocabulary and the fail-closed platform matrix.
 *
 * The backend (how a process is spawned), the capability report (what this host
 * can actually prove) and the policy (what the operator asked for) are
 * deliberately separate. A policy is only accepted when the capability report
 * can enforce every control it claims; otherwise dispatch fails before a
 * process is created. There is no fallback to a weaker mode or network policy.
 */

export type { ExecutionMode, ExecutionNetworkPolicy } from '../domain/models.ts'

export type PlatformKey = 'linux' | 'darwin' | 'win32'

export const PLATFORM_KEYS: readonly PlatformKey[] = ['linux', 'darwin', 'win32']

export interface HelperCapability {
  available: boolean
  version: string | null
  sha256: string | null
  /** Human-readable reason when unavailable or unverified. */
  detail?: string
}

export interface NativeCapabilities {
  platform: PlatformKey
  arch: string
  kernelRelease: string | null
  landlockAbi: number | null
  userNamespaces: boolean
  mountNamespaces: boolean
  networkNamespaces: boolean
  pidNamespaces: boolean
  cgroupV2: boolean
  helper: HelperCapability
  /** Engine/runtime directories that must be readable/executable inside the sandbox. */
  runtimeRoots: string[]
}

export interface EffectiveExecutionPolicy {
  platform: PlatformKey
  mode: ExecutionMode
  network: ExecutionNetworkPolicy
}

/** What the provider actually enforces for one session. Never speculative. */
export interface EnforcementReport {
  filesystem: 'landlock' | 'none'
  network: 'netns' | 'host' | 'none'
  mountNamespace: boolean
  pidNamespace: boolean
  privateTmp: boolean
  processTreeKill: boolean
  resourceLimits: false
  osConfinement: boolean
  limitations: string[]
}

export function platformKey(platform: NodeJS.Platform = process.platform): PlatformKey {
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') return platform
  throw new SandboxUnavailableError(`unsupported native execution platform '${platform}'`, {
    fix: 'run Pluton on Linux, macOS or Windows; confined modes are only available on Linux',
  })
}

/**
 * Resolve the effective mode for this host. `mode_by_platform` lets one config
 * run confined on Linux and explicitly unconfined on developer desktops without
 * silently weakening Linux.
 */
export function resolveEffectiveMode(args: {
  mode: ExecutionMode
  modeByPlatform?: Partial<Record<PlatformKey, ExecutionMode>> | undefined
  platform?: NodeJS.Platform
}): ExecutionMode {
  const platform = platformKey(args.platform)
  return args.modeByPlatform?.[platform] ?? args.mode
}

export function resolveEffectiveNetwork(args: {
  runtimePolicy: ExecutionNetworkPolicy
  shipPolicy?: ExecutionNetworkPolicy | undefined
}): ExecutionNetworkPolicy {
  return args.shipPolicy ?? args.runtimePolicy
}

function unsupported(policy: EffectiveExecutionPolicy, reason: string, fix: string): never {
  throw new SandboxUnavailableError(
    `native policy '${policy.mode}' + '${policy.network}' is not supported on ${policy.platform}: ${reason}`,
    { fix, details: { policy } },
  )
}

/**
 * Validate the complete policy against the reported capabilities.
 *
 * - Linux confined modes require a verified helper, Landlock ABI >= 3, and
 *   unprivileged user/mount/PID namespaces.
 * - `restricted`/`none` additionally require network namespaces.
 * - macOS/Windows only support `open` + `unconfined`.
 * - `unconfined` only supports `open` everywhere.
 */
export function assertPolicySupported(
  policy: EffectiveExecutionPolicy,
  capabilities: NativeCapabilities,
): void {
  if (policy.platform !== capabilities.platform) {
    throw new SandboxUnavailableError(
      `native policy platform '${policy.platform}' does not match capability platform '${capabilities.platform}'`,
    )
  }

  if (policy.platform === 'darwin' || policy.platform === 'win32') {
    if (policy.mode !== 'unconfined' || policy.network !== 'open') {
      unsupported(
        policy,
        'this platform has no verified filesystem or network confinement implementation',
        `set sandbox.native.mode_by_platform.${policy.platform}: unconfined, ` +
          'sandbox.native.acknowledge_unconfined: true, and runtime.network_policy: open; ' +
          'or run confined work on Linux',
      )
    }
    return
  }

  if (policy.mode === 'unconfined') {
    if (policy.network !== 'open') {
      unsupported(
        policy,
        'an unconfined process shares the host network, so restricted/none cannot be enforced',
        'use network_policy: open with unconfined, or choose workspace-write/read-only on Linux',
      )
    }
    return
  }

  if (!capabilities.helper.available) {
    unsupported(
      policy,
      capabilities.helper.detail ?? 'the verified native helper is unavailable',
      'run `pluton doctor`, install the matching native helper, or explicitly choose mode: unconfined',
    )
  }
  if (capabilities.landlockAbi === null || capabilities.landlockAbi < 3) {
    unsupported(
      policy,
      `Landlock ABI 3 or newer is required (reported: ${String(capabilities.landlockAbi)})`,
      'use a Linux kernel >= 6.2 with Landlock enabled, or explicitly choose mode: unconfined',
    )
  }
  // Match the provider's prepare() guard: a verified helper and Landlock alone
  // are not confinement if the host cannot create the namespaces the helper
  // needs. Fail closed here, before any run row or process exists. Checked
  // after the network requirement so a restricted policy reports the specific
  // namespace it is missing.
  if (policy.network === 'restricted' || policy.network === 'none') {
    if (!capabilities.userNamespaces || !capabilities.networkNamespaces) {
      unsupported(
        policy,
        'unprivileged user and network namespaces are required for network confinement',
        'enable unprivileged user namespaces, run with the required namespace privileges, or choose network_policy: open',
      )
    }
  }
  if (!capabilities.userNamespaces || !capabilities.mountNamespaces || !capabilities.pidNamespaces) {
    unsupported(
      policy,
      'native confinement requires unprivileged user, mount and PID namespaces on this host',
      'enable unprivileged namespaces, or explicitly choose mode: unconfined',
    )
  }
}

export function enforcementFor(
  policy: EffectiveExecutionPolicy,
  capabilities: NativeCapabilities,
): EnforcementReport {
  if (policy.mode === 'unconfined') {
    return {
      filesystem: 'none',
      network: 'host',
      mountNamespace: false,
      pidNamespace: false,
      privateTmp: false,
      processTreeKill: true,
      resourceLimits: false,
      osConfinement: false,
      limitations: [
        'filesystem reads, writes and exec are not OS-confined',
        'network access is the host network and is not filtered',
        'CPU/memory/pids limits are recorded but not enforced',
      ],
    }
  }

  const network =
    policy.network === 'open' ? 'host' : policy.network === 'restricted' ? 'netns' : 'none'
  const limitations: string[] = [
    'CPU/memory/pids limits are recorded but not enforced by cgroups',
    'a process that escapes the helper process tree can outlive graceful termination',
  ]
  if (!capabilities.mountNamespaces) {
    limitations.push('mount namespace unavailable: /tmp is not private; only the session tmp directory is writable')
  }
  if (policy.network === 'restricted') {
    limitations.push('no external network or DNS; the session tool bridge is the only reachable service')
  }
  if (policy.network === 'none') {
    limitations.push('no network at all, including the tool bridge and loopback')
  }
  return {
    filesystem: 'landlock',
    network,
    mountNamespace: capabilities.mountNamespaces,
    pidNamespace: capabilities.pidNamespaces,
    privateTmp: capabilities.mountNamespaces,
    processTreeKill: true,
    resourceLimits: false,
    osConfinement: true,
    limitations,
  }
}

/** Orchestrated sessions need the tool bridge; `none` intentionally has none. */
export function assertOrchestratedNetworkPolicy(
  network: ExecutionNetworkPolicy,
  command: 'run' | 'chat' | 'server',
): void {
  if (network === 'none') {
    throw new PolicyDeniedError(
      `network_policy: none cannot be used with pluton ${command}: orchestrated sessions require the ` +
        'session tool bridge, and none has no network or bridge. Use restricted (loopback bridge only) ' +
        'or open (host network).',
      { network, command },
    )
  }
}
