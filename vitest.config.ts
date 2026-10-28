import { defineConfig } from 'vitest/config'

/**
 * Coverage gate (P6). `include` is the whole shipped TypeScript surface; there
 * are deliberately NO excludes, so coverage cannot be raised by deleting a
 * module from the gate. Thresholds are a regression floor measured on the
 * committed suite (see docs/RELEASE.md), not an aspiration: they sit a few
 * points below the measured value to absorb platform-specific skips while still
 * failing on a real drop.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/*.e2e.test.ts', 'tests/live/**', 'node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // Measured on the committed suite (2026-10-28, Windows 11 / Node 24.20,
      // 1,232 tests): statements 77.31, branches 68.52, functions 79.95,
      // lines 78.91 (lowest of two full runs; runs vary by a few hundredths).
      // The native-only migration removed the container modules and their
      // Docker suites, so the previous 1,253-test baseline no longer applied.
      // Targeted tests for native policy/capabilities, CLI output, session
      // commands, JSONL round-trips and workspace resolution restored the
      // unchanged floors; do not lower a floor to absorb missing coverage.
      thresholds: {
        statements: 77,
        branches: 68,
        functions: 79,
        lines: 78,
      },
    },
  },
})
