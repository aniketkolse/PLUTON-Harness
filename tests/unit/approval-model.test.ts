import { describe, expect, it } from 'vitest'
import { shipConfigSchema } from '../../src/config/schema.ts'
import { APPROVAL_MODES, APPROVAL_STATUSES } from '../../src/domain/models.ts'
import { engineApprovalPolicy } from '../../src/engines/approval.ts'
import {
  DEFAULT_ENGINE_APPROVAL_MAX_PENDING,
  DEFAULT_ENGINE_APPROVAL_TTL_MINUTES,
} from '../../src/engines/interactive-approval.ts'

/**
 * O2 ratchet (ADR-0018): the approval mode set, its non-permissive default and
 * the "no blanket grant" mapping are decisions, not defaults that can drift.
 *
 * Adding a mode, widening a mapping, or changing the default fails here until
 * ADR-0018 is superseded deliberately.
 */
describe('approval model (ADR-0018)', () => {
  it('pins the three-mode vocabulary', () => {
    expect([...APPROVAL_MODES]).toEqual(['autonomous-bounded', 'ask-for-sensitive-actions', 'ask-always'])
  })

  it('defaults a new Ship to ask-for-sensitive-actions', () => {
    const ship = shipConfigSchema.parse({
      display_name: 'Worker',
      role: 'coder',
      engine: 'opencode',
      model: 'provider/model',
    })
    expect(ship.approval_mode).toBe('ask-for-sensitive-actions')
  })

  it('never maps any mode to a blanket engine grant', () => {
    for (const mode of APPROVAL_MODES) {
      expect(['deny', 'interactive'], `mode '${mode}' must not grant engine consent`).toContain(
        engineApprovalPolicy('opencode', mode),
      )
    }
  })

  it('keeps autonomous-bounded non-granting even in a proven isolated checkout', () => {
    expect(engineApprovalPolicy('opencode', 'autonomous-bounded', { isolatedCheckout: true })).toBe('deny')
  })

  it('routes both ask modes to the operator channel', () => {
    expect(engineApprovalPolicy('opencode', 'ask-for-sensitive-actions')).toBe('interactive')
    expect(engineApprovalPolicy('opencode', 'ask-always')).toBe('interactive')
  })

  it('rejects a stored mode outside the vocabulary instead of silently denying', () => {
    expect(() => engineApprovalPolicy('opencode', 'full' as never)).toThrow(/no approval-policy mapping/)
  })

  it('keeps the declared fail-closed wait bounds', () => {
    expect(DEFAULT_ENGINE_APPROVAL_TTL_MINUTES).toBe(60)
    expect(DEFAULT_ENGINE_APPROVAL_MAX_PENDING).toBe(3)
  })

  it('declares expired as a durable status (timeout is never silent success)', () => {
    expect([...APPROVAL_STATUSES]).toEqual(['pending', 'approved', 'denied', 'expired'])
  })
})
