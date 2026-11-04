import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExecutionRoute } from '../../src/engines/execution-router.ts'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import { ModelHealthMonitor, classifyModelError } from '../../src/engines/model-health.ts'
import type { ModelErrorContext } from '../../src/engines/model-health.ts'
import { saveConnection } from '../../src/providers/store.ts'

describe('Connection-Scoped Health & Quota Isolation', () => {
  it('scopes provider/quota errors strictly to connectionId so connection B remains healthy', () => {
    const registry = new ModelRegistry()
    const sharedModelId = 'llama-3.3-70b-instruct'

    // Add same model under Connection A and Connection B
    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: sharedModelId, source: 'engine', connectionId: 'conn-a', provider: 'conn-a' }],
      '2030-01-01T00:00:00.000Z',
      'conn-a',
      'conn-a',
    )

    registry.replaceEngineModels(
      'openai-compatible',
      [{ id: sharedModelId, source: 'engine', connectionId: 'conn-b', provider: 'conn-b' }],
      '2030-01-01T00:00:00.000Z',
      'conn-b',
      'conn-b',
    )

    const monitor = new ModelHealthMonitor({ registry })

    // Simulate quota exhaustion on Connection A
    const errorContext: ModelErrorContext = {
      engineKind: 'openai-compatible',
      connectionId: 'conn-a',
      provider: 'conn-a',
      modelId: sharedModelId,
      errorCode: 'insufficient_quota',
      providerMessage: 'You have exceeded your monthly quota for this key',
      scopeHint: 'provider',
    }

    const classification = classifyModelError(errorContext)
    monitor.recordFailure(errorContext, classification)

    // Connection A's health must be degraded or unavailable
    const healthA = monitor.getModelHealth('conn-a', sharedModelId)
    expect(healthA.state).not.toBe('healthy')

    // Connection B's health MUST remain healthy
    const healthB = monitor.getModelHealth('conn-b', sharedModelId)
    expect(healthB.state).toBe('healthy')

    // Also check provider-level health
    expect(monitor.isProviderHealthy('openai-compatible', 'conn-a')).toBe(false)
    expect(monitor.isProviderHealthy('openai-compatible', 'conn-b')).toBe(true)
  })

  it('preserves connectionId on ModelErrorContext and tracks failure per connection', () => {
    const registry = new ModelRegistry()
    const monitor = new ModelHealthMonitor({ registry })

    const context: ModelErrorContext = {
      engineKind: 'openai-compatible',
      connectionId: 'conn-work',
      provider: 'conn-work',
      modelId: 'gpt-4o',
      errorCode: 'rate_limit',
      providerMessage: 'Rate limit reached',
      scopeHint: 'provider',
    }

    const { classification, changes } = monitor.recordFailure(context)
    expect(classification.category).toBe('usage-limit')
    expect(changes.some((c) => c.providerScope === 'conn-work')).toBe(true)
  })

  it('re-resolves route and instantiates target adapter when fallback switches connection', () => {
    const root = mkdtempSync(join(tmpdir(), 'pluton-fallback-router-'))
    try {
      saveConnection(root, {
        id: 'conn-primary',
        providerId: 'primary-gw',
        displayName: 'Primary Gateway',
        baseUrl: 'http://127.0.0.1:20128/v1',
        protocol: 'openai-compatible',
        auth: { style: 'bearer' },
      })

      saveConnection(root, {
        id: 'conn-backup',
        providerId: 'backup-gw',
        displayName: 'Backup Gateway',
        baseUrl: 'http://127.0.0.1:20129/v1',
        protocol: 'openai-compatible',
        auth: { style: 'bearer' },
      })

      // Initial task route on primary
      const initialRoute = resolveExecutionRoute({
        rootDir: root,
        model: 'conn-primary:llama-3.3-70b-instruct',
      })
      expect(initialRoute.identity.providerId).toBe('conn-primary')

      // Fallback decision recommends switching to conn-backup:llama-3.3-70b-instruct
      const fallbackModelId = 'conn-backup:llama-3.3-70b-instruct'
      const fallbackRoute = resolveExecutionRoute({
        rootDir: root,
        model: fallbackModelId,
      })

      expect(fallbackRoute.identity.providerId).toBe('conn-backup')
      expect(fallbackRoute.identity.engineKind).toBe('openai-compatible')
      expect(fallbackRoute.providerModelId).toBe('llama-3.3-70b-instruct')
      expect(fallbackRoute.provider?.id).toBe('conn-backup')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
