import { PolicyDeniedError, SandboxUnavailableError, ValidationError } from '../domain/errors.ts'
import { firstLine, run, type RunOptions, type RunResult } from '../util/exec.ts'
import { expectedContainerNetworks } from './network.ts'
import {
  DOCKER_UNAVAILABLE_FIX,
  SANDBOX_LABEL_MANAGED,
  SANDBOX_LABEL_SHIP,
  SANDBOX_LABEL_PROJECT,
  type SandboxCreateResult,
  type SandboxExecOptions,
  type SandboxInspect,
  type SandboxManager,
  type SandboxManagerOptions,
  type SandboxProbe,
  type SandboxSpec,
  type SandboxStatus,
} from './types.ts'

/**
 * Docker sandbox (ADR-0004). Every docker invocation is an argument array.
 *
 * Hardening encoded in one place: non-root user, `--cap-drop ALL`,
 * `no-new-privileges`, PID/memory/CPU limits, bounded noexec tmpfs, explicit
 * env allowlist, mounts only as specified by the caller, and a network choice
 * that cannot silently leave egress open — `none` for a hermetic box,
 * `restricted` only on a dedicated `--internal` network, `open` on `bridge`
 * (or the configured network). See src/sandbox/network.ts.
 *
 * Lifecycle safety: stop/remove first re-read the container's Pluton labels —
 * a container that Pluton did not create (or that was replaced) is never
 * stopped or deleted by this code path.
 */

const PROBE_TIMEOUT_MS = 20_000
const CREATE_TIMEOUT_MS = 120_000
const INSPECT_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 30_000
const TMPFS = '/tmp:rw,noexec,nosuid,size=256m'

export class DockerSandboxManager implements SandboxManager {
  readonly kind = 'docker' as const
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>
  private readonly dockerBin: string

  constructor(opts: SandboxManagerOptions = {}) {
    this.runFn = opts.runFn ?? run
    this.dockerBin = opts.dockerBin ?? 'docker'
  }

  private docker(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runFn([this.dockerBin, ...args], options)
  }

