import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxUnavailableError } from '../../src/domain/errors.ts'
import type { RunOptions, RunResult } from '../../src/util/exec.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  dispatchReadiness,
  readWorkerImageRecord,
  workerDockerfileDir,
  workerImageRecordPath,
  WorkerImageManager,
  type WorkerImageProbe,
  type WorkerImageRecord,
} from '../../src/sandbox/image.ts'
import { failResult, okResult } from '../helpers/fake-sandbox.ts'

/**
 * Worker-image lifecycle conformance: exact docker argv on a scripted runner.
 * The real build (network + daemon) is exercised only by the gated E2E suite.
 */

const tmpDirs: string[] = []

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-image-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Rule {
  label: string
  match: (argv: string[]) => boolean
  result: (argv: string[]) => RunResult
}

function scripted(rules: Rule[]): { runFn: (argv: string[], o?: RunOptions) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = []
  const runFn = (argv: string[]): Promise<RunResult> => {
    calls.push(argv)
    const rule = rules.find((r) => r.match(argv))
    if (!rule) return Promise.resolve(failResult(argv, `unscripted command: ${argv.join(' ')}`, 1))
    return Promise.resolve(rule.result(argv))
  }
  return { runFn, calls }
}

const isInfo = (argv: string[]): boolean => argv[1] === 'info'
const isInspect = (argv: string[]): boolean => argv[1] === 'image' && argv[2] === 'inspect'
const isBuild = (argv: string[]): boolean => argv[1] === 'build'
const isTmuxRun = (argv: string[]): boolean => argv[1] === 'run' && argv.includes('tmux')
const isNodeRun = (argv: string[]): boolean => argv[1] === 'run' && argv.includes('node')
/** `docker run ... --entrypoint <name> <tag> ...` for a named binary. */
const isEntrypointRun = (argv: string[], name: string): boolean =>
  argv[1] === 'run' && argv[argv.indexOf('--entrypoint') + 1] === name

function happyRules(id = 'sha256:def456'): Rule[] {
  return [
    { label: 'info', match: isInfo, result: (argv) => okResult(argv, '27.0.0\n') },
    { label: 'build', match: isBuild, result: (argv) => okResult(argv, 'Successfully built\n') },
    { label: 'inspect', match: isInspect, result: (argv) => okResult(argv, `${id}\n`) },
    { label: 'tmux', match: isTmuxRun, result: (argv) => okResult(argv, 'tmux 3.3a\n') },
    { label: 'node', match: isNodeRun, result: (argv) => okResult(argv, 'v24.0.0\n') },
  ]
}

