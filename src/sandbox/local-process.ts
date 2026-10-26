import { PolicyDeniedError } from '../domain/errors.ts'
import { run, type RunOptions, type RunResult } from '../util/exec.ts'
import { assertNetworkPolicyEnforceable } from './network.ts'
import type {
  SandboxCreateResult,
  SandboxExecOptions,
  SandboxManager,
  SandboxManagerOptions,
  SandboxProbe,
  SandboxSpec,
  SandboxStatus,
} from './types.ts'

/**
 * Dev-only degraded sandbox (ADR-0004): commands run directly on the host.
 * It exists to exercise orchestration logic on machines without a container
 * runtime. It is labeled non-isolated everywhere and must be explicitly
 * acknowledged in config (`sandbox.local_process_acknowledged: true`) before
 * the factory will hand it out. It cannot enforce any network policy other than
 * `open`, so `restricted`/`none` are refused at create time rather than being
 * silently downgraded to host networking.
 */

export const LOCAL_PROCESS_WARNING =
  'LOCAL-PROCESS SANDBOX: commands run directly on this host with your user permissions — this is NOT isolation and must never be used for untrusted work'

export class LocalProcessSandbox implements SandboxManager {
  readonly kind = 'local-process' as const
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>

  constructor(opts: SandboxManagerOptions = {}) {
    this.runFn = opts.runFn ?? run
  }

  async probe(): Promise<SandboxProbe> {
    return { available: true, kind: this.kind, detail: LOCAL_PROCESS_WARNING }
  }

  async create(spec: SandboxSpec): Promise<SandboxCreateResult> {
    assertNetworkPolicyEnforceable('sandbox.kind local-process', spec.network)
    return { containerId: `local-process:${spec.containerName}`, containerName: spec.containerName }
  }

  async start(containerName: string): Promise<void> {
    void containerName
  }

  async exec(_containerName: string, argv: string[], options: SandboxExecOptions = {}): Promise<RunResult> {
    if (argv.length === 0) throw new PolicyDeniedError('sandbox exec requires a non-empty argv')
    return this.runFn(argv, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: options.maxOutputBytes,
      input: options.input,
    })
  }

  async status(_containerName: string): Promise<SandboxStatus> {
    return 'running' // there is no container; the degenerate manager is "always present"
  }

  /** No container concept: reuse validation has nothing to read back. */
  async inspect(_containerName: string): Promise<null> {
    return null
  }

  async stop(_containerName: string): Promise<void> {}
  async remove(_containerName: string): Promise<void> {}
}
