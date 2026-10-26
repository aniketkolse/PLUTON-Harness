import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExecutionClosedError,
  ExecutionTimeoutError,
  PolicyDeniedError,
  ValidationError,
} from '../../src/domain/errors.ts'
import {
  NativeExecutionProvider,
  type ExecutionEvent,
  type ExecutionSessionSpec,
} from '../../src/execution/native.ts'

/**
 * Native execution provider: process-level policy, bounded exec, tree-aware
 * teardown, and durable lifecycle facts. These tests are host-only (no Docker)
 * and use the running Node executable for deterministic child processes.
 */

const tmpDirs: string[] = []
const providers: NativeExecutionProvider[] = []

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeRoot(): string {
  const created = mkdtempSync(join(tmpdir(), 'pluton-native-unit-'))
  tmpDirs.push(created)
  mkdirSync(join(created, '.pluton', 'workspaces'), { recursive: true })
  mkdirSync(join(created, '.pluton', 'engine-homes'), { recursive: true })
  // The provider resolves every workdir through `realpathSync.native` before it
  // reports facts or spawns a child (containment is checked on the canonical
  // path). `tmpdir()` itself can sit behind a symlink — on macOS `/var` is a
  // symlink to `/private/var` — so the fixture must hand out the same canonical
  // root the provider will report back.
  return realpathSync.native(created)
}

function spec(root: string, overrides: Partial<ExecutionSessionSpec> = {}): ExecutionSessionSpec {
  return {
    projectId: 'project_native',
    museId: 'muse_native',
    engineKind: 'mock',
    hostWorkdir: root,
    hostEngineHome: join(root, '.pluton', 'engine-homes', 'muse_native'),
    allowedRoots: [
      root,
      join(root, '.pluton', 'workspaces'),
      join(root, '.pluton', 'engine-homes'),
    ],
    mode: 'unconfined',
    network: 'open',
    env: { ALLOWED: 'from-spec' },
    limits: { cpus: 1, memoryMb: 256, pids: 64 },
    ...overrides,
  }
}

function makeProvider(
  root: string,
  events: ExecutionEvent[],
  overrides: Partial<ConstructorParameters<typeof NativeExecutionProvider>[0]> = {},
): NativeExecutionProvider {
  const provider = new NativeExecutionProvider({
    rootDir: root,
    hostEnv: {
      ...process.env,
      PLUTON_NATIVE_SECRET: 'host-secret',
      ALLOWED: 'from-host',
    },
    onEvent: (event) => events.push(event),
    terminateGraceMs: 100,
    ...overrides,
  })
  providers.push(provider)
  return provider
}

async function waitForEvent(
  events: ExecutionEvent[],
  type: ExecutionEvent['type'],
  timeoutMs = 5_000,
): Promise<ExecutionEvent> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = events.find((event) => event.type === type)
    if (found !== undefined) return found
    await delay(10)
  }
  throw new Error(`timed out waiting for ${type}; saw: ${events.map((e) => e.type).join(', ')}`)
}