describe('worker image build', () => {
  it('ships a Dockerfile that exists in this installation', () => {
    expect(existsSync(join(workerDockerfileDir(), 'Dockerfile'))).toBe(true)
  })

  it('builds with an exact argv, verifies tmux/node, and records the image id', async () => {
    const root = tmpRoot()
    const dockerfileDir = workerDockerfileDir()
    const { runFn, calls } = scripted(happyRules())
    const mgr = new WorkerImageManager({ runFn })

    const record = await mgr.build(root, { tag: 'pluton-worker:test' })
    expect(record).toEqual({
      image: 'pluton-worker:test',
      imageId: 'sha256:def456',
      profile: 'base',
      tmuxVersion: 'tmux 3.3a',
      nodeVersion: 'v24.0.0',
      builtAt: expect.any(String),
    })
    expect(calls[1]).toEqual(['docker', 'build', '-t', 'pluton-worker:test', '--file', join(dockerfileDir, 'Dockerfile'), dockerfileDir])
    expect(calls[3]).toEqual(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'tmux', 'pluton-worker:test', '-V'])
    expect(calls[4]).toEqual(['docker', 'run', '--rm', '--entrypoint', 'node', 'pluton-worker:test', '--version'])

    // Persisted and readable
    const path = workerImageRecordPath(root)
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)
    expect(readWorkerImageRecord(root)).toEqual(record)
  })

  it('builds the engines profile with the pinned engine layer, verifies both binaries, and records the profile', async () => {
    const root = tmpRoot()
    const dockerfileDir = workerDockerfileDir()
    const { runFn, calls } = scripted([
      ...happyRules(),
      { label: 'opencode', match: (argv) => isEntrypointRun(argv, 'opencode'), result: (argv) => okResult(argv, '2.0.31\n') },
      { label: 'qwen', match: (argv: string[]) => isEntrypointRun(argv, 'qwen'), result: (argv: string[]) => okResult(argv, '0.25.2\n') },
    ])
    const record = await new WorkerImageManager({ runFn }).build(root, { tag: 'pluton-worker:test', profile: 'engines' })
    expect(record.profile).toBe('engines')
    expect(calls[1]).toEqual([
      'docker',
      'build',
      '-t',
      'pluton-worker:test',
      '--file',
      join(dockerfileDir, 'Dockerfile'),
      '--build-arg',
      'PLUTON_ENGINES=1',
      dockerfileDir,
    ])
    // Both engine binaries are proven by running them inside the built image.
    const entrypoints = calls.filter((c) => c[1] === 'run').map((c) => c[c.indexOf('--entrypoint') + 1])
    expect(entrypoints).toEqual(expect.arrayContaining(['opencode', 'qwen']))
    expect(readWorkerImageRecord(root)?.profile).toBe('engines')
  })

  it('refuses an engines-profile image whose engine binary is missing, writing no record', async () => {
    const root = tmpRoot()
    const rules = [
      ...happyRules(),
      {
        label: 'opencode',
        match: (argv: string[]) => isEntrypointRun(argv, 'opencode'),
        result: (argv: string[]) => failResult(argv, 'opencode: executable file not found in $PATH', 127),
      },
      { label: 'qwen', match: (argv: string[]) => isEntrypointRun(argv, 'qwen'), result: (argv: string[]) => okResult(argv, '0.25.2\n') },
    ]
    const err = await new WorkerImageManager({ runFn: scripted(rules).runFn }).build(root, { profile: 'engines' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain('opencode')
    expect(readWorkerImageRecord(root)).toBeNull()
  })

  it('adds an explicit --build-arg BASE when a base image is pinned', async () => {
    const root = tmpRoot()
    const { runFn, calls } = scripted(happyRules())
    await new WorkerImageManager({ runFn }).build(root, { base: 'node:24-bookworm-slim@sha256:beef' })
    expect(calls[1]).toContain('--build-arg')
    expect(calls[1]).toContain('BASE=node:24-bookworm-slim@sha256:beef')
  })

  it('fails closed when the docker daemon is unreachable, before building', async () => {
    const { runFn, calls } = scripted([{ label: 'info', match: isInfo, result: (argv) => failResult(argv, 'cannot connect', 1) }])
    const err = await new WorkerImageManager({ runFn }).build(tmpRoot()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain('start Docker Desktop')
    expect(calls.length).toBe(1)
  })

  it('rejects an image without tmux and writes no record', async () => {
    const root = tmpRoot()
    const rules = happyRules().map((r) =>
      r.label === 'tmux' ? { ...r, result: (argv: string[]) => failResult(argv, 'tmux: not found', 127) } : r,
    )
    const err = await new WorkerImageManager({ runFn: scripted(rules).runFn }).build(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    expect((err as SandboxUnavailableError).message).toContain('tmux')
    expect(readWorkerImageRecord(root)).toBeNull()
  })
})

describe('worker image probe', () => {
  it('reports a missing image (literal "no such image") with the exact inspect argv', async () => {
    const { runFn, calls } = scripted([
      { label: 'inspect', match: isInspect, result: (argv) => failResult(argv, 'No such image: pluton-worker:local', 1) },
    ])
    const probe = await new WorkerImageManager({ runFn }).probe(tmpRoot())
    expect(probe.present).toBe(false)
    expect(probe.matchesRecord).toBe(false)
    expect(calls[0]).toEqual(['docker', 'image', 'inspect', '--format', '{{.Id}}', DEFAULT_WORKER_IMAGE_TAG])
  })

  it('rejects with a daemon error (never "image not built") when inspect cannot reach the daemon', async () => {
    const { runFn, calls } = scripted([
      {
        label: 'inspect',
        match: isInspect,
        result: (argv) =>
          failResult(argv, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 1),
      },
    ])
    const err = await new WorkerImageManager({ runFn }).probe(tmpRoot()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SandboxUnavailableError)
    const message = (err as SandboxUnavailableError).message
    expect(message).toContain('cannot inspect worker image')
    expect(message).toContain('Cannot connect to the Docker daemon')
    expect(message).toContain('start Docker Desktop')
    expect(message).not.toContain('not built')
    expect(calls).toHaveLength(1)
  })

  it('matches a recorded build (the pin the runtime trusts)', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, '.pluton', 'state'), { recursive: true })
    writeFileSync(
      workerImageRecordPath(root),
      JSON.stringify({
        image: DEFAULT_WORKER_IMAGE_TAG,
        imageId: 'sha256:abc123',
        tmuxVersion: 'tmux 3.3a',
        nodeVersion: 'v24.0.0',
        builtAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const { runFn } = scripted([{ label: 'inspect', match: isInspect, result: (argv) => okResult(argv, 'sha256:abc123\n') }])
    const probe = await new WorkerImageManager({ runFn }).probe(root)
    expect(probe).toMatchObject({ present: true, imageId: 'sha256:abc123', matchesRecord: true })
    expect(probe.detail).toContain('matches the recorded build')
  })

  it('detects that the image was rebuilt since the recorded build', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, '.pluton', 'state'), { recursive: true })
    writeFileSync(
      workerImageRecordPath(root),
      JSON.stringify({ image: DEFAULT_WORKER_IMAGE_TAG, imageId: 'sha256:old', tmuxVersion: 't', nodeVersion: 'n', builtAt: 'x' }),
    )
    const { runFn } = scripted([{ label: 'inspect', match: isInspect, result: (argv) => okResult(argv, 'sha256:new\n') }])
    const probe = await new WorkerImageManager({ runFn }).probe(root)
    expect(probe).toMatchObject({ present: true, matchesRecord: false })
    expect(probe.detail).toContain('rebuilt/replaced')
  })

  it('reports an unrecorded image honestly (present, no record)', async () => {
    const { runFn } = scripted([{ label: 'inspect', match: isInspect, result: (argv) => okResult(argv, 'sha256:whatever\n') }])
    const probe = await new WorkerImageManager({ runFn }).probe(tmpRoot())
    expect(probe).toMatchObject({ present: true, record: null, matchesRecord: false })
    expect(probe.detail).toContain('no build record')
  })

  it('treats an unreadable record file as no record (never throws)', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, '.pluton', 'state'), { recursive: true })
    writeFileSync(workerImageRecordPath(root), 'not json{{{')
    const { runFn } = scripted([{ label: 'inspect', match: isInspect, result: (argv) => okResult(argv, 'sha256:x\n') }])
    const probe = await new WorkerImageManager({ runFn }).probe(root)
    expect(probe.record).toBeNull()
  })

  it('treats a legacy record without profile as base, never as engines', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, '.pluton', 'state'), { recursive: true })
    writeFileSync(
      workerImageRecordPath(root),
      JSON.stringify({
        image: DEFAULT_WORKER_IMAGE_TAG,
        imageId: 'sha256:legacy',
        tmuxVersion: 'tmux 3.3a',
        nodeVersion: 'v24.0.0',
        builtAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    expect(readWorkerImageRecord(root)?.profile).toBe('base')
  })
})

