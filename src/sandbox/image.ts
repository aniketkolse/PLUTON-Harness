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

export interface WorkerImageRecord {
  image: string
  /** Immutable image ID (`sha256:...`) captured immediately after the build. */
  imageId: string
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
    if (r.exitCode !== 0) return null
    const id = r.stdout.trim()
    return id === '' ? null : id
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
   * Build the worker image, verify it actually contains tmux/node by running
   * them, and persist the record. Returns the record (also written to disk).
   */
  async build(
    rootDir: string,
    opts: { tag?: string; dockerfileDir?: string; base?: string } = {},
  ): Promise<WorkerImageRecord> {
    const tag = opts.tag ?? DEFAULT_WORKER_IMAGE_TAG
    const contextDir = opts.dockerfileDir ?? workerDockerfileDir()
    await this.assertDaemon()

    const buildArgs = ['build', '-t', tag, '--file', join(contextDir, 'Dockerfile')]
    if (opts.base !== undefined) buildArgs.push('--build-arg', `BASE=${opts.base}`)
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

    const tmux = await this.docker(['run', '--rm', '--entrypoint', 'tmux', tag, '-V'], { timeoutMs: INSPECT_TIMEOUT_MS })
    if (tmux.exitCode !== 0 || tmux.stdout.trim() === '') {
      throw new SandboxUnavailableError(
        `worker image '${tag}' does not provide tmux (exit ${String(tmux.exitCode)}): ${firstLine(tmux.stderr, 200)}`,
        { details: { tag, imageId: id, stderr: tmux.stderr.slice(0, 2_000) } },
      )
    }
    const node = await this.docker(['run', '--rm', '--entrypoint', 'node', tag, '--version'], { timeoutMs: INSPECT_TIMEOUT_MS })

    const record: WorkerImageRecord = {
      image: tag,
      imageId: id,
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
