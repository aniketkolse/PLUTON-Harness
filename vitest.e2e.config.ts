import { defineConfig } from 'vitest/config'

// Opt-in Docker/tmux/live-engine E2E suite. Never part of normal CI:
// requires Docker Desktop (or a Docker engine), tmux in the worker image,
// and — for live engine tests — working engine auth or free models.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
})
