# PLUTON 4.0 — GitHub CI Fix & Cross-Platform Verification Report

**Date:** 2026-11-02  
**Repository:** `https://github.com/aniketkolse/PLUTON-Harness`  
**Inspected Commit SHA:** `f0744b8c2a8350743743512a875f208c05a093e9`  
**Current Working Branch:** `main` (synced with `optimization/p0-reliability`)  
**Package:** `pluton-harness@0.1.0`  
**Runtime:** Node.js 24+, TypeScript 5+, SQLite 3, Vitest 5  

---

## 1. Executive Summary

This report documents the root-cause analysis, implementation of repairs, and full verification suite execution for the GitHub Actions CI failures observed on repository `aniketkolse/PLUTON-Harness`.

All runner logs from remote runs `41420909486`, `41421399568`, and `41421399732` across Windows, macOS, and Linux runners were retrieved and analyzed. Two deterministic defects were isolated:
1. `ERR-CI-001` (Application Test Fixture): `tests/installation-upgrade.test.ts` (test 13) ran unmocked `doctor` binary discovery on clean CI runners lacking `opencode` on PATH, causing `doctorExitCode` 1 instead of 0 on Windows, macOS, and Linux.
2. `ERR-CI-002` (CI Configuration): `.github/workflows/ci.yml` lacked the unprivileged user namespace sysctl toggle required on Ubuntu 24.04 (`ubuntu-latest`), causing 16 native execution tests to fail with `SandboxUnavailableError`. (This was already present and passing in `.github/workflows/linux-security.yml`).

Both issues have been repaired with zero functional changes to core runtime, storage, or security policies. Full local validation demonstrates 100% test pass rate across 169 test suites (1,572 passing tests, 10 skipped).

---

## 2. GitHub Error Summary

| Metric | Count | Details |
|---|---|---|
| **Failed Runs Inspected** | 4 | `41421399732`, `41421399568`, `41420909486`, `41406455662` |
| **Actual Defects** | 2 | `ERR-CI-001` (test fixture), `ERR-CI-002` (CI sysctl) |
| **Transient Failures** | 0 | None observed across any run |
| **Infrastructure / Runner Failures** | 0 | All runners executed normally |
| **Unresolved Errors** | 0 | All failure signatures diagnosed and solved |

---

## 3. Root-Cause Analysis & Fix Implementation

### Defect 1: OpenCode Engine Discovery in Clean Environments (`ERR-CI-001`)

- **Failure Symptom:**  
  `tests/installation-upgrade.test.ts > 13. repeated startup: doctor runs successfully on initialized project` failed on `windows-latest`, `macos-latest`, `ubuntu-latest`, and `ubuntu-24.04`.  
  `AssertionError: expected 1 to be +0`
- **Failed Job and Step:**  
  Job: `windows-latest (Node.js 24)`, `macos-latest (Node.js 24)`, `ubuntu-latest (Node.js 24)`, and `Linux Verification Trust Boundary & Confinement Gate`.  
  Step: `Run unit + integration tests` / `Full test suite (Vitest)`.
- **Root Cause:**  
  `pluton init` initializes projects from `templates/teams/full-stack.yaml`, which configures `engine: opencode`. `collectDoctorChecks()` calls `safeAdapter('opencode').discover()`, which looks for `opencode` on PATH or via `PLUTON_OPENCODE_BIN`. On pristine CI runners, no OpenCode executable exists. The check returned status `'fail'`, setting `doctorExitCode(checks)` to `1`. Test 13 asserted `doctorExitCode(r1) === 0`.
- **Affected File:**  
  `tests/installation-upgrade.test.ts`
- **Implemented Fix:**  
  Wired the existing test fixture `tests/helpers/fake-opencode-cli.mjs` (which handles `--version` cleanly) into `tests/installation-upgrade.test.ts` via `beforeAll` and restored in `afterAll`:
  ```typescript
  import { fileURLToPath } from 'node:url'
  import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

  const FAKE_OPENCODE_BIN = fileURLToPath(new URL('./helpers/fake-opencode-cli.mjs', import.meta.url))
  let origOpenCodeBin: string | undefined

  beforeAll(() => {
    origOpenCodeBin = process.env.PLUTON_OPENCODE_BIN
    process.env.PLUTON_OPENCODE_BIN = FAKE_OPENCODE_BIN
  })

  afterAll(() => {
    if (origOpenCodeBin !== undefined) process.env.PLUTON_OPENCODE_BIN = origOpenCodeBin
    else delete process.env.PLUTON_OPENCODE_BIN
  })
  ```
- **Verification:**  
  Tested locally with `PLUTON_OPENCODE_BIN` unset/invalid to reproduce failure, then verified all 14 tests in `tests/installation-upgrade.test.ts` pass cleanly with the fixture.

---

### Defect 2: Linux Unprivileged Namespace Requirement in `ci.yml` (`ERR-CI-002`)

- **Failure Symptom:**  
  16 native execution and sandboxing tests failed on `ubuntu-latest` with:  
  `SandboxUnavailableError: native policy 'workspace-write' + 'open' is not supported on linux: native confinement requires unprivileged user, mount and PID namespaces on this host Fix: enable unprivileged namespaces, or explicitly choose mode: unconfined`
- **Failed Job and Step:**  
  Job: `ubuntu-latest (Node.js 24)`.  
  Step: `Run unit + integration tests` (step 7).
