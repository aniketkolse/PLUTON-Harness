import type { RunOptions, RunResult } from '../util/exec.ts'
import { ValidationError } from '../domain/errors.ts'
import { slugify } from '../domain/ids.ts'

/**
 * Sandbox contract (ADR-0004). One long-lived container per Muse; all four
 * managers share this interface so the runtime can be tested with a fake and
 * the dev-only `local-process` degraded mode is an explicit, acknowledged
 * choice — never a silent fallback.
 */

export interface SandboxMount {
  /** Absolute host path (validated by the caller to be Pluton-owned). */
  hostPath: string
  containerPath: string
  readOnly?: boolean
}

export interface SandboxLimits {
  cpus: number
  memoryMb: number
  pids: number
}

export interface SandboxSpec {
  projectId: string
  museId: string | null
  image: string
  /** Sanitized name, see sandboxContainerName(). */
  containerName: string
  /** Passed to `docker --user`, e.g. '10001:10001'. */
  containerUser: string
  limits: SandboxLimits
  mounts: SandboxMount[]
  /** Explicit allowlist only — never host env passthrough (ADR-0004/0008). */
  env: Record<string, string>
  network: 'restricted' | 'none' | 'open'
}

export interface SandboxProbe {
  available: boolean
  kind: SandboxManager['kind']
  /** Human detail (server version, or why it is unavailable). */
  detail: string
  /** Exact remediation when unavailable. */
  fix?: string
}

export interface SandboxCreateResult {
  containerId: string
  containerName: string
}

export type SandboxStatus = 'running' | 'stopped' | 'missing' | 'unknown'

export interface SandboxExecOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Written to the process's stdin then closed (MCP stdio, interactive tools). */
  input?: string
  maxOutputBytes?: number
}

export interface SandboxManager {
  readonly kind: 'docker' | 'local-process'
  /** Honest readiness check; never throws — callers decide with the result. */
  probe(): Promise<SandboxProbe>
  create(spec: SandboxSpec): Promise<SandboxCreateResult>
  start(containerName: string): Promise<void>
  exec(containerName: string, argv: string[], options?: SandboxExecOptions): Promise<RunResult>
  status(containerName: string): Promise<SandboxStatus>
  stop(containerName: string): Promise<void>
  remove(containerName: string): Promise<void>
}

export const SANDBOX_LABEL_MANAGED = 'io.pluton.managed'
export const SANDBOX_LABEL_PROJECT = 'io.pluton.project'
export const SANDBOX_LABEL_MUSE = 'io.pluton.muse'

export const DOCKER_UNAVAILABLE_FIX =
  'start Docker Desktop (or the docker engine), confirm `docker info` works, and re-run `pluton doctor`'

/** `pluton-<project>-<muse>`, sanitized and length-checked (Docker name limit is 255; we stay well under). */
export function sandboxContainerName(projectName: string, museId: string): string {
  const name = `pluton-${slugify(projectName)}-${slugify(museId)}`.slice(0, 63).replace(/-+$/, '')
  if (name.length < 7) throw new ValidationError(`cannot derive a container name from '${projectName}'/'${museId}'`)
  return name
}

export interface SandboxManagerOptions {
  /** Injection for tests: replaces the bounded subprocess runner. */
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult>
  /** docker executable name (default 'docker'). */
  dockerBin?: string
}
