import { describe, expect, it } from 'vitest'
import { OpenCodeEngineAdapter } from '../../src/engines/opencode/adapter.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { engineAdapterForMuse, engineApprovalPolicy } from '../../src/engines/approval.ts'
import { registerBuiltinEngines } from '../../src/engines/registry.ts'

/**
 * Wiring pinned by the host-mode smoke failure (2026-10-16): nothing mapped a
 * Muse's recorded approval mode onto engine settings, so a worker edit was
 * fail-closed denied while the task still claimed success. These tests pin the
 * fail-closed policy table and the per-Muse factory the supervisor uses.
 */

registerBuiltinEngines()

describe('engineApprovalPolicy', () => {
  it('never upgrades autonomous-bounded to a blanket grant', () => {
    // OpenCode has no engine-side auto-approval mode. Even when the runtime
    // can prove an isolated checkout, Pluton does not fabricate consent.
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded', { isolatedCheckout: true })).toBe('deny')
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded', { isolatedCheckout: false })).toBe('deny')
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded')).toBe('deny')
  })

  it('forwards ask-* modes to the operator channel', () => {
    expect(engineApprovalPolicy('opencode', 'ask-for-sensitive-actions')).toBe('interactive')
    expect(engineApprovalPolicy('opencode', 'ask-always')).toBe('interactive')
    expect(engineApprovalPolicy('mock', 'ask-always')).toBe('interactive')
  })

  it('refuses an unrecognised mode instead of silently falling back to deny', () => {
    // Muse rows are read from the store with a blind cast: a hand-edited or
    // legacy `approval_mode` must fail loudly at adapter construction.
    expect(() => engineApprovalPolicy('opencode', 'hand-edited' as never)).toThrow(/no approval-policy mapping/)
  })
})

describe('engineAdapterForMuse', () => {
  it('builds the engine-specific adapter for the Muse kind', () => {
    expect(engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'autonomous-bounded' })).toBeInstanceOf(
      OpenCodeEngineAdapter,
    )
    expect(engineAdapterForMuse({ engineKind: 'mock', approvalMode: 'ask-always' })).toBeInstanceOf(MockEngineAdapter)
  })

  it('rejects unknown engine kinds loudly (never silently falls back)', () => {
    expect(() => engineAdapterForMuse({ engineKind: 'nope', approvalMode: 'ask-always' })).toThrow(/unknown engine/)
  })

  it('builds opencode adapters whose effective policy matches the mapping', () => {
    const bounded = engineAdapterForMuse(
      { engineKind: 'opencode', approvalMode: 'autonomous-bounded' },
      { isolatedCheckout: true },
    )
    expect((bounded as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'deny' })

    const sensitive = engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'ask-for-sensitive-actions' })
    expect((sensitive as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'interactive' })

    const always = engineAdapterForMuse({ engineKind: 'opencode', approvalMode: 'ask-always' })
    expect((always as OpenCodeEngineAdapter).sessionApproval).toEqual({ policy: 'interactive' })
  })

  it('documents the fail-closed fallback an unwired adapter would run with', () => {
    expect(new OpenCodeEngineAdapter().sessionApproval).toEqual({ policy: 'deny' })
  })
})
