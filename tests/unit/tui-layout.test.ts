import { describe, expect, it } from 'vitest'
import { computeLayout } from '../../src/tui/layout.ts'

describe('computeLayout', () => {
  it('returns tooSmall: true for very small terminals', () => {
    const layout = computeLayout(35, 10)
    expect(layout.tooSmall).toBe(true)
  })

  it('computes two-column layout on wide and tall terminals (>= 120 cols, >= 30 rows)', () => {
    const layout = computeLayout(140, 40, { inspectorOpen: true })
    expect(layout.tooSmall).toBe(false)
    expect(layout.twoColumn).toBe(true)
    expect(layout.inspectorOpen).toBe(true)
    expect(layout.chat.width).toBeGreaterThan(90)
    expect(layout.inspector).not.toBeNull()
    expect(layout.inspector!.width).toBeGreaterThanOrEqual(30)
    expect(layout.chat.width + layout.inspector!.width + 1).toBe(140)
    expect(layout.header.height).toBe(1)
    expect(layout.footer.height).toBe(1)
  })

  it('collapses inspector on narrow terminals (< 120 cols) by default', () => {
    const layout = computeLayout(100, 30)
    expect(layout.tooSmall).toBe(false)
    expect(layout.twoColumn).toBe(false)
    expect(layout.inspectorOpen).toBe(false)
    expect(layout.inspector).toBeNull()
    expect(layout.chat.width).toBe(100)
  })

  it('allocates composer height dynamically between 2 and 5 rows based on draft', () => {
    const l1 = computeLayout(120, 30, { draftLineCount: 1 })
    expect(l1.composer.height).toBe(2)

    const l3 = computeLayout(120, 30, { draftLineCount: 3 })
    expect(l3.composer.height).toBe(3)

    const l10 = computeLayout(120, 30, { draftLineCount: 10 })
    expect(l10.composer.height).toBe(5)
  })

  it('calculates autocomplete popup rect above composer', () => {
    const layout = computeLayout(120, 30, {
      autocompleteOpen: true,
      autocompleteCount: 4,
    })
    expect(layout.autocomplete).not.toBeNull()
    expect(layout.autocomplete!.height).toBe(4)
    expect(layout.autocomplete!.y).toBeLessThan(layout.composer.y)
  })

  it('allocates 6 rows for brand header when brandHeader is true and terminal is wide', () => {
    const layout = computeLayout(129, 48, { brandHeader: true })
    expect(layout.header.height).toBe(6)
    expect(layout.dividerHeader).toBe(6)
  })
})
