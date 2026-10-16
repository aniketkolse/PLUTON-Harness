import type {
  SandboxCreateResult,
  SandboxExecOptions,
  SandboxInspect,
  SandboxManager,
  SandboxProbe,
  SandboxSpec,
  SandboxStatus,
} from '../../src/sandbox/types.ts'
import type { RunResult } from '../../src/util/exec.ts'

/**
 * In-memory sandbox fake for tests: records every call (arguments intact) and
 * lets tests script probe/exec/inspect results. The runtime and terminal
 * managers are tested against this without any container runtime.
 */

export interface FakeSandboxCall {
  method: 'probe' | 'create' | 'start' | 'exec' | 'status' | 'inspect' | 'stop' | 'remove'
  args: unknown[]
}

export function okResult(argv: string[], stdout = ''): RunResult {
  return { argv, exitCode: 0, timedOut: false, stdout, stderr: '', truncated: false, durationMs: 1 }
}

export function failResult(argv: string[], stderr = 'boom', exitCode = 1): RunResult {
  return { argv, exitCode, timedOut: false, stdout: '', stderr, truncated: false, durationMs: 1 }
}

export class FakeSandbox implements SandboxManager {
  kind: 'docker' | 'local-process' = 'docker'
  probeResult: SandboxProbe = { available: true, kind: 'docker', detail: 'fake docker server 1.0' }
  statusResult: SandboxStatus = 'running'
  /** Result returned by inspect(); null = "no container facts" (legacy reuse behavior). */
  inspectResult: SandboxInspect | null = null
  /** Shifted per exec call; falls back to an empty successful result. */
  execQueue: RunResult[] = []
  readonly calls: FakeSandboxCall[] = []
  readonly created: SandboxSpec[] = []
  readonly execCalls: Array<{ containerName: string; argv: string[]; options: SandboxExecOptions }> = []

  probe(): Promise<SandboxProbe> {
    this.calls.push({ method: 'probe', args: [] })
    return Promise.resolve(this.probeResult)
  }

  create(spec: SandboxSpec): Promise<SandboxCreateResult> {
    this.calls.push({ method: 'create', args: [spec] })
    this.created.push(spec)
    return Promise.resolve({ containerId: `cid_${spec.containerName}`, containerName: spec.containerName })
  }

  start(containerName: string): Promise<void> {
    this.calls.push({ method: 'start', args: [containerName] })
    return Promise.resolve()
  }

  exec(containerName: string, argv: string[], options: SandboxExecOptions = {}): Promise<RunResult> {
    this.calls.push({ method: 'exec', args: [containerName, argv, options] })
    this.execCalls.push({ containerName, argv, options })
    return Promise.resolve(this.execQueue.shift() ?? okResult(argv))
  }

  status(containerName: string): Promise<SandboxStatus> {
    this.calls.push({ method: 'status', args: [containerName] })
    return Promise.resolve(this.statusResult)
  }

  inspect(containerName: string): Promise<SandboxInspect | null> {
    this.calls.push({ method: 'inspect', args: [containerName] })
    return Promise.resolve(this.inspectResult)
  }

  stop(containerName: string): Promise<void> {
    this.calls.push({ method: 'stop', args: [containerName] })
    return Promise.resolve()
  }

  remove(containerName: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [containerName] })
    return Promise.resolve()
  }

  methods(): string[] {
    return this.calls.map((c) => c.method)
  }
}
