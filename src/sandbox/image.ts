import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxUnavailableError } from '../domain/errors.ts'
import { firstLine, run, type RunOptions, type RunResult } from '../util/exec.ts'
import { stateDir } from '../config/load.ts'
import { DOCKER_UNAVAILABLE_FIX } from './types.ts'

/**
 * Worker image lifecycle (ADR-0004). Building is an explicit, user-initiated
 * provisioning step (`pluton sandbox build-image`); the runtime never builds
 * images behind the operator's back. The built image ID is recorded under
 * `.pluton/state/worker-image.json` so later runs can detect that the image
 * was replaced/rebuild and say so instead of silently running a different one.
 *
 * Everything is argv-based, bounded, and injectable (`runFn`) so unit tests
 * assert the exact docker command lines without a daemon.
 */

export const DEFAULT_WORKER_IMAGE_TAG = 'pluton-worker:local'

const BUILD_TIMEOUT_MS = 20 * 60_000
const INSPECT_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 20_000

/**
 * Image profiles: `base` is the probe/terminal layer (tmux, git, node);
 * `engines` adds the pinned engine CLI (OpenCode) that container-mode
 * supervised runs execute through `docker exec`. Container-mode dispatch
 * requires the `engines` profile; probe-only use accepts `base`.
 */
export type WorkerImageProfile = 'base' | 'engines'

/** Binary names the `engines` profile must provide (Dockerfile layer + build-time proof). */
const ENGINE_BINARIES = ['opencode'] as const

export interface WorkerImageRecord {
  image: string
  /** Immutable image ID (`sha256:...`) captured immediately after the build. */
  imageId: string
  profile: WorkerImageProfile
  tmuxVersion: string
  nodeVersion: string
  builtAt: string
}

export interface WorkerImageProbe {
  present: boolean
  image: string
  imageId: string | null
  /** Record written by `pluton sandbox build-image`, if any. */
  record: WorkerImageRecord | null
  /** True when a record exists AND the current image ID matches it. */
  matchesRecord: boolean
  detail: string
}

export interface WorkerImageOptions {
  dockerBin?: string
  runFn?: (argv: string[], options?: RunOptions) => Promise<RunResult>
}

/** `<root>/.pluton/state/worker-image.json` */
export function workerImageRecordPath(rootDir: string): string {
  return join(stateDir(rootDir), 'worker-image.json')
}

/** The Dockerfile shipped with this Pluton installation (works from src/ and dist/). */
export function workerDockerfileDir(): string {
  return resolve(fileURLToPath(new URL('../../docker/worker', import.meta.url)))
}

function reader(path: string): WorkerImageRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkerImageRecord>
    if (typeof parsed.image === 'string' && typeof parsed.imageId === 'string') {
      return {
        image: parsed.image,
        imageId: parsed.imageId,
        // Legacy records predate profiles: they can only be assumed `base`
        // (fail-closed for container mode, which requires `engines`).
        profile: parsed.profile === 'engines' ? 'engines' : 'base',
        tmuxVersion: typeof parsed.tmuxVersion === 'string' ? parsed.tmuxVersion : 'unknown',
        nodeVersion: typeof parsed.nodeVersion === 'string' ? parsed.nodeVersion : 'unknown',
        builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : 'unknown',
      }
    }
    return null
  } catch {
    return null
  }
}

export function readWorkerImageRecord(rootDir: string): WorkerImageRecord | null {
  return reader(workerImageRecordPath(rootDir))
}

/**
 * Info shown when the local image exists but this project has no build record,
 * so drift cannot be checked. Dispatch is still allowed; with a tag it reads as
 * a standalone sentence for `doctor`.
 */
export function workerImageNoRecordNote(tag?: string): string {
  const subject = tag === undefined ? 'worker image' : `'${tag}'`
  return (
    `${subject} present but not drift-checked in this project (no build record); ` +
    'run `pluton sandbox build-image` to record it (fast when layers are cached)'
  )
}

/** Drift observation with both ids truncated for display. */
export function workerImageDriftNote(recordImageId: string, actualImageId: string): string {
  return `worker image changed since the recorded build (record ${shortId(recordImageId)} vs actual ${shortId(actualImageId)})`
}

/** Remediation for an image that changed since the recorded build. */
export const WORKER_IMAGE_DRIFT_FIX = 're-run `pluton sandbox build-image` or investigate'

