import { describe, expect, it } from 'vitest'
import { ModelRegistry } from '../../src/engines/model-registry.ts'
import type { ModelCapabilityDeclaration } from '../../src/engines/contract/types.ts'

describe('ModelRegistry multi-connection isolation & composite identity', () => {
  it('stores the same model ID under two different connections without collision', () => {
    const registry = new ModelRegistry()

    const modelId = 'llama-3.3-70b-instruct'

    // Connection A (e.g. 9router local gateway)
    registry.replaceEngineModels(
      'openai-compatible',
      [
        {
          id: modelId,
          label: 'Llama 3.3 70B (9router)',
          source: 'engine',
          toolCalling: true,
          connectionId: 'conn-local-9router',
        },
      ],
      new Date().toISOString(),
      'conn-local-9router',
      'conn-local-9router',
    )

    // Connection B (e.g. OpenRouter remote gateway)
    registry.replaceEngineModels(
      'openai-compatible',
      [
        {
          id: modelId,
          label: 'Llama 3.3 70B (OpenRouter)',
          source: 'engine',
          toolCalling: false,
          connectionId: 'conn-remote-openrouter',
        },
      ],
      new Date().toISOString(),
      'conn-remote-openrouter',
      'conn-remote-openrouter',
    )

    // Both should exist and be retrievable by connection
    const entryA = registry.getByConnection('conn-local-9router', modelId)
    const entryB = registry.getByConnection('conn-remote-openrouter', modelId)

    expect(entryA).not.toBeNull()
    expect(entryB).not.toBeNull()
    expect(entryA?.label).toBe('Llama 3.3 70B (9router)')
    expect(entryB?.label).toBe('Llama 3.3 70B (OpenRouter)')
    expect(entryA?.toolCalling).toBe(true)
    expect(entryB?.toolCalling).toBe(false)

    // Querying list by connection returns only models for that connection
    const listA = registry.listByConnection('conn-local-9router')
    expect(listA.length).toBe(1)
    expect(listA[0]?.connectionId).toBe('conn-local-9router')

    const listB = registry.listByConnection('conn-remote-openrouter')
    expect(listB.length).toBe(1)
    expect(listB[0]?.connectionId).toBe('conn-remote-openrouter')

    // findById returns both entries
    const found = registry.findById(modelId)
    expect(found.length).toBe(2)
  })

  it('manually registers a model with user-declared capabilities', () => {
    const registry = new ModelRegistry()

    const caps: ModelCapabilityDeclaration = {
      verified: false,
      toolCalling: true,
      contextWindow: 128000,
      coding: true,
      reasoning: false,
    }

    const change = registry.registerManualModel(
      'conn-custom-api',
      {
        id: 'deepseek-coder-v2',
        label: 'DeepSeek Coder V2 Custom',
        source: 'static',
      },
      caps,
    )

    expect(change).not.toBeNull()
    expect(change?.type).toBe('added')
    expect(change?.modelId).toBe('deepseek-coder-v2')

    const entry = registry.getByConnection('conn-custom-api', 'deepseek-coder-v2')
    expect(entry).not.toBeNull()
    expect(entry?.toolCalling).toBe(true)
    expect(entry?.contextWindow).toBe(128000)
    expect(entry?.codingCapable).toBe(true)
    expect(entry?.reasoningCapable).toBe(false)
    expect(entry?.capabilityDeclaration).toEqual(caps)
    expect(entry?.connectionId).toBe('conn-custom-api')
  })
})
