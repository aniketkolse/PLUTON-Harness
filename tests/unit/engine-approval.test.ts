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

  it('refuses an unrecognised mode instead of silently reverting to the fail-closed default', () => {
    // Muse rows are read from the store with a blind cast: a hand-edited or
    // legacy `approval_mode` must fail loudly at adapter construction.
    expect(() => engineSessionMode('qwen', 'hand-edited' as never)).toThrow(/no session-mode mapping/)
  })
})

describe('engineApprovalPolicy', () => {
  it('forwards ask-* modes to the operator channel; qwen auto-approves only in a proven isolated checkout', () => {
    expect(engineApprovalPolicy('qwen', 'autonomous-bounded', { isolatedCheckout: true })).toBe('allow_once')
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded', { isolatedCheckout: true })).toBe('deny')
    expect(engineApprovalPolicy('qwen', 'ask-for-sensitive-actions')).toBe('interactive')
    expect(engineApprovalPolicy('qwen', 'ask-always')).toBe('interactive')
    expect(engineApprovalPolicy('opencode', 'ask-for-sensitive-actions')).toBe('interactive')
    expect(engineApprovalPolicy('opencode', 'ask-always')).toBe('interactive')
  })

  it('withholds the qwen one-shot grant from project-root sessions and missing isolation metadata', () => {
    // Confidence comes from runtime facts, never from the mode name: a chat/SPA/
    // manager session at the project root must ask the operator instead of
    // auto-granting the engine's residual requests.
    expect(engineApprovalPolicy('qwen', 'autonomous-bounded', { isolatedCheckout: false })).toBe('interactive')
    expect(engineApprovalPolicy('qwen', 'autonomous-bounded')).toBe('interactive')
    // Non-qwen engines have no engine-side auto mode: still plain deny.
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded')).toBe('deny')
  })

  it('refuses an unrecognised mode (same blind-cast rationale as engineSessionMode)', () => {
    expect(() => engineApprovalPolicy('qwen', 'hand-edited' as never)).toThrow(/no approval-policy mapping/)
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

  it('builds qwen adapters whose effective session settings match the mapping (the smoke regression)', () => {
    // The smoke bug was NOT a wrong table entry: the table was never applied.
    // These assertions read the adapter the factory actually produced, so a
    // revert to `getEngineAdapter('qwen')` (bare defaults) fails here.
    const bounded = engineAdapterForMuse(
      { engineKind: 'qwen', approvalMode: 'autonomous-bounded' },
      { isolatedCheckout: true },
    )
    expect((bounded as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'allow_once' })

    const sensitive = engineAdapterForMuse({ engineKind: 'qwen', approvalMode: 'ask-for-sensitive-actions' })
    expect((sensitive as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'interactive' })

    const always = engineAdapterForMuse({ engineKind: 'qwen', approvalMode: 'ask-always' })
    expect((always as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'default', policy: 'interactive' })
  })

  it('keeps qwen project-root sessions interactive: allow_once requires the isolation proof', () => {
    const missing = engineAdapterForMuse({ engineKind: 'qwen', approvalMode: 'autonomous-bounded' })
    expect((missing as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'interactive' })

    const shared = engineAdapterForMuse(
      { engineKind: 'qwen', approvalMode: 'autonomous-bounded' },
      { isolatedCheckout: false },
    )
    expect((shared as QwenEngineAdapter).sessionApproval).toEqual({ mode: 'auto', policy: 'interactive' })
  })

  it('builds opencode adapters whose effective policy matches the mapping', () => {
    const bounded = engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'autonomous-bounded' })
    expect((bounded as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'deny' })

    const sensitive = engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'ask-for-sensitive-actions' })
    expect((sensitive as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'interactive' })

    const always = engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'ask-always' })
    expect((always as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'interactive' })
  })

  it('documents the fail-closed fallback an unwired adapter would run with', () => {
    expect(new QwenEngineAdapter().sessionApproval).toEqual({ mode: 'default', policy: 'deny' })
  })
})
