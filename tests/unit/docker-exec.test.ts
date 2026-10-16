import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { dockerExecSpawn, mapHostPathToContainer, type DockerExecContext } from '../../src/engines/docker-exec.ts'
import { fakeSpawn } from '../helpers/fake-acp-agent.ts'

/**
 * `docker exec` ACP spawn seam (B3): the engine's stdio is the docker CLI's
 * stdio, the container-side command runs in the mapped checkout, and the
 * session env crosses as `-e NAME` pass-through only — values ride in the
 * spawned docker CLI's own env, never in argv (ADR-0008).
 */

const MOUNTS = [
  { hostPath: 'C:\\work\\checkout', containerPath: '/work' },
  { hostPath: 'C:\\homes\\worker-a', containerPath: '/home/pluton' },
]

describe('mapHostPathToContainer', () => {
  it('maps an exact mount, nested paths, and normalizes separators', () => {
    expect(mapHostPathToContainer('C:\\work\\checkout', MOUNTS)).toBe('/work')
    expect(mapHostPathToContainer('C:\\work\\checkout\\src\\app.ts', MOUNTS)).toBe('/work/src/app.ts')
    expect(mapHostPathToContainer('C:/work/checkout/src', MOUNTS)).toBe('/work/src')
  })

  it('picks the longest matching mount prefix', () => {
    const overlaps = [
      { hostPath: 'C:\\work', containerPath: '/work' },
      { hostPath: 'C:\\work\\inner', containerPath: '/inner' },
    ]
    expect(mapHostPathToContainer('C:\\work\\inner\\x', overlaps)).toBe('/inner/x')
    expect(mapHostPathToContainer('C:\\work\\other', overlaps)).toBe('/work/other')
  })

  it('never matches across a path boundary', () => {
    // 'C:\work\checkout-other' must NOT be treated as inside 'C:\work\checkout'.
    expect(() => mapHostPathToContainer('C:\\work\\checkout-other\\x', MOUNTS)).toThrowError(ValidationError)
  })

  it('throws ValidationError for unmapped host paths', () => {
    const err = (() => {
      try {
        mapHostPathToContainer('D:\\elsewhere\\x', MOUNTS)
        return null
      } catch (e: unknown) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).message).toContain('D:\\elsewhere\\x')
  })
})

describe('dockerExecSpawn', () => {
  const ctx: DockerExecContext = {
    containerName: 'pluton-demo-worker-a',
    mounts: MOUNTS,
    env: { PLUTON_RUN_ID: 'run_1' },
  }

  function sessionEnv(): Record<string, string> {
    return {
      PATH: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      APPDATA: 'C:\\Users\\Asus\\AppData\\Roaming',
      HOME: 'C:\\homes\\worker-a',
      QWEN_DIR: 'C:\\homes\\worker-a\\qwen',
      XDG_DATA_HOME: 'C:\\homes\\worker-a\\data',
      OPENAI_API_KEY: 'test-key-value',
      LANG: 'C.UTF-8',
    }
  }

  it('spawns docker exec with -e NAME pass-through only, mapped paths, and no values in argv', () => {
    const spawn = fakeSpawn()
    const spawnFn = dockerExecSpawn(ctx, spawn.spawnFn)

    spawnFn('/usr/local/bin/qwen', ['--acp'], {
      cwd: 'C:\\work\\checkout\\task_x',
      env: sessionEnv(),
      windowsHide: true,
    })

    const agent = spawn.lastAgent()
    const argv = agent.spawnArgs
    expect(argv.slice(0, 5)).toEqual(['docker', 'exec', '-i', '-w', '/work/task_x'])
    expect(argv.slice(-3)).toEqual(['pluton-demo-worker-a', '/usr/local/bin/qwen', '--acp'])

    // Every `-e` is NAME-only: a `NAME=value` argument would put secrets in the
    // docker CLI's process argv (ADR-0008).
    const envNames: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] !== '-e') continue
      const next = argv[i + 1] as string
      expect(next).not.toContain('=')
      envNames.push(next)
    }
    expect([...envNames].sort()).toEqual(
      ['LANG', 'OPENAI_API_KEY', 'PLUTON_RUN_ID', 'QWEN_DIR', 'XDG_DATA_HOME', 'HOME'].sort(),
    )

    // Host-shaped platform variables must never override the container's own.
    for (const key of ['PATH', 'Path', 'SystemRoot', 'APPDATA']) {
      expect(envNames).not.toContain(key)
    }

    // Values ride in the spawned docker CLI's env; host paths are rewritten to
    // container paths; non-path values pass through untouched.
    expect(agent.spawnEnv['HOME']).toBe('/home/pluton')
    expect(agent.spawnEnv['QWEN_DIR']).toBe('/home/pluton/qwen')
    expect(agent.spawnEnv['XDG_DATA_HOME']).toBe('/home/pluton/data')
    expect(agent.spawnEnv['OPENAI_API_KEY']).toBe('test-key-value')
    expect(agent.spawnEnv['PLUTON_RUN_ID']).toBe('run_1')
    // The docker CLI itself still runs with host essentials.
    expect(agent.spawnEnv['PATH']).toBe(process.env['PATH'])
    expect(agent.spawnCwd).toBe('C:\\work\\checkout\\task_x')
  })

  it('lets the per-session env win over the context env on key collisions', () => {
    const spawn = fakeSpawn()
    const spawnFn = dockerExecSpawn({ ...ctx, env: { LANG: 'C' } }, spawn.spawnFn)
    spawnFn('/usr/local/bin/qwen', [], { cwd: 'C:\\work\\checkout', env: { LANG: 'C.UTF-8' }, windowsHide: true })
    expect(spawn.lastAgent().spawnEnv['LANG']).toBe('C.UTF-8')
  })

  it('fails loudly (and spawns nothing) when the session cwd is not mounted', () => {
    const spawn = fakeSpawn()
    const spawnFn = dockerExecSpawn(ctx, spawn.spawnFn)
    expect(() =>
      spawnFn('/usr/local/bin/qwen', ['--acp'], { cwd: 'D:\\outside', env: {}, windowsHide: true }),
    ).toThrowError(ValidationError)
    expect(spawn.agents).toHaveLength(0)
  })
})
