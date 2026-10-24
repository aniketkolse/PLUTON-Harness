import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  OpenCodeAdapter,
  SHIP_WORKER_MODELS,
} from '../../src/engines/opencode/adapter.ts'
import { CapabilityError, ValidationError, EngineProtocolError } from '../../src/domain/errors.ts'
import type { AcpClient } from '../../src/engines/acp/client.ts'
import { ApiRouter } from '../../src/server/routes.ts'
import type { Store } from '../../src/store/store.ts'

describe('OpenCode Model Catalog Validation', () => {
  /**
   * These tests inject `runFn`, so no real OpenCode install is needed. The
   * binary still has to be pinned: without `binaryPath`, `listModels()` first
   * resolves the host PATH and throws `EngineMissingError` on a machine where
   * `opencode` is not installed, so the injected runner is never reached.
   */
  const injectedRunner = { binaryPath: process.execPath } as const

  it('flags unavailable models and refuses silent substitution', async () => {
    const adapter = new OpenCodeAdapter({
      ...injectedRunner,
      runFn: async () => ({
        stdout: 'opencode/minimax-m3.1-flash-free\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    })
    const models = await adapter.listModelsWithAvailability([
      'opencode/minimax-m3.1-flash-free',
      'opencode/non-existent-model',
    ])
    expect(models.find((m) => m.id === 'opencode/minimax-m3.1-flash-free')?.available).toBe(true)
    expect(models.find((m) => m.id === 'opencode/non-existent-model')?.available).toBe(false)
  })

  it('exports canonical SHIP_WORKER_MODELS with all 13 supported models', () => {
    expect(SHIP_WORKER_MODELS).toHaveLength(13)
    const expected = [
      '9router/ag/claude-opus-4-6-thinking',
      '9router/ag/gemini-3.8-flash',
      '9router/ag/gemini-3.8-flash-high',
      'opencode/beam-free',
      'opencode/big-pickle',
      'opencode/deepseek-v4.1-flash-free',
      'opencode/glm-5.3-flash-free',
      'opencode/longcat-2.5-preview-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/minimax-m3.1-flash-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
      'opencode/nemotron-3.5-super-vl-free',
    ]
    for (const model of expected) {
      expect(SHIP_WORKER_MODELS).toContain(model)
    }
  })

  it('defaults to candidate SHIP_WORKER_MODELS when candidateModels is omitted', async () => {
    const adapter = new OpenCodeAdapter({
      ...injectedRunner,
      runFn: async () => ({
        stdout: 'opencode/deepseek-v4.1-flash-free\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    })
    const models = await adapter.listModelsWithAvailability()
    expect(models.length).toBeGreaterThanOrEqual(13)
    const ds = models.find((m) => m.id === 'opencode/deepseek-v4.1-flash-free')
    expect(ds?.available).toBe(true)
    const gemini = models.find((m) => m.id === '9router/ag/gemini-3.8-flash')
    expect(gemini?.available).toBe(false)
    expect(gemini?.reason).toBeDefined()
  })

  it('marks all candidates unavailable when engine runner throws', async () => {
    const adapter = new OpenCodeAdapter({
      ...injectedRunner,
      runFn: async () => {
        throw new Error('engine not found')
      },
    })
    const models = await adapter.listModelsWithAvailability(['opencode/beam-free'])
    expect(models).toHaveLength(1)
    expect(models[0]?.available).toBe(false)
    expect(models[0]?.reason).toContain('engine not found')
  })

  it('refuses silent substitution in applyModel when model is unavailable', async () => {
    const adapter = new OpenCodeAdapter()
    const fakeClient = {} as AcpClient

    // configOptions without the requested model
    const configOptions = [
      {
        id: 'model',
        currentValue: 'opencode/other-model',
        options: [{ value: 'opencode/other-model' }],
      },
    ]

    await expect(
      adapter.applyModel(fakeClient, 'ses-1', configOptions, 'opencode/beam-free'),
    ).rejects.toThrow(ValidationError)
  })

  it('throws CapabilityError if engine does not support model selection', async () => {
    const adapter = new OpenCodeAdapter()
    const fakeClient = {} as AcpClient

    await expect(
      adapter.applyModel(fakeClient, 'ses-1', [], 'opencode/beam-free'),
    ).rejects.toThrow(CapabilityError)
  })

  it('throws EngineProtocolError if engine fails to switch to requested model', async () => {
    const adapter = new OpenCodeAdapter()
    const fakeClient = {
      request: async () => ({
        configOptions: [
          {
            id: 'model',
            currentValue: 'opencode/other-model', // didn't change!
            options: [{ value: 'opencode/other-model' }, { value: 'opencode/beam-free' }],
          },
        ],
      }),
    } as unknown as AcpClient

    const configOptions = [
      {
        id: 'model',
        currentValue: 'opencode/other-model',
        options: [{ value: 'opencode/other-model' }, { value: 'opencode/beam-free' }],
      },
    ]

    await expect(
      adapter.applyModel(fakeClient, 'ses-1', configOptions, 'opencode/beam-free'),
    ).rejects.toThrow(EngineProtocolError)
  })

  it('/api/models route returns model availability and candidate ship worker models', async () => {
    let responseBody = ''
    let statusCode = 200
    const req = {
      url: '/api/models',
      method: 'GET',
      headers: {},
    } as unknown as IncomingMessage

    const res = {
      setHeader: () => {},
      writeHead: (code: number) => {
        statusCode = code
      },
      end: (data?: string) => {
        if (data) responseBody = data
      },
      get statusCode() {
        return statusCode
      },
      set statusCode(val: number) {
        statusCode = val
      },
    } as unknown as ServerResponse

    const mockStore = {
      listMuses: () => [
        {
          id: 'coder',
          slug: 'coder',
          engineKind: 'opencode',
          model: 'opencode/minimax-m3.1-flash-free',
        },
      ],
    } as unknown as Store

    const router = new ApiRouter({
      store: mockStore,
      projectId: 'p1',
      loaded: {} as any,
      broadcaster: {} as any,
    })

    const handled = await router.handle(req, res)
    expect(handled).toBe(true)
    expect(statusCode).toBe(200)

    const parsed = JSON.parse(responseBody)
    expect(parsed.ok).toBe(true)
    expect(parsed.models['opencode']).toBeDefined()
    const opencodeModels = parsed.models['opencode'] as Array<{ id: string; available: boolean }>
    expect(opencodeModels.length).toBeGreaterThanOrEqual(13)
    for (const shipModel of SHIP_WORKER_MODELS) {
      const found = opencodeModels.find((m) => m.id === shipModel)
      expect(found).toBeDefined()
      expect(typeof found?.available).toBe('boolean')
    }
  })
})
