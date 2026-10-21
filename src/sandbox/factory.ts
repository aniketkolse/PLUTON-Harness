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
    return new LocalProcessSandbox(opts)
  }
  return new DockerSandboxManager(opts)
}
