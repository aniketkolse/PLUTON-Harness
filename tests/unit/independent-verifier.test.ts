import { describe, expect, it } from 'vitest'
import {
  IndependentVerifier,
  detectTestTampering,
  detectSensitiveFiles,
  type VerificationEvidence,
} from '../../src/verify/independent.ts'

describe('detectTestTampering', () => {
  it('detects deleted test files in diff', () => {
    const diff = `
diff --git a/tests/auth.test.ts b/dev/null
deleted file mode 100644
index e69de29..0000000
--- a/tests/auth.test.ts
+++ /dev/null
@@ -1,10 +0,0 @@
-test('login works', () => {
-  expect(login()).toBe(true);
-});
`
    const tampering = detectTestTampering(diff, ['tests/auth.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons).toContain("Deleted test file: 'tests/auth.test.ts'")
  })

  it('detects skipped tests added in diff', () => {
    const diff = `
diff --git a/tests/payment.test.ts b/tests/payment.test.ts
--- a/tests/payment.test.ts
+++ b/tests/payment.test.ts
@@ -10,3 +10,3 @@
-  it('processes payment', async () => {
+  it.skip('processes payment', async () => {
`
    const tampering = detectTestTampering(diff, ['tests/payment.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons[0]).toContain("Disabled/skipped test added in 'tests/payment.test.ts'")
  })

  it('detects xit or test.skip added in diff', () => {
    const diff = `
+  xit('flaky test', () => {})
+  test.skip('broken test', () => {})
`
    const tampering = detectTestTampering(diff, ['tests/worker.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons.length).toBeGreaterThan(0)
  })

  it('detects commented out assertions', () => {
    const diff = `
--- a/tests/unit.test.ts
+++ b/tests/unit.test.ts
@@ -5,3 +5,3 @@
-  expect(status).toBe(200)
+  // expect(status).toBe(200)
`
    const tampering = detectTestTampering(diff, ['tests/unit.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons.some((r) => r.includes('Commented out test assertion'))).toBe(true)
  })

  it('detects focused tests added with .only', () => {
    const diff = `
diff --git a/tests/payment.test.ts b/tests/payment.test.ts
--- a/tests/payment.test.ts
+++ b/tests/payment.test.ts
@@ -10,3 +10,3 @@
-  it('processes payment', async () => {
+  it.only('processes payment', async () => {
`
    const tampering = detectTestTampering(diff, ['tests/payment.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons[0]).toContain("Focused test added in 'tests/payment.test.ts'")
  })

  it('detects removed assertions even when the remaining test still passes', () => {
    const diff = `
diff --git a/tests/total.test.ts b/tests/total.test.ts
--- a/tests/total.test.ts
+++ b/tests/total.test.ts
@@ -20,4 +20,3 @@
   const total = sum(1, 2)
-  expect(total).toBe(3)
   expect(total).toBeGreaterThan(0)
`
    const tampering = detectTestTampering(diff, ['tests/total.test.ts'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons.some((r) => r.includes('Removed test assertion'))).toBe(true)
  })

  it('does not treat assertion-like lines outside test files as tampering', () => {
    const diff = `
diff --git a/src/logger.ts b/src/logger.ts
--- a/src/logger.ts
+++ b/src/logger.ts
@@ -1,2 +1,1 @@
-const assertion = expect(logger).toBeDefined()
`
    const tampering = detectTestTampering(diff, ['src/logger.ts'])
    expect(tampering.tampered).toBe(false)
  })

  it('detects a package test-script swap that would make the suite a no-op', () => {
    const diff = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -7,3 +7,3 @@
   "scripts": {
-    "test": "vitest run",
+    "test": "node -e \\"process.exit(0)\\"",
   }
`
    const tampering = detectTestTampering(diff, ['package.json'])
    expect(tampering.tampered).toBe(true)
    expect(tampering.reasons.some((r) => r.includes('Changed package test script'))).toBe(true)
  })

  it('does not flag an unchanged or newly added package test script', () => {
    const added = `
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -7,2 +7,3 @@
   "scripts": {
+    "test": "vitest run",
   }
`
    expect(detectTestTampering(added, ['package.json']).tampered).toBe(false)
  })

  it('passes on legitimate new tests and unmodified assertions', () => {
    const diff = `
+test('new feature works', () => {
+  expect(myFeature()).toBe('valid')
+})
`
    const tampering = detectTestTampering(diff, ['tests/new-feature.test.ts'])
    expect(tampering.tampered).toBe(false)
    expect(tampering.reasons).toHaveLength(0)
  })
})

describe('detectSensitiveFiles', () => {
  it('detects sensitive files and secret patterns', () => {
    expect(detectSensitiveFiles(['.env', 'src/app.ts'])).toEqual(['.env'])
    expect(detectSensitiveFiles(['.env.production', 'src/app.ts'])).toEqual(['.env.production'])
    expect(detectSensitiveFiles(['id_rsa', 'config/keys.pem'])).toEqual(['id_rsa', 'config/keys.pem'])
    expect(detectSensitiveFiles(['src/index.ts', 'README.md'])).toHaveLength(0)
  })
})

describe('IndependentVerifier', () => {
  it('fails verification if tests were tampered with even if process succeeded', () => {
    const verifier = new IndependentVerifier()
    const diff = `
-  it('authenticates user', () => {
+  it.skip('authenticates user', () => {
`
    const evidence: VerificationEvidence = {
      changedFiles: ['tests/auth.test.ts'],
      gitDiff: diff,
      checkResults: [{ name: 'test', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
      workerClaims: { outcome: 'success', summary: 'all tests pass now' },
    }

    const report = verifier.verifyCriteria(
      'Implement user authentication',
      ['User can log in', 'All auth tests pass'],
      evidence,
    )

    expect(report.verdict).toBe('failed')
    expect(report.tamperDetected).toBe(true)
    expect(report.criteria.find((c) => c.criterion === 'All auth tests pass')?.status).toBe('failed')
  })

  it('fails verification if sensitive files were modified', () => {
    const verifier = new IndependentVerifier()
    const evidence: VerificationEvidence = {
      changedFiles: ['.env', 'src/config.ts'],
      gitDiff: 'diff --git a/.env b/.env\n+SECRET_KEY=123',
      checkResults: [{ name: 'test', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
      workerClaims: { outcome: 'success', summary: 'configured secrets' },
    }

    const report = verifier.verifyCriteria(
      'Configure app settings',
      ['Settings loaded'],
      evidence,
    )

    expect(report.verdict).toBe('failed')
    expect(report.sensitiveExposure).toContain('.env')
  })

  it('verifies criteria when tests pass legitimately and changes match goal', () => {
    const verifier = new IndependentVerifier()
    const diff = `
diff --git a/src/calc.ts b/src/calc.ts
+export function add(a: number, b: number): number { return a + b }
diff --git a/tests/calc.test.ts b/tests/calc.test.ts
+test('adds numbers', () => { expect(add(1, 2)).toBe(3) })
`
    const evidence: VerificationEvidence = {
      changedFiles: ['src/calc.ts', 'tests/calc.test.ts'],
      gitDiff: diff,
      checkResults: [{ name: 'test', command: ['npm', 'test'], status: 'passed', exitCode: 0 }],
      workerClaims: { outcome: 'success', summary: 'implemented add function' },
    }

    const report = verifier.verifyCriteria(
      'Add calculation utility',
      ['add function is implemented', 'tests pass'],
      evidence,
    )

    expect(report.verdict).toBe('verified')
    expect(report.tamperDetected).toBe(false)
    expect(report.criteria.every((c) => c.status === 'verified')).toBe(true)
  })

  it('rejects verified status when worker claims success but no files changed and no checks ran', () => {
    const verifier = new IndependentVerifier()
    const evidence: VerificationEvidence = {
      changedFiles: [],
      gitDiff: '',
      checkResults: [],
      workerClaims: { outcome: 'success', summary: 'Done in my mind' },
    }

    const report = verifier.verifyCriteria(
      'Add new feature',
      ['Feature implemented and tested'],
      evidence,
    )

    expect(report.verdict).toBe('unverified')
    expect(report.criteria[0]?.status).toBe('unverified')
  })
})
