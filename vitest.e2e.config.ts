import { defineConfig } from 'vitest/config'

// Orchestration and workspace E2E suite.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
})
