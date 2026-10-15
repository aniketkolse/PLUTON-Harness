import { defineConfig } from 'vitest/config'

/**
 * Opt-in live engine tests (real binaries, real models, real network).
 * Run with `npm run test:live`. Never part of the default check.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
})
