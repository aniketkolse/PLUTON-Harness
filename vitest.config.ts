import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/*.e2e.test.ts', 'tests/live/**', 'node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
