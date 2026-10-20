import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInside, loadConfig, validateConfig } from '../../src/config/load.ts'
import { ConfigError } from '../../src/domain/errors.ts'

function minimal(projectOverrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: {
      name: 'demo',
      repository: '.',
      default_branch: 'main',
      verification: [],
      ...projectOverrides,
    },
    muses: {},
    ...top,
  }
}

const ROOT = join(tmpdir(), 'pluton-config-test-root')
const PATH = join(ROOT, 'pluton.yaml')

describe('validateConfig', () => {
  it('accepts a minimal config and applies runtime defaults', () => {
    const loaded = validateConfig(minimal(), ROOT, PATH)
    expect(loaded.config.project.name).toBe('demo')
    expect(loaded.config.runtime.max_concurrent_workers).toBe(3)
    expect(loaded.config.runtime.approval_timeout_minutes).toBe(60)
    expect(loaded.config.runtime.max_revisions_per_task).toBe(1)
    expect(loaded.config.sandbox.kind).toBe('docker')
    expect(loaded.config.git.require_approval_for_main_branch_integration).toBe(true)
    expect(loaded.config.muses).toEqual({})
  })

  it('accepts an explicit approval timeout: 0 (never expires) and the maximum', () => {
    const never = validateConfig(minimal({}, { runtime: { approval_timeout_minutes: 0 } }), ROOT, PATH)
    expect(never.config.runtime.approval_timeout_minutes).toBe(0)
    const max = validateConfig(minimal({}, { runtime: { approval_timeout_minutes: 10_080 } }), ROOT, PATH)
    expect(max.config.runtime.approval_timeout_minutes).toBe(10_080)
  })

  it('rejects an out-of-range approval timeout', () => {
    for (const bad of [-1, 10_081, 1.5]) {
      expect(() => validateConfig(minimal({}, { runtime: { approval_timeout_minutes: bad } }), ROOT, PATH)).toThrow(
        ConfigError,
      )
    }
  })

  it('accepts an explicit manager revision cap: 0 (revisions disabled) and the maximum', () => {
    const disabled = validateConfig(minimal({}, { runtime: { max_revisions_per_task: 0 } }), ROOT, PATH)
    expect(disabled.config.runtime.max_revisions_per_task).toBe(0)
    const max = validateConfig(minimal({}, { runtime: { max_revisions_per_task: 10 } }), ROOT, PATH)
    expect(max.config.runtime.max_revisions_per_task).toBe(10)
  })

  it('rejects an out-of-range manager revision cap', () => {
    for (const bad of [-1, 11, 1.5]) {
      expect(() => validateConfig(minimal({}, { runtime: { max_revisions_per_task: bad } }), ROOT, PATH)).toThrow(
        ConfigError,
      )
    }
  })

  it("accepts repository '.' (the project root itself) — regression: assertInside used to reject rel === ''", () => {
    expect(() => validateConfig(minimal(), ROOT, PATH)).not.toThrow()
    expect(() => assertInside(ROOT, '.', 'x')).not.toThrow()
  })

  it('rejects a repository path that escapes the project root', () => {
    expect(() => validateConfig(minimal({ repository: '..' }), ROOT, PATH)).toThrow(ConfigError)
    expect(() => validateConfig(minimal({ repository: '../sibling' }), ROOT, PATH)).toThrow(ConfigError)
  })

  it('rejects absolute repository paths', () => {
    const abs = process.platform === 'win32' ? 'C:\\elsewhere' : '/elsewhere'
    expect(() => validateConfig(minimal({ repository: abs }), ROOT, PATH)).toThrow(ConfigError)
  })

  it('rejects instructions_file escapes even when the muse is otherwise valid', () => {
    const raw = minimal(
      {},
      {
        muses: {
          boss: {
            display_name: 'Boss',
            role: 'supervisor',
            engine: 'mock',
            model: 'mock/model-a',
            workspace_policy: 'coordinator-read-only',
            instructions_file: '../outside.md',
          },
        },
      },
    )
    expect(() => validateConfig(raw, ROOT, PATH)).toThrow(/escapes the project root/)
  })

  it('rejects muses without a supervisor', () => {
    const raw = minimal(
      {},
      {
        muses: {
          worker: { display_name: 'W', role: 'coder', engine: 'mock', model: 'mock/model-a' },
        },
      },
    )
    expect(() => validateConfig(raw, ROOT, PATH)).toThrow(/no supervisor/)
  })

  it('rejects a supervisor with isolated-task-checkout (supervisors coordinate, they do not edit)', () => {
    const raw = minimal(
      {},
      {
        muses: {
          boss: {
            display_name: 'Boss',
            role: 'supervisor',
            engine: 'mock',
            model: 'mock/model-a',
            workspace_policy: 'isolated-task-checkout',
          },
        },
      },
    )
    expect(() => validateConfig(raw, ROOT, PATH)).toThrow(/isolated-task-checkout/)
  })

  it('rejects an unsupported config version with migration guidance', () => {
    try {
      validateConfig(minimal({}, { version: 2 }), ROOT, PATH)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as Error).message).toMatch(/supports version 1/)
    }
  })
})

describe('loadConfig', () => {
  it('throws a helpful error when pluton.yaml is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-noconfig-'))
    expect(() => loadConfig(dir)).toThrow(/pluton init/)
  })

  it('round-trips a written config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pluton-config-'))
    writeFileSync(join(dir, 'pluton.yaml'), 'version: 1\nproject:\n  name: file-demo\n  repository: .\n  default_branch: main\n  verification: []\nmuses: {}\n')
    const loaded = loadConfig(dir)
    expect(loaded.config.project.name).toBe('file-demo')
  })
})