describe('NativeExecutionProvider', () => {
  it('probes honestly: backend and enforcement reflect platform capabilities', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const probe = await provider.probe()
    expect(probe.available).toBe(true)
    expect(probe.provider).toBe('native')
    if (process.platform === 'linux' && probe.capabilities.filesystemConfinement) {
      expect(probe.backend).toBe('landlock')
      expect(probe.enforcement).toBe('os-confinement')
      expect(probe.capabilities.networkConfinement).toBe(true)
    } else {
      expect(probe.backend).toBe('unconfined')
      expect(probe.enforcement).toBe('unconfined')
      expect(probe.capabilities.filesystemConfinement).toBe(false)
      expect(probe.capabilities.networkConfinement).toBe(false)
    }
    expect(probe.capabilities.processTreeKill).toBe(true)
  })

  it('rejects NaN or non-finite sessionTimeoutMs, terminateGraceMs, and maxOutputBytes in constructor', () => {
    const root = makeRoot()
    expect(() => makeProvider(root, [], { sessionTimeoutMs: NaN })).toThrow(ValidationError)
    expect(() => makeProvider(root, [], { terminateGraceMs: NaN })).toThrow(ValidationError)
    expect(() => makeProvider(root, [], { maxOutputBytes: NaN })).toThrow(ValidationError)
  })

  it('rejects a working directory outside the allowed roots', async () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'pluton-native-outside-'))
    tmpDirs.push(outside)
    const provider = makeProvider(root, [])
    await expect(
      provider.prepare(spec(root, { hostWorkdir: outside })),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('rejects a symlinked working directory that resolves outside the allowed roots', async () => {
    const root = makeRoot()
    const outside = mkdtempSync(join(tmpdir(), 'pluton-native-symlink-outside-'))
    tmpDirs.push(outside)
    const link = join(root, 'escape-link')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const provider = makeProvider(root, [])
    await expect(
      provider.prepare(spec(root, { hostWorkdir: link })),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('rejects network policies it cannot enforce', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    await expect(provider.prepare(spec(root, { network: 'restricted' }))).rejects.toThrow()
    await expect(provider.prepare(spec(root, { network: 'none' }))).rejects.toThrow()
  })

  it('passes only explicitly allowed environment values and records filtered names', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events)
    const session = await provider.prepare(spec(root))
    const script = `
      process.stdout.write(JSON.stringify({
        cwd: process.cwd(),
        allowed: process.env.ALLOWED ?? null,
        secret: process.env.PLUTON_NATIVE_SECRET ?? null,
        hostOnly: process.env.HOST_ONLY ?? null,
        path: Boolean(process.env.PATH || process.env.Path),
      }))
    `
    const result = await session.exec(
      [process.execPath, '-e', script],
      { env: { ALLOWED: 'from-caller', PLUTON_NATIVE_SECRET: 'caller-secret', HOST_ONLY: 'x' } },
    )
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed['cwd']).toBe(root)
    expect(parsed['allowed']).toBe('from-caller')
    expect(parsed['secret']).toBeNull()
    expect(parsed['hostOnly']).toBeNull()
    expect(parsed['path']).toBe(true)
    const filtered = await waitForEvent(events, 'execution.env_filtered')
    expect(filtered.names).toEqual(expect.arrayContaining(['HOST_ONLY', 'PLUTON_NATIVE_SECRET']))
    expect(JSON.stringify(filtered)).not.toContain('caller-secret')
  })

  it('returns a bounded, truncated result instead of buffering unbounded output', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    const result = await session.exec(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(10000))"],
      { maxOutputBytes: 100 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('bounds output by UTF-8 bytes, not UTF-16 code units', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    const result = await session.exec(
      [process.execPath, '-e', "process.stdout.write('é'.repeat(500))"],
      { maxOutputBytes: 100 },
    )
    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(100)
    expect(result.stdout.length).toBeLessThanOrEqual(50)
    expect(result.truncated).toBe(true)
  })

  it('keeps decoded UTF-8 output within the byte cap when a multibyte sequence is split', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    const result = await session.exec(
      [process.execPath, '-e', "process.stdout.write(String.fromCharCode(233).repeat(500))"],
      { maxOutputBytes: 101 },
    )
    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(101)
    expect(result.stdout).not.toContain('\uFFFD')
    expect(result.truncated).toBe(true)
  })

  it('returns exit codes and bounded stderr for a failing child', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events)
    const session = await provider.prepare(spec(root))
    const result = await session.exec([
      process.execPath,
      '-e',
      "process.stderr.write('boom'); process.exit(7)",
    ])
    expect(result.exitCode).toBe(7)
    expect(result.stderr).toContain('boom')
    const exited = await waitForEvent(events, 'execution.session_exited')
    expect(exited.code).toBe(7)
  })

  it('turns a spawn error into a typed result and a session_error event', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events)
    const session = await provider.prepare(spec(root))
    const result = await session.exec([join(root, 'definitely-missing-binary.exe')])
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toMatch(/ENOENT|not found/i)
    const error = await waitForEvent(events, 'execution.session_error')
    expect(error.detail).toMatch(/ENOENT|not found/i)
  })

  it('kills a hung exec at the timeout and reports timedOut', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events)
    const session = await provider.prepare(spec(root))
    const started = Date.now()
    const result = await session.exec(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 150 },
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    await waitForEvent(events, 'execution.session_timeout')
  })

  it('kills the whole process tree on cancellation, not just the direct child', async () => {
    const root = makeRoot()
    const heartbeat = join(root, 'heartbeat.txt')
    const childPid = join(root, 'child-pid.txt')
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    const script = `
      const fs = require('node:fs')
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        `setInterval(() => { try { require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, 'x') } catch {} }, 25)`,
      )}], { stdio: 'ignore' })
      fs.writeFileSync(${JSON.stringify(childPid)}, String(child.pid))
      setInterval(() => {}, 1000)
    `
    const handle = session.spawn(process.execPath, ['-e', script], {})
    const started = Date.now()
    while (!existsSync(childPid) && Date.now() - started < 5_000) await delay(10)
    expect(existsSync(childPid)).toBe(true)
    while (!existsSync(heartbeat) && Date.now() - started < 5_000) await delay(10)
    expect(existsSync(heartbeat)).toBe(true)

    expect(handle.kill()).toBe(true)
    await handle.waitForExit?.()
    await delay(250)
    const sizeAfterKill = statSync(heartbeat).size
    await delay(500)
    expect(statSync(heartbeat).size).toBe(sizeAfterKill)
  })

  it('escalates close() and refuses new spawns once closed', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events)
    const session = await provider.prepare(spec(root))
    const handle = session.spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      {},
    )
    await delay(150)
    await session.close()
    await Promise.race([
      handle.waitForExit?.(),
      delay(3_000).then(() => {
        throw new Error('child survived close() escalation')
      }),
    ])
    expect(provider.listSessions()).toHaveLength(0)
    expect(() => session.spawn(process.execPath, ['-e', '0'], {})).toThrow(ExecutionClosedError)
    expect(events.some((event) => event.type === 'execution.session_closed')).toBe(true)
  })

  it('applies a session timeout that terminates live children and blocks later spawns', async () => {
    const root = makeRoot()
    const events: ExecutionEvent[] = []
    const provider = makeProvider(root, events, { sessionTimeoutMs: 200 })
    const session = await provider.prepare(spec(root))
    const handle = session.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
    )
    await waitForEvent(events, 'execution.session_timeout', 5_000)
    await Promise.race([
      handle.waitForExit?.(),
      delay(3_000).then(() => {
        throw new Error('child survived the session timeout')
      }),
    ])
    expect(() => session.spawn(process.execPath, ['-e', '0'], {})).toThrow(ExecutionTimeoutError)
  })

  it('closeAll() is idempotent and leaves no live sessions', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    expect(provider.listSessions()).toHaveLength(1)
    await provider.close()
    await provider.close()
    expect(provider.listSessions()).toHaveLength(0)
    expect(() => session.spawn(process.execPath, ['-e', '0'], {})).toThrow(ExecutionClosedError)
  })

  it('keeps session facts free of environment values', async () => {
    const root = makeRoot()
    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root))
    const facts = session.facts()
    expect(facts.provider).toBe('native')
    expect(facts.enforcement).toBeDefined()
    expect(facts.workdir).toBe(root)
    expect(facts.limitations.join(' ')).toMatch(/filesystem|network/i)
    expect(JSON.stringify(facts)).not.toContain('host-secret')
  })

  it('reports the canonical workdir when the session root is reached through a symlink', async () => {
    const root = makeRoot()
    const alias = join(root, '.pluton', 'workspaces', 'root-alias')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const provider = makeProvider(root, [])
    const session = await provider.prepare(spec(root, { hostWorkdir: alias }))
    const facts = session.facts()

    // An alias that resolves inside the allowed roots is accepted, but spawning
    // and facts must agree on one canonical directory: the reported workdir is
    // the real path, never the operator-supplied symlink. Comparing against
    // the raw fixture path breaks on hosts whose temp root is itself a symlink.
    expect(facts.workdir).toBe(realpathSync.native(root))
    expect(facts.workdir).not.toBe(alias)

    const result = await session.exec([process.execPath, '-e', 'process.stdout.write(process.cwd())'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(facts.workdir)
  })
})
