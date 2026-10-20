import { describe, expect, it } from 'vitest'
import { verifyAssets } from '../../scripts/verify-assets.mjs'

/**
 * The embedded SPA is a TypeScript template literal that becomes a browser
 * asset, so two silent hazards exist: a stray backtick truncates the literal,
 * and a single backslash eats the next character. The verifier imports the
 * asset module directly (so the string is exactly what the server serves) and
 * parses the JavaScript with the engine.
 */
describe('embedded SPA assets', () => {
  it('passes every embedded-asset check', () => {
    const { checks, failures } = verifyAssets()
    expect(failures).toEqual([])
    expect(checks.length).toBeGreaterThan(0)
  })

  it('serves JavaScript that parses', async () => {
    const { STATIC_ASSETS } = await import('../../src/server/static-assets.ts')
    const vm = await import('node:vm')
    expect(() => new vm.Script(STATIC_ASSETS['/app.js']!.content)).not.toThrow()
  })
})