  async probe(): Promise<SandboxProbe> {
    const r = await this.docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: PROBE_TIMEOUT_MS })
    if (r.exitCode === 0 && r.stdout.trim() !== '') {
      return { available: true, kind: this.kind, detail: `docker server ${r.stdout.trim()}` }
    }
    const why = r.timedOut ? `probe timed out after ${PROBE_TIMEOUT_MS}ms` : firstLine(r.stderr, 300) || 'docker info failed'
    return { available: false, kind: this.kind, detail: `docker daemon not reachable: ${why}`, fix: DOCKER_UNAVAILABLE_FIX }
  }

  private async assertAvailable(): Promise<void> {
    const probe = await this.probe()
    if (!probe.available) {
      throw new SandboxUnavailableError(`cannot start sandbox: ${probe.detail}`, { fix: probe.fix })
    }
  }

  /**
   * Ensure a dedicated internal network exists. An existing network is only
   * accepted when Docker reports `Internal=true`: reusing a normal bridge
   * network would silently restore full egress under a `restricted` label.
   */
  async ensureInternalNetwork(name: string): Promise<'created' | 'existing'> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
      throw new ValidationError(`invalid docker network name '${name}'`, { details: { network: name } })
    }
    const inspectArgs = ['network', 'inspect', '--format', '{{.Internal}}', name]
    const existing = await this.docker(inspectArgs, { timeoutMs: NETWORK_TIMEOUT_MS })
    if (existing.exitCode === 0) {
      if (existing.stdout.trim() !== 'true') {
        throw new PolicyDeniedError(
          `refusing network policy "restricted": network '${name}' exists but is not internal ` +
            '(Docker reports Internal=false, so containers on it can reach the internet)',
          { network: name, fix: 'delete the network or set runtime.internal_network_name to an --internal network' },
        )
      }
      return 'existing'
    }
    if (!/no such network/i.test(existing.stderr)) {
      throw new SandboxUnavailableError(
        `cannot inspect docker network '${name}': ${firstLine(existing.stderr, 300) || 'unknown error'}`,
        { fix: DOCKER_UNAVAILABLE_FIX, details: { network: name } },
      )
    }

    const created = await this.docker(
      [
        'network',
        'create',
        '--driver',
        'bridge',
        '--internal',
        '--label',
        `${SANDBOX_LABEL_MANAGED}=true`,
        '--label',
        'io.pluton.network=restricted',
        name,
      ],
      { timeoutMs: NETWORK_TIMEOUT_MS },
    )
    if (created.exitCode === 0) return 'created'
    if (/already exists/i.test(created.stderr)) {
      const recheck = await this.docker(inspectArgs, { timeoutMs: NETWORK_TIMEOUT_MS })
      if (recheck.exitCode === 0 && recheck.stdout.trim() === 'true') return 'existing'
      throw new PolicyDeniedError(
        `refusing network policy "restricted": concurrently created network '${name}' is not internal`,
        { network: name },
      )
    }
    throw new SandboxUnavailableError(
      `docker network create failed for '${name}' (exit ${String(created.exitCode)}): ${firstLine(created.stderr, 300)}`,
      { fix: DOCKER_UNAVAILABLE_FIX, details: { network: name, stderr: created.stderr.slice(0, 2_000) } },
    )
  }

  /** The exact `docker create` argument vector — kept pure for conformance tests. */
  static buildCreateArgs(spec: SandboxSpec): string[] {
    DockerSandboxManager.validateSpec(spec)
    const [network] = expectedContainerNetworks(spec)
    const shipId = spec.shipId ?? spec.museId ?? ''
    const args = [
      'create',
      '--name',
      spec.containerName,
      '--label',
      `${SANDBOX_LABEL_MANAGED}=true`,
      '--label',
      `${SANDBOX_LABEL_PROJECT}=${spec.projectId}`,
      '--label',
      `${SANDBOX_LABEL_SHIP}=${shipId}`,
      '--label',
      `io.pluton.muse=${shipId}`,
      '--user',
      spec.containerUser,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(spec.limits.pids),
      '--memory',
      `${spec.limits.memoryMb}m`,
      '--cpus',
      String(spec.limits.cpus),
      '--tmpfs',
      TMPFS,
      '--network',
      network,
    ]
    for (const host of spec.extraHosts ?? []) {
      args.push('--add-host', host)
    }
    for (const mount of spec.mounts) {
      args.push('--mount', `type=bind,src=${mount.hostPath},dst=${mount.containerPath}${mount.readOnly ? ',readonly' : ''}`)
    }
    for (const [key, value] of Object.entries(spec.env)) {
      args.push('--env', `${key}=${value}`)
    }
    args.push(spec.image, 'sleep', 'infinity')
    return args
  }

  /**
   * The argv builder is the last line of defense for ADR-0004's baseline: a
   * typo must not silently strip hardening (`--user root`, `--pids-limit 0`,
   * `--memory 0m` and `--cpus 0` all mean UNLIMITED to the docker CLI), and a
   * `,`/`=` in a mount path would change docker's CSV mount parsing.
   */
  private static validateSpec(spec: SandboxSpec): void {
    if (!/^\d+(:\d+)?$/.test(spec.containerUser) || spec.containerUser === '0' || spec.containerUser.startsWith('0:')) {
      throw new ValidationError(
        `containerUser must be a numeric non-root user (uid or uid:gid), got '${spec.containerUser}'`,
        { details: { containerUser: spec.containerUser } },
      )
    }
    const { cpus, memoryMb, pids } = spec.limits
    if (!Number.isInteger(memoryMb) || memoryMb < 1) {
      throw new ValidationError(`sandbox memoryMb must be an integer >= 1 (docker treats 0 as unlimited), got ${String(memoryMb)}`)
    }
    if (!Number.isInteger(pids) || pids < 1) {
      throw new ValidationError(`sandbox pids limit must be an integer >= 1 (docker treats 0 as unlimited), got ${String(pids)}`)
    }
    if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0) {
      throw new ValidationError(`sandbox cpus must be a finite number > 0 (docker treats 0 as unlimited), got ${String(cpus)}`)
    }
    if (spec.customNetwork !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.customNetwork)) {
      throw new ValidationError(
        `customNetwork must be a valid docker network name, got '${spec.customNetwork}'`,
        { details: { customNetwork: spec.customNetwork } },
      )
    }
    for (const mount of spec.mounts) {
      const absoluteHost = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(mount.hostPath)
      if (!absoluteHost || /[,=]/.test(mount.hostPath)) {
        throw new ValidationError(
          `mount hostPath must be an absolute path without ',' or '=', got '${mount.hostPath}'`,
          { details: { hostPath: mount.hostPath } },
        )
      }
      if (!mount.containerPath.startsWith('/') || /[,=]/.test(mount.containerPath)) {
        throw new ValidationError(
          `mount containerPath must be an absolute Linux path without ',' or '=', got '${mount.containerPath}'`,
          { details: { containerPath: mount.containerPath } },
        )
      }
    }
    for (const host of spec.extraHosts ?? []) {
      if (host === '' || !host.includes(':') || /[\s,=]/.test(host)) {
        throw new ValidationError(`extraHosts entries must be a 'name:ip' mapping without whitespace/','/'=', got '${host}'`, {
          details: { extraHost: host },
        })
      }
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxCreateResult> {
    await this.assertAvailable()
    const r = await this.docker(DockerSandboxManager.buildCreateArgs(spec), { timeoutMs: CREATE_TIMEOUT_MS })
    if (r.timedOut || r.exitCode !== 0) {
      throw new SandboxUnavailableError(
        `docker create failed for '${spec.containerName}' (exit ${String(r.exitCode)}): ${firstLine(r.stderr, 300)}`,
        { details: { containerName: spec.containerName, stderr: r.stderr.slice(0, 2_000) } },
      )
    }
    const containerId = r.stdout.trim()
    if (containerId === '') {
      throw new SandboxUnavailableError(`docker create for '${spec.containerName}' returned no container id`)
    }
    return { containerId, containerName: spec.containerName }
  }

  async start(containerName: string): Promise<void> {
    await this.assertManaged(containerName)
    const r = await this.docker(['start', containerName], { timeoutMs: STOP_TIMEOUT_MS })
    if (r.exitCode !== 0 || r.timedOut) {
      throw new SandboxUnavailableError(
        `docker start failed for '${containerName}': ${firstLine(r.stderr, 300)}`,
        { details: { containerName } },
      )
    }
  }

  async exec(containerName: string, argv: string[], options: SandboxExecOptions = {}): Promise<RunResult> {
    if (argv.length === 0) throw new SandboxUnavailableError('sandbox exec requires a non-empty argv')
    const args = ['exec']
    if (options.input !== undefined) args.push('-i')
    if (options.cwd !== undefined) args.push('-w', options.cwd)
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('-e', `${key}=${value}`)
    args.push(containerName, ...argv)
    return this.docker(args, {
      timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: options.maxOutputBytes,
      input: options.input,
    })
  }

  async status(containerName: string): Promise<SandboxStatus> {
    const r = await this.docker(['inspect', '--format', '{{.State.Status}}', containerName], {
      timeoutMs: INSPECT_TIMEOUT_MS,
    })
    if (r.exitCode !== 0) {
      return /no such (object|container)/i.test(r.stderr) ? 'missing' : 'unknown'
    }
    const state = r.stdout.trim()
    if (state === 'running') return 'running'
    if (state === 'created' || state === 'exited' || state === 'paused' || state === 'dead') return 'stopped'
    return 'unknown'
  }

  /**
   * Container facts for reuse validation. The whole read is one `docker
   * inspect`; a failure or unparsable output throws (fail loud) — stale
   * detection must never silently degrade to "assume valid".
   */
  async inspect(containerName: string): Promise<SandboxInspect | null> {
    const r = await this.docker(
      [
        'inspect',
        '--format',
        '{{.Image}}|{{.Config.User}}|{{json .HostConfig.ExtraHosts}}|{{json .Mounts}}|{{json .NetworkSettings.Networks}}',
        containerName,
      ],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    )
    if (r.timedOut || r.exitCode !== 0) {
      throw new SandboxUnavailableError(
        `container '${containerName}' cannot be inspected: ${r.timedOut ? `timed out after ${INSPECT_TIMEOUT_MS}ms` : firstLine(r.stderr, 200)}`,
        { details: { containerName } },
      )
    }
    const [imageId = '', user = '', extraHostsJson = '[]', mountsJson = '[]', networksJson = '{}'] = r.stdout
      .trim()
      .split('|')
    if (imageId === '') {
      throw new SandboxUnavailableError(`container '${containerName}' inspect returned no image id`, {
        details: { containerName },
      })
    }
    let extraHosts: unknown
    let mounts: unknown
    let networks: unknown
    try {
      extraHosts = JSON.parse(extraHostsJson)
      mounts = JSON.parse(mountsJson)
      networks = JSON.parse(networksJson)
    } catch {
      throw new SandboxUnavailableError(`container '${containerName}' inspect output could not be parsed`, {
        details: { containerName, stdout: r.stdout.slice(0, 500) },
      })
    }
    return {
      imageId,
      user,
      extraHosts: Array.isArray(extraHosts) ? extraHosts.filter((h): h is string => typeof h === 'string') : [],
      mounts: Array.isArray(mounts)
        ? mounts
            .map((m) => (m !== null && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
            .map((m) => ({
              destination: typeof m['Destination'] === 'string' ? m['Destination'] : '',
              readOnly: m['RW'] === false,
            }))
            .filter((m) => m.destination !== '')
        : [],
      networks:
        networks !== null && typeof networks === 'object' && !Array.isArray(networks)
          ? Object.keys(networks as Record<string, unknown>)
          : [],
    }
  }

  /** Read back the managed label; refuse to act on anything Pluton did not create. */
  private async assertManaged(containerName: string): Promise<void> {
    const r = await this.docker(
      ['inspect', '--format', `{{index .Config.Labels "${SANDBOX_LABEL_MANAGED}"}}`, containerName],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    )
    if (r.exitCode !== 0) {
      throw new SandboxUnavailableError(`container '${containerName}' cannot be inspected: ${firstLine(r.stderr, 200)}`, {
        details: { containerName },
      })
    }
    if (r.stdout.trim() !== 'true') {
      throw new PolicyDeniedError(
        `refusing to act on container '${containerName}': it does not carry the Pluton managed label (only Pluton-created containers may be stopped or removed)`,
        { containerName },
      )
    }
  }

  async stop(containerName: string): Promise<void> {
    await this.assertManaged(containerName)
    const r = await this.docker(['stop', '--time', '10', containerName], { timeoutMs: STOP_TIMEOUT_MS })
    if (r.exitCode !== 0 && !/is not running/i.test(r.stderr)) {
      throw new SandboxUnavailableError(`docker stop failed for '${containerName}': ${firstLine(r.stderr, 300)}`)
    }
  }

  async remove(containerName: string): Promise<void> {
    await this.assertManaged(containerName)
    const r = await this.docker(['rm', '--force', containerName], { timeoutMs: STOP_TIMEOUT_MS })
    if (r.exitCode !== 0 && !/no such (object|container)/i.test(r.stderr)) {
      throw new SandboxUnavailableError(`docker rm failed for '${containerName}': ${firstLine(r.stderr, 300)}`)
    }
  }
}
