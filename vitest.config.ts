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
      // Measured on the committed suite (2026-10-26, Windows 11 / Node 24.20,
      // 1,253 tests): statements 77.96, branches 69.35, functions 80.22,
      // lines 79.65 (lowest of four full runs; runs vary by a few hundredths).
      // Floors are the integer below each measurement: ~1pp of headroom for
      // platform-specific skips (POSIX-only tests on Windows, etc.).
      thresholds: {
        statements: 77,
        branches: 68,
        functions: 79,
        lines: 78,
      },
    },
  },
})
