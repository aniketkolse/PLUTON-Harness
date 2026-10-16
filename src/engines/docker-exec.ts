import { ValidationError } from '../domain/errors.ts'
import { defaultSpawn, type AcpSpawnFn } from './acp/client.ts'

/**
 * `docker exec` ACP spawn seam (Phase B / ADR-0004, ADR-0008): a container-mode
 * engine session is the engine CLI's stdio tunneled through the docker CLI's
 * stdio (`docker exec -i`), so the ACP transport runs unmodified.
 *
 * Environment policy:
 * - the container-side env crosses as `-e NAME` pass-through only; values ride
 *   in the spawned docker CLI's own environment, never in argv — argv is
 *   world-readable (`/proc/<pid>/cmdline`) and must never carry secrets;
 * - env values that are paths under a declared mount are rewritten to their
 *   container paths (a session HOME pointing at the host engine home);
 * - host-shaped platform variables (PATH, SystemRoot, APPDATA, ...) never
 *   override the container's own values — the image ships its own PATH, and a
 *   host `PATH` inside the container would break binary resolution;
 * - the docker CLI itself still runs with host essentials plus the docker
 *   client connection variables (DOCKER_HOST/CONTEXT/TLS...), so a non-default
 *   daemon context behaves the same as it does for probe/create/start.
 */

export interface DockerExecContext {
  containerName: string
  /** Host → container path pairs; the longest matching prefix wins. */
  mounts: { hostPath: string; containerPath: string }[]
  /** Run-level env merged under the per-session env (the session wins on collisions). */
  env: Record<string, string>
}

/** Platform variables whose host-shaped values must never cross into the container. */
const HOST_ONLY_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'Path',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'windir',
  'WINDIR',
  'SystemDrive',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
])

/** Variables the spawned docker CLI itself needs to run on the host. */
const DOCKER_CLI_ENV_KEYS: readonly string[] = [
  'PATH',
  'Path',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'WINDIR',
  'PATHEXT',
  'TEMP',
  'TMP',
  'ComSpec',
  'HOME',
  'USERPROFILE',
]

/**
 * Lexical normalization: forward slashes, no trailing slash, and `.`/`..`
 * segments collapsed. Collapsing is deliberate — a `..` inside a value must
 * either resolve to a genuine subpath of some mount or fail to match, never
 * map outside the mount it started in.
 */
function normalizePath(path: string): string {
  const forward = path.replace(/\\/g, '/')
  const absolute = forward.startsWith('/')
  const segments: string[] = []
  for (const segment of forward.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = segments[segments.length - 1]
      if (last !== undefined && last !== '..') segments.pop()
      else if (!absolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`
}

/** Longest-prefix host→container mapping, or null when the path is not under any mount. */
function tryMapPath(path: string, mounts: DockerExecContext['mounts']): string | null {
  const normalized = normalizePath(path)
  let best: { prefix: string; containerPath: string } | null = null
  for (const mount of mounts) {
    const prefix = normalizePath(mount.hostPath)
    if (prefix === '') continue
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) continue
    if (best === null || prefix.length > best.prefix.length) {
      best = { prefix, containerPath: normalizePath(mount.containerPath) }
    }
  }
  if (best === null) return null
  return `${best.containerPath}${normalized.slice(best.prefix.length)}`
}

/**
 * Map a host path to its container path. Throws `ValidationError` when the
 * path is not under any mount — an unmapped working directory means the
 * container could never run there, so this fails loudly instead of guessing.
 */
export function mapHostPathToContainer(path: string, mounts: DockerExecContext['mounts']): string {
  const mapped = tryMapPath(path, mounts)
  if (mapped === null) {
    const known = mounts.map((m) => m.hostPath).join(', ') || '(no mounts)'
    throw new ValidationError(`path '${path}' is not under any mounted host path (${known})`, {
      details: { path, mounts: mounts.map((m) => m.hostPath) },
    })
  }
  return mapped
}

function dockerCliBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of DOCKER_CLI_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) base[key] = value
  }
  // The CLI must reach the same daemon probe/create/start talked to: a
  // non-default context (DOCKER_HOST/DOCKER_CONTEXT/DOCKER_TLS_VERIFY/...)
  // lives in the host environment and is harmless inside the container
  // namespace (never forwarded — only names explicitly in containerEnv are).
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DOCKER_') && value !== undefined) base[key] = value
  }
  return base
}

/**
 * Build the `AcpSpawnFn` for one Muse container. The returned function spawns
 * `docker exec` with the engine command; the spawn's cwd/env describe the
 * docker CLI on the host, while the argv describes the command inside the
 * container.
 */
export function dockerExecSpawn(ctx: DockerExecContext, spawnFn: AcpSpawnFn = defaultSpawn): AcpSpawnFn {
  return (command, args, options) => {
    const cwd = mapHostPathToContainer(options.cwd, ctx.mounts)
    const merged = { ...ctx.env, ...options.env }
    const containerEnv: Record<string, string> = {}
    for (const [name, value] of Object.entries(merged)) {
      if (HOST_ONLY_ENV_KEYS.has(name)) continue
      containerEnv[name] = tryMapPath(value, ctx.mounts) ?? value
    }
    const argv = ['exec', '-i', '-w', cwd]
    for (const name of Object.keys(containerEnv)) argv.push('-e', name)
    argv.push(ctx.containerName, command, ...args)
    return spawnFn('docker', argv, {
      cwd: options.cwd,
      env: { ...dockerCliBaseEnv(), ...containerEnv },
      windowsHide: true,
    })
  }
}
