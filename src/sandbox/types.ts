import type { RunOptions, RunResult } from '../util/exec.ts'
import { ValidationError } from '../domain/errors.ts'
import { createHash } from 'node:crypto'
import { slugify } from '../domain/ids.ts'

/**
 * Sandbox contract (ADR-0004). One long-lived container per Ship; all four
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
  shipId?: string | null
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string | null
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
  /** Custom Docker network identifier (e.g. internal network name); applied when network is not 'none'. */
  customNetwork?: string
  /** Extra `/etc/hosts` entries as `name:ip` (e.g. the host gateway); validated by the docker manager. */
  extraHosts?: string[]
}

export interface SandboxProbe {
  available: boolean
  /** 'native' is reported by the host execution provider (no container exists). */
  kind: SandboxManager['kind'] | 'native'
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

/** Container facts read back for reuse validation (docker inspect). */
export interface SandboxInspect {
  /** Image ID the container was created from (sha256:…). */
  imageId: string
  /** Configured container user (`Config.User`), e.g. '10001:10001'. */
  user: string
  /** Destination mount points with their read-only flag. */
  mounts: { destination: string; readOnly: boolean }[]
  /** Extra host mappings from the create config (e.g. 'host.docker.internal:host-gateway'). */
  extraHosts: string[]
  /** Docker networks the container is attached to (`.NetworkSettings.Networks` keys). */
  networks: string[]
}

export interface SandboxManager {
  readonly kind: 'docker' | 'local-process'
  /** Honest readiness check; never throws — callers decide with the result. */
  probe(): Promise<SandboxProbe>
  create(spec: SandboxSpec): Promise<SandboxCreateResult>
  start(containerName: string): Promise<void>
  exec(containerName: string, argv: string[], options?: SandboxExecOptions): Promise<RunResult>
  status(containerName: string): Promise<SandboxStatus>
  /**
   * Read back container facts for reuse validation. Returns null only for
   * managers without a container concept (local-process); a docker-like
   * manager returns real facts or throws — never null-as-valid.
   */
  inspect(containerName: string): Promise<SandboxInspect | null>
  /**
   * Docker-like managers only: ensure a dedicated `--internal` network exists
   * (creating it when missing) and refuse an existing non-internal network.
   * Managers that cannot enforce egress isolation omit this method, which makes
   * `network_policy: restricted` fail closed for them.
   */
  ensureInternalNetwork?(name: string): Promise<'created' | 'existing'>
  stop(containerName: string): Promise<void>
  remove(containerName: string): Promise<void>
}

export const SANDBOX_LABEL_MANAGED = 'io.pluton.managed'
export const SANDBOX_LABEL_PROJECT = 'io.pluton.project'
/** Canonical Ship label (replaces `Muse` terminology); value unchanged for backward compatibility with existing containers. */
export const SANDBOX_LABEL_SHIP = 'io.pluton.ship'
/** @deprecated Use `SANDBOX_LABEL_SHIP`; kept for backward-compatible label lookups. */
export const SANDBOX_LABEL_MUSE = SANDBOX_LABEL_SHIP

export const DOCKER_UNAVAILABLE_FIX =
  'start Docker Desktop (or the docker engine), confirm `docker info` works, and re-run `pluton doctor`'

/**
 * `pluton-<project>-<ship>`, sanitized, ≤ 63 chars. When the joined slug would
 * exceed the cap, the HEAD is truncated and a short hash of the full identity
 * is appended — a length cap must never let two Ships share one container name
 * (stop/remove are name-targeted and would otherwise act on the wrong Ship).
 */
export function sandboxContainerName(projectName: string, shipId: string): string {
  const base = `pluton-${slugify(projectName)}-${slugify(shipId)}`
  if (base.length <= 63) {
    const name = base.replace(/-+$/, '')
    if (name.length < 7) throw new ValidationError(`cannot derive a container name from '${projectName}'/'${shipId}'`)
    return name
  }
  const hash = createHash('sha1').update(`${projectName}\u0000${shipId}`).digest('hex').slice(0, 6)
  return `${base.slice(0, 56).replace(/-+$/, '')}-${hash}`
}

export interface SandboxManagerOptions {
  /** Injection for tests: replaces the bounded subprocess runner. */
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult>
  /** docker executable name (default 'docker'). */
  dockerBin?: string
}