- **Root Cause:**  
  GitHub Actions `ubuntu-latest` is Ubuntu 24.04 LTS, which sets `kernel.apparmor_restrict_unprivileged_userns=1`. The helper binary `native/landlock-run/landlock-run-linux-x64` relies on unprivileged namespaces to enforce filesystem write restrictions without root privileges. In `.github/workflows/linux-security.yml`, this prerequisite was properly configured via `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and `chmod 0755 native/landlock-run/landlock-run-linux-x64`. That step was omitted from `.github/workflows/ci.yml`. In `linux-security.yml`, all 16 of these tests passed.
- **Affected File:**  
  `.github/workflows/ci.yml`
- **Implemented Fix:**  
  Added the prerequisite step to `.github/workflows/ci.yml` for both the `validate` matrix job (gated on `runner.os == 'Linux'`) and the `e2e` job:
  ```yaml
      - name: Enable unprivileged user namespaces (Linux)
        if: runner.os == 'Linux'
        run: |
          set -euo pipefail
          restrict=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)
          if [ "$restrict" = "1" ]; then
            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          fi
          chmod 0755 native/landlock-run/landlock-run-linux-x64 || true
  ```
- **Verification:**  
  Workflow structural integrity verified with `tests/unit/ci-workflow.test.ts` (5/5 passed). Corroborated with successful execution of job `125197533851` in `linux-security.yml` where these identical commands enabled all 16 tests to pass.

---

## 4. Modified & Created Files

| File Path | Action | Purpose |
|---|---|---|
| `tests/installation-upgrade.test.ts` | Modified | Sets `PLUTON_OPENCODE_BIN` to `tests/helpers/fake-opencode-cli.mjs` in `beforeAll`/`afterAll` for clean-runner hermeticity. |
| `.github/workflows/ci.yml` | Modified | Adds Linux unprivileged user namespace configuration step and helper permissions before test execution. |
| `docs/optimization/25-GITHUB-CI-ERROR-AUDIT.md` | Created | Comprehensive audit log of all GitHub Actions runs, failed steps, and root-cause evidence. |
| `docs/optimization/26-GITHUB-CI-FIX-REPORT.md` | Created | Defect remediation report, platform matrix status, and verification evidence. |
| `docs/optimization/PROGRESS.md` | Modified | Updates Phase 5 milestone ledger with CI audit and repair verification results. |

---

## 5. Verification Results

All required local verification steps were executed on the working tree:

| Command | Result | Metrics / Output |
|---|---|---|
| `npm run typecheck` | **PASS** | `tsc -p tsconfig.json` exit code 0, 0 type errors |
| `npm run build` | **PASS** | `tsc -p tsconfig.build.json` exit code 0, `dist/` cleanly compiled |
| `npm test` | **PASS** | **169 test files passed (169/169)**, **1,572 tests passed**, 10 skipped |
| `npm run verify:docs` | **PASS** | 109 files, 48 links checked, 0 broken links |
| `npm run verify:assets` | **PASS** | 60 asset checks passed |
| `npm run test:e2e` | **PASS** | 1 file, 1 test passed |
| `npm run smoke:package` | **PASS** | `npm pack`, clean consumer install, version/help check, path spaces check all passed |
| `npm run release:check -- --allow-dirty` | **PASS** | 17 checks: 16 passed, 0 failed, 1 not tested (POSIX on Windows), 0 blockers |
| Flaky supervisor test repeat (x10) | **PASS** | `tests/integration/supervisor.test.ts` duplicate-intent test passed 10/10 consecutive runs |

---

## 6. Platform Matrix Assessment

| Platform | CI Workflow | Status Prior to Fix | Status After Fix | Evidence |
|---|---|---|---|---|
| **Windows** (`windows-latest`) | `ci.yml` | FAILED (1 test in `installation-upgrade.test.ts`) | **READY** | Test 13 reproduced and verified passing locally on Windows 11; all 169 test suites passing. |
| **macOS** (`macos-latest`) | `ci.yml` | FAILED (1 test in `installation-upgrade.test.ts`) | **READY** | All macOS failures were confined to test 13; fixture mock resolves clean runner absence. |
| **Linux** (`ubuntu-latest`) | `ci.yml` | FAILED (17 tests: test 13 + 16 userns tests) | **READY** | Test 13 resolved via fixture mock; userns resolved via `sysctl` matching `linux-security.yml`. |
| **Linux Gate** (`ubuntu-24.04`) | `linux-security.yml` | FAILED (1 test in `installation-upgrade.test.ts`) | **READY** | All security gate steps passed up to test 13; now resolved via fixture mock. |
| **Linux E2E** (`ubuntu-latest`) | `ci.yml` | **PASSED** (Run ID `41420909486`) | **READY** | Already verified green on remote GitHub runner. |

---

## 7. Remaining Blockers & Next Actions

### Human Authorization Required
In compliance with strict safety directives:
1. **Commit & Push Authorization:** Changes are currently in the working tree. Owner authorization is required to commit and push to `optimization/p0-reliability` and `main`.
2. **Remote Workflow Re-Run:** Once pushed, GitHub Actions runners will automatically execute `CI` and `Linux Security Release Gate` to verify remote green status across Windows, macOS, and Linux runners.
3. **Release Tagging & Publishing:** No tags or npm publishing actions have been taken. The clean release gate (`npm run release:check`) will pass without `--allow-dirty` once the fix commit is recorded.

---

## 8. Current Git Status

- **Current Branch:** `main` (fast-forward merged with `optimization/p0-reliability` at commit `f0744b8c2a8350743743512a875f208c05a093e9`)
- **Remote Tracking:** `origin/main` at `f0744b8`, `origin/optimization/p0-reliability` at `f0744b8`
- **Modified Files:**
  - `.github/workflows/ci.yml`
  - `tests/installation-upgrade.test.ts`
- **Created Documentation:**
  - `docs/optimization/25-GITHUB-CI-ERROR-AUDIT.md`
  - `docs/optimization/26-GITHUB-CI-FIX-REPORT.md`
- **Working Tree:** Controlled, reviewable, ready for owner inspection and commit.