/** The rebuild command that produces the profile a caller actually requires. */
function buildImageCommand(requireEngines: boolean): string {
  return requireEngines ? 'pluton sandbox build-image --engines' : 'pluton sandbox build-image'
}

/**
 * Pure dispatch-readiness rule shared by `pluton sandbox probe` and `doctor`.
 * `image` is null when no worker image applies to this sandbox kind
 * (local-process); a failed image probe is a SandboxUnavailableError the caller
 * must report itself — never a null image confused with "not built".
 *
 * `requireEngines: true` is the container-mode gate: supervised runs execute
 * engine CLIs inside the image, so a `base`-profile (or unrecorded, i.e.
 * unprovable) image refuses with the exact `--engines` rebuild command.
 */
export function dispatchReadiness(
  sandboxAvailable: boolean,
  image: WorkerImageProbe | null,
  opts: { requireEngines?: boolean } = {},
): { ready: boolean; warnings: string[] } {
  const requireEngines = opts.requireEngines === true
  const command = buildImageCommand(requireEngines)
  if (!sandboxAvailable) return { ready: false, warnings: [] }
  if (image === null) return { ready: true, warnings: [] }
  if (!image.present) {
    return {
      ready: false,
      warnings: [`worker image '${image.image}' is not built — run \`${command}\` before dispatching tasks`],
    }
  }
  if (image.record === null) {
    if (requireEngines) {
      // Present but unrecorded: the engines layer cannot be proven, and a
      // container-mode run must not guess.
      return {
        ready: false,
        warnings: [
          `worker image '${image.image}' is present but has no build record in this project, so its profile cannot be proven — run \`${command}\` (it records the profile) before a container-mode run`,
        ],
      }
    }
    // Present but unrecorded: usable, drift just cannot be checked here.
    return { ready: true, warnings: [workerImageNoRecordNote()] }
  }
  if (!image.matchesRecord) {
    const fix = requireEngines ? `re-run \`${command}\` or investigate` : WORKER_IMAGE_DRIFT_FIX
    return {
      ready: false,
      warnings: [`${workerImageDriftNote(image.record.imageId, image.imageId ?? 'unknown')} — ${fix}`],
    }
  }
  if (requireEngines && image.record.profile !== 'engines') {
    return {
      ready: false,
      warnings: [
        `worker image '${image.image}' was built with the '${image.record.profile}' profile — container-mode runs need the engine CLIs; run \`${command}\``,
      ],
    }
  }
  return { ready: true, warnings: [] }
}

function shortId(id: string): string {
  return id.length > 19 ? `${id.slice(0, 19)}…` : id
}

export class WorkerImageManager {
  private readonly dockerBin: string
  private readonly runFn: (argv: string[], options?: RunOptions) => Promise<RunResult>

  constructor(opts: WorkerImageOptions = {}) {
    this.dockerBin = opts.dockerBin ?? 'docker'
    this.runFn = opts.runFn ?? run
  }

  private docker(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runFn([this.dockerBin, ...args], options)
  }

