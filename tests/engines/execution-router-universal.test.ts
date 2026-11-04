import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { resolveExecutionRoute } from '../../src/engines/execution-router.ts'
import { saveConnection, saveProvider } from '../../src/providers/store.ts'
import type { ConnectionConfig } from '../../src/providers/types.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pluton-exec-router-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Universal Execution Router', () => {
  it('routes multi-segment model ID to selected connection without misinterpreting vendor segment', () => {
    const conn: ConnectionConfig = {
      id: 'openrouter',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    }
    saveConnection(root, conn)

    // Multi-segment model ID: nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b
    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b',
      providerId: 'openrouter',
    })

    expect(route.identity.providerId).toBe('openrouter')
    expect(route.identity.engineKind).toBe('openai-compatible')
    expect(route.providerModelId).toBe('nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b')
  })

  it('routes connection-prefixed model ID directly (conn-id:model-id)', () => {
    const conn: ConnectionConfig = {
      id: 'conn-custom',
      providerId: 'custom-api',
      displayName: 'Custom Gateway',
      baseUrl: 'http://127.0.0.1:20128/v1',
      protocol: 'openai-compatible',
      auth: { style: 'bearer' },
    }
    saveConnection(root, conn)

    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'conn-custom:gpt-4o',
    })

    expect(route.identity.providerId).toBe('conn-custom')
    expect(route.identity.engineKind).toBe('openai-compatible')
    expect(route.providerModelId).toBe('gpt-4o')
  })

  it('routes opencode-prefixed model ID to opencode built-in engine', () => {
    const route = resolveExecutionRoute({
      rootDir: root,
      model: 'opencode/deepseek-chat',
    })

    expect(route.identity.engineKind).toBe('opencode')
    expect(route.identity.providerId).toBe('opencode')
  })

  it('does not silently fall back to opencode when unconfigured external model is specified', () => {
    expect(() =>
      resolveExecutionRoute({
        rootDir: root,
        model: 'some-unknown-vendor/model-xyz',
      }),
    ).toThrowError(ValidationError)
  })
})
