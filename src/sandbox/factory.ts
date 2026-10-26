import { ValidationError } from '../domain/errors.ts'
import type { PlutonConfig } from '../config/schema.ts'
import { DockerSandboxManager } from './docker.ts'
import { LocalProcessSandbox } from './local-process.ts'
import type { SandboxManager, SandboxManagerOptions } from './types.ts'

/**
 * Config-driven sandbox selection (ADR-0004). `local-process` is dev-only and
 * requires an explicit acknowledgement; there is no silent fallback when
 * Docker is unavailable — dispatch fails closed instead.
 */
export function createSandboxManager(config: PlutonConfig, opts: SandboxManagerOptions = {}): SandboxManager {
  if (config.sandbox.kind === 'native') {
    throw new ValidationError(
      'sandbox.kind native is a host execution provider, not a container SandboxManager — use ' +
        'createNativeExecutionProvider from src/execution/factory.ts; Docker remains the container backend',
    )
  }
  if (config.sandbox.kind === 'local-process') {
    if (!config.sandbox.local_process_acknowledged) {
      throw new ValidationError(
        'sandbox.kind is local-process but sandbox.local_process_acknowledged is false — running workers directly on ' +
          'the host is NOT isolation; set local_process_acknowledged: true only if you accept that trade-off (dev only)',
      )
    }
    assertLocalProcessNetworkPolicies(config)
    return new LocalProcessSandbox(opts)
  }
  return new DockerSandboxManager(opts)
}

/**
 * `local-process` runs commands directly on the host, so it can enforce neither
 * `restricted` nor `none`. The runtime default is checked first, then every
 * per-Ship override: a `restricted` Ship under an `open` runtime must fail here,
 * not have its policy silently ignored.
 *
 * The per-Ship scan mirrors `assertNativeSandboxConfig` in
 * `src/execution/factory.ts`; the two providers must agree on which configs are
 * legal, otherwise the same team file passes one backend and fails the other.
 */
function assertLocalProcessNetworkPolicies(config: PlutonConfig): void {
  if (config.runtime.network_policy !== 'open') {
    throw new ValidationError(
      `sandbox.kind local-process cannot enforce runtime.network_policy '${config.runtime.network_policy}' — ` +
        'host processes use the host network. Use sandbox.kind: docker for restricted/none, or set ' +
        'runtime.network_policy: open explicitly.',
    )
  }
  const ships = config.ships ?? config.muses ?? {}
  for (const [id, ship] of Object.entries(ships)) {
    const policy = ship.network_policy ?? config.runtime.network_policy
    if (policy === 'open') continue
    throw new ValidationError(
      `sandbox.kind local-process cannot enforce network_policy '${policy}' for ship '${id}' — ` +
        'host processes use the host network and the override would be silently ignored. ' +
        'Use sandbox.kind: docker for restricted/none, or remove the per-Ship override.',
    )
  }
}