  private async assertDaemon(): Promise<void> {
    const r = await this.docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: PROBE_TIMEOUT_MS })
    if (r.exitCode !== 0 || r.stdout.trim() === '') {
      throw new SandboxUnavailableError(
        `docker daemon not reachable: ${firstLine(r.stderr, 200) || 'docker info failed'}`,
        { fix: DOCKER_UNAVAILABLE_FIX, details: { stderr: r.stderr.slice(0, 2_000) } },
      )
    }
  }

  private async imageId(tag: string): Promise<string | null> {
    const r = await this.docker(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: INSPECT_TIMEOUT_MS })
    if (r.exitCode === 0) {
      const id = r.stdout.trim()
      return id === '' ? null : id
    }
    // Only a literal "no such image" means the tag is genuinely absent on this
    // machine. Daemon hiccups, permissions and timeouts must not be reported as
    // "not built" — that would send the operator into a full rebuild.
    if (/no such image/i.test(r.stderr)) return null
    const why = r.timedOut
      ? `inspect timed out after ${INSPECT_TIMEOUT_MS}ms`
      : firstLine(r.stderr, 300) || `docker image inspect failed (exit ${String(r.exitCode)})`
    throw new SandboxUnavailableError(`cannot inspect worker image '${tag}': ${why}`, {
      fix: DOCKER_UNAVAILABLE_FIX,
      details: { tag, exitCode: r.exitCode, stderr: r.stderr.slice(0, 2_000) },
    })
  }

  async probe(rootDir: string, tag = DEFAULT_WORKER_IMAGE_TAG): Promise<WorkerImageProbe> {
    const record = readWorkerImageRecord(rootDir)
    const id = await this.imageId(tag)
    if (id === null) {
      return {
        present: false,
        image: tag,
        imageId: null,
        record,
        matchesRecord: false,
        detail: `image '${tag}' not found locally`,
      }
    }
    const matchesRecord = record !== null && record.imageId === id
    const detail = record === null
      ? `image '${tag}' present (${id.slice(0, 19)}…) but no build record for this project — run \`pluton sandbox build-image\` to record it`
      : matchesRecord
        ? `image '${tag}' present and matches the recorded build (${id.slice(0, 19)}…)`
        : `image '${tag}' has been rebuilt/replaced since the recorded build: recorded ${record.imageId.slice(0, 19)}…, found ${id.slice(0, 19)}…`
    return { present: true, image: tag, imageId: id, record, matchesRecord, detail }
  }

  /**
   * Build the worker image, verify what the profile promises (tmux/node
   * always; the engine CLIs for `engines`), and persist the record. Returns
   * the record (also written to disk).
   */
  async build(
    rootDir: string,
    opts: { tag?: string; dockerfileDir?: string; base?: string; profile?: WorkerImageProfile } = {},
  ): Promise<WorkerImageRecord> {
    const tag = opts.tag ?? DEFAULT_WORKER_IMAGE_TAG
    const profile = opts.profile ?? 'base'
    const contextDir = opts.dockerfileDir ?? workerDockerfileDir()
    await this.assertDaemon()

    const buildArgs = ['build', '-t', tag, '--file', join(contextDir, 'Dockerfile')]
    if (opts.base !== undefined) buildArgs.push('--build-arg', `BASE=${opts.base}`)
    if (profile === 'engines') buildArgs.push('--build-arg', 'PLUTON_ENGINES=1')
    buildArgs.push(contextDir)
    const build = await this.docker(buildArgs, { timeoutMs: BUILD_TIMEOUT_MS })
    if (build.timedOut || build.exitCode !== 0) {
      throw new SandboxUnavailableError(
        `docker build failed for '${tag}' (exit ${String(build.exitCode)}): ${firstLine(build.stderr, 400)}`,
        { details: { tag, stderr: build.stderr.slice(0, 4_000) } },
      )
    }

    const id = await this.imageId(tag)
    if (id === null) {
      throw new SandboxUnavailableError(`docker build produced no inspectable image '${tag}'`)
    }

    const tmux = await this.docker(
      ['run', '--rm', '--network', 'none', '--entrypoint', 'tmux', tag, '-V'],
      { timeoutMs: INSPECT_TIMEOUT_MS },
    )
    if (tmux.exitCode !== 0 || tmux.stdout.trim() === '') {
      throw new SandboxUnavailableError(
        `worker image '${tag}' does not provide tmux (exit ${String(tmux.exitCode)}): ${firstLine(tmux.stderr, 200)}`,
        { details: { tag, imageId: id, stderr: tmux.stderr.slice(0, 2_000) } },
      )
    }
    const node = await this.docker(['run', '--rm', '--entrypoint', 'node', tag, '--version'], { timeoutMs: INSPECT_TIMEOUT_MS })

    if (profile === 'engines') {
      // The engines profile promises executable CLIs, not just layers: prove
      // them by running them (a missing binary must never reach a live run).
      for (const engine of ENGINE_BINARIES) {
        const r = await this.docker(
          ['run', '--rm', '--network', 'none', '--entrypoint', engine, tag, '--version'],
          { timeoutMs: INSPECT_TIMEOUT_MS },
        )
        if (r.exitCode !== 0 || r.stdout.trim() === '') {
          throw new SandboxUnavailableError(
            `worker image '${tag}' does not provide the engine binary '${engine}' (exit ${String(r.exitCode)}): ${firstLine(r.stderr, 200)}`,
            { details: { tag, imageId: id, engine, stderr: r.stderr.slice(0, 2_000) } },
          )
        }
      }
    }

    const record: WorkerImageRecord = {
      image: tag,
      imageId: id,
      profile,
      tmuxVersion: firstLine(tmux.stdout, 120),
      nodeVersion: firstLine(node.stdout, 120) || 'unknown',
      builtAt: new Date().toISOString(),
    }
    const recordPath = workerImageRecordPath(rootDir)
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return record
  }
}
