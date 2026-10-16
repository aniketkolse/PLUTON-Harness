import { describe, expect, it } from 'vitest'
import { QwenEngineAdapter } from '../../src/engines/qwen/adapter.ts'
import { OpenCodeEngineAdapter } from '../../src/engines/opencode/adapter.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { engineAdapterForMuse, engineApprovalPolicy, engineSessionMode } from '../../src/engines/approval.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'

/**
 * Wiring pinned by the host-mode smoke failure (2026-10-16): nothing mapped a
 * Muse's recorded approval mode onto engine session settings, so every qwen
 * edit was fail-closed denied while the task still claimed success. These
 * tests pin the mapping table and the per-Muse factory the supervisor uses.
 */

registerBuiltinEngines()

describe('engineSessionMode', () => {
  it('maps every Pluton approval mode to the qwen session mode', () => {
    expect(engineSessionMode('qwen', 'autonomous-bounded')).toBe('auto')
    expect(engineSessionMode('qwen', 'ask-for-sensitive-actions')).toBe('auto')
    expect(engineSessionMode('qwen', 'ask-always')).toBe('default')
  })

  it('leaves engines without a mode select untouched (they keep their own default)', () => {
    expect(engineSessionMode('opencode', 'autonomous-bounded')).toBeUndefined()
    expect(engineSessionMode('mock', 'ask-always')).toBeUndefined()
  })
})

describe('engineApprovalPolicy', () => {
  it('grants once only under bounded autonomy; everything else denies fail-closed', () => {
    expect(engineApprovalPolicy('autonomous-bounded')).toBe('allow_once')
    expect(engineApprovalPolicy('ask-for-sensitive-actions')).toBe('deny')
    expect(engineApprovalPolicy('ask-always')).toBe('deny')
  })
})

describe('engineAdapterForMuse', () => {
  it('builds the engine-specific adapter for the Muse kind', () => {
    const qwen = engineAdapterForMuse({ engineKind: 'qwen', approvalMode: 'ask-for-sensitive-actions' })
    expect(qwen).toBeInstanceOf(QwenEngineAdapter)
    expect(qwen.kind).toBe('qwen')

    expect(engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'autonomous-bounded' })).toBeInstanceOf(
      OpenCodeEngineAdapter,
    )
    expect(engineAdapterForMuse({ engineKind: 'mock', approvalMode: 'ask-always' })).toBeInstanceOf(MockEngineAdapter)
  })

  it('rejects unknown engine kinds loudly (never silently falls back)', () => {
    expect(() => engineAdapterForMuse({ engineKind: 'nope', approvalMode: 'ask-always' })).toThrow(/unknown engine/)
  })
})