const LONG_RECORD_ID = 'sha256:0123456789abcdef0123456789abcdef'
const LONG_ACTUAL_ID = 'sha256:fedcba9876543210fedcba9876543210'

function probeFixture(over: Partial<WorkerImageProbe> = {}): WorkerImageProbe {
  return {
    present: true,
    image: DEFAULT_WORKER_IMAGE_TAG,
    imageId: 'sha256:current',
    record: null,
    matchesRecord: false,
    detail: 'fixture detail',
    ...over,
  }
}

function recordFixture(profile: WorkerImageRecord['profile']): WorkerImageRecord {
  return {
    image: DEFAULT_WORKER_IMAGE_TAG,
    imageId: 'sha256:current',
    profile,
    tmuxVersion: 'tmux 3.3a',
    nodeVersion: 'v24.0.0',
    builtAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('dispatch readiness (pure)', () => {
  it('down: not ready, no image-level warnings (the caller reports the sandbox fix)', () => {
    expect(dispatchReadiness(false, null)).toEqual({ ready: false, warnings: [] })
  })

  it('missing: not ready, tells the operator to build the image', () => {
    const r = dispatchReadiness(true, probeFixture({ present: false, imageId: null }))
    expect(r.ready).toBe(false)
    expect(r.warnings).toEqual([
      `worker image '${DEFAULT_WORKER_IMAGE_TAG}' is not built — run \`pluton sandbox build-image\` before dispatching tasks`,
    ])
  })

  it('no record: ready, with an info that drift was not checked in this project', () => {
    const r = dispatchReadiness(true, probeFixture())
    expect(r.ready).toBe(true)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('present but not drift-checked in this project (no build record)')
    expect(r.warnings[0]).toContain('`pluton sandbox build-image`')
  })

  it('mismatch: not ready, reports both truncated ids and the fix', () => {
    const r = dispatchReadiness(
      true,
      probeFixture({
        imageId: LONG_ACTUAL_ID,
        record: {
          image: DEFAULT_WORKER_IMAGE_TAG,
          imageId: LONG_RECORD_ID,
          profile: 'base',
          tmuxVersion: 'tmux 3.3a',
          nodeVersion: 'v24.0.0',
          builtAt: 'x',
        },
      }),
    )
    expect(r.ready).toBe(false)
    const line = r.warnings.join('\n')
    expect(line).toContain('worker image changed since the recorded build')
    expect(line).toContain('sha256:0123456789ab…')
    expect(line).toContain('sha256:fedcba987654…')
    expect(line).not.toContain(LONG_RECORD_ID)
    expect(line).not.toContain(LONG_ACTUAL_ID)
    expect(line).toContain('re-run `pluton sandbox build-image` or investigate')
  })

  it('match: ready and silent', () => {
    const r = dispatchReadiness(true, probeFixture({ imageId: 'sha256:abc123', record: recordFixture('base'), matchesRecord: true }))
    expect(r).toEqual({ ready: true, warnings: [] })
  })

  it('probe-only readiness stays green with a base-profile image', () => {
    const r = dispatchReadiness(true, probeFixture({ record: recordFixture('base'), matchesRecord: true }))
    expect(r).toEqual({ ready: true, warnings: [] })
  })

  it('container mode refuses a base-profile image with the exact --engines rebuild command', () => {
    const r = dispatchReadiness(true, probeFixture({ record: recordFixture('base'), matchesRecord: true }), {
      requireEngines: true,
    })
    expect(r.ready).toBe(false)
    expect(r.warnings.join('\n')).toContain('`pluton sandbox build-image --engines`')
  })

  it('container mode: a missing image names the --engines build command', () => {
    const r = dispatchReadiness(true, probeFixture({ present: false, imageId: null }), { requireEngines: true })
    expect(r.ready).toBe(false)
    expect(r.warnings.join('\n')).toContain('`pluton sandbox build-image --engines`')
  })

  it('container mode refuses an unrecorded image (the engines profile cannot be proven)', () => {
    const r = dispatchReadiness(true, probeFixture(), { requireEngines: true })
    expect(r.ready).toBe(false)
    expect(r.warnings.join('\n')).toContain('`pluton sandbox build-image --engines`')
  })

  it('container mode accepts an engines-profile image (and drift still refuses)', () => {
    const ok = dispatchReadiness(true, probeFixture({ record: recordFixture('engines'), matchesRecord: true }), {
      requireEngines: true,
    })
    expect(ok).toEqual({ ready: true, warnings: [] })

    const drifted = dispatchReadiness(
      true,
      probeFixture({ record: recordFixture('engines'), matchesRecord: false, imageId: LONG_ACTUAL_ID }),
      { requireEngines: true },
    )
    expect(drifted.ready).toBe(false)
    expect(drifted.warnings.join('\n')).toContain('changed since the recorded build')
  })
})
