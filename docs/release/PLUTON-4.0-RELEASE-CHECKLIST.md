# PLUTON 4.0 — Release Checklist

**Date:** 2026-11-02  
**Milestone:** PLUTON 4.0 — Pre-Release Verification & Stability Gate  
**Branch:** `optimization/p0-reliability`  
**Release Candidate Commit:** `0b1948c` (docs: Phase 4 & Phase 5 audits, regression reports, and release checklist)  
**Working Tree:** Clean (Phase 4 & Phase 5 committed across 7 granular commits, pushed to remote)  
**Status:** READY — AWAITING CI RESULTS & PUBLICATION AUTHORIZATION  

---

## 1. Release Candidate Identification

| Item | Value |
| :--- | :--- |
| Version | 0.1.0 |
| Package name | pluton-harness |
| Branch | optimization/p0-reliability |
| Commit | 0b1948c |
| Remote status | Up to date with origin/optimization/p0-reliability |
| Node.js requirement | >=24.0.0 |
| License | Apache-2.0 |

---

## 2. Build and Test Results

| Check | Result | Details |
| :--- | :--- | :--- |
| `npm run typecheck` | PASS | 0 TypeScript errors |
| `npm run build` | PASS | 0 errors |
| `npm test` | PASS | 169 files, 1572 passed, 10 skipped |
| `npm run verify:docs` | PASS | 109 files, 48 links, 0 broken |
| `npm run verify:assets` | PASS | 60 checks |
| `npm run release:check` (clean tree) | PASS | 16/16 passed, 1 not tested, 0 failed, 0 blockers; PUBLICATION: ELIGIBLE |

**Skipped tests (10):** Platform-guarded POSIX/Linux tests on Windows host.

**Not tested (1):** POSIX file permission enforcement (0600) — runs on Linux/macOS CI jobs.

---

## 3. Cross-Platform CI

| Platform | Status | Evidence |
| :--- | :--- | :--- |
| Windows (windows-latest) | TRIGGERED | Pushed to origin/optimization/p0-reliability; awaiting runner results |
| macOS (macos-latest) | TRIGGERED | Pushed to origin/optimization/p0-reliability; awaiting runner results |
| Linux (ubuntu-latest) | TRIGGERED | Pushed to origin/optimization/p0-reliability; awaiting runner results |

**Remote status:** Commits `9b1130b` through `0b1948c` pushed to GitHub with owner authorization. Workflow `.github/workflows/ci.yml` triggers on push. Cross-platform verification recorded once remote runners complete.

**CI workflow configuration:**
- Matrix: windows-latest, macos-latest, ubuntu-latest × Node.js 24
- Stages: typecheck, build, test, verify:docs, verify:assets, release:check, smoke:package
- E2E stage: ubuntu-latest, `npm run test:e2e`
- Permissions: `contents: read` (least privilege)
- No publish/tag/release steps

---

## 4. Flaky Test Investigation

### Test
`tests/integration/supervisor.test.ts` — "suppresses duplicate intent and leaves the duplicate queued"

### Root Cause
The test assumed `dup` (the second-created task) is always the suppressed task. However, `listReadyTasks()` orders by `created_at ASC, id ASC`. Both tasks are created in the same millisecond (same `Date.now().toString(36)` from `newId()`), so the tiebreaker is `id ASC`, which depends on 4 random hex bytes from `crypto.randomBytes(4)`. When `base.id < dup.id` lexicographically, `base` gets dispatched first and `dup` is suppressed — as expected. But when `dup.id < base.id`, `dup` gets dispatched first and `base` is suppressed — contradicting the test's hardcoded assumption that `dup` is always suppressed.

### Correction
Changed `suppressedId` determination from a hardcoded assumption (`dup.id`) to reading actual task state:

```typescript
// Before (broken):
const suppressedIdx = states.indexOf('queued')
const suppressedId = suppressedIdx === 0 ? base.id : dup.id

// After (fixed):
const suppressedId =
  world.store.getTask(base.id).state === 'queued' ? base.id : dup.id
```

### Verification
- Test reproduced: 1 failure in 10 runs before fix
- Test after fix: 10/10 runs pass
- Full test suite: 1570 passed, 10 skipped, 0 failures

---

## 5. Package Integrity

| Check | Result | Details |
| :--- | :--- | :--- |
| Package contents | PASS | 502 files, all 10 required entries present |
| Required files | PASS | `bin/pluton.js`, `dist/cli/main.js`, `dist/server/static-assets.js`, `native/landlock-run/manifest.json`, `templates/teams/full-stack.yaml`, `templates/roles/manager.md`, `README.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`, `package.json` |
| No dev artifacts | PASS | 0 files from `tests/`, `src/`, `docs/` |
| No secrets | PASS | 0 credential/path leak findings |
| Package size | PASS | 4.27 MB (max 50 MB) |
| Dependency audit | PASS | 0 vulnerabilities in production dependencies |
| Production deps | PASS | commander 15.0.0, yaml 2.9.1, zod 4.6.7 |

---

## 6. Clean Package Installation

| Check | Result | Details |
| :--- | :--- | :--- |
| Pack → install in temp prefix | PASS | `npm pack` + `npm install --prefix <tmp>` |
| CLI entry point | PASS | `bin/pluton.js` exists in installed package |
| `--version` | PASS | Reports `0.1.0` |
| `--help` | PASS | Exit code 0 |
| `pluton init` | PASS | Creates `pluton.yaml` + roles + state dirs |
| `pluton doctor --json` | PASS | 18 checks, 0 failures |
| No dev files in package | PASS | Verified by release check |
| No secrets in package | PASS | Verified by release check |

---

## 7. Migration Compatibility

| Item | Status | Details |
| :--- | :--- | :--- |
| Schema version | v14 | `SCHEMA_VERSION` constant in `src/store/migrations.ts` |
| Migration direction | Forward-only | v1 → v2 → … → v14, no downgrades |
| Failed migration behavior | Transaction rollback | `BEGIN IMMEDIATE` + `COMMIT`/`ROLLBACK` |
| Newer schema refusal | PASS | Database with `user_version > 14` is refused |
| Pre-migration backup | PASS | `createVerifiedBackup()` with `VACUUM INTO` + integrity check |
| Existing database upgrade | PASS | Forward migration preserves data |
| Fresh database initialization | PASS | New database created at v14 |

---

## 8. Known Limitations

| # | Limitation | Severity | Disposition |
| :--- | :--- | :--- | :--- |
| 1 | CI not yet executed on GitHub runners | P2 | Workflow defined; requires repository push + owner authorization |
| 2 | macOS/Linux Landlock confinement not tested | P2 | Code-complete; not tested on Windows host |
| 3 | Live OpenCode validation not available | P3 | Binary reports "Location plugins did not finish activating" on this host |
| 4 | No published npm package | P2 | Owner decision required for first public publish |
| 5 | `pluton doctor --init` is basic | P3 | No interactive prompts; remediation hints only |
| 6 | `pluton config` is read-only | P3 | No config editing command |
| 7 | Cross-run model performance bounded to 500 events | P3 | Per-project event log query limit |
| 8 | Duplicate-suppressed tasks block run quiescence | P2 | Intentional design (Ruling 12); operator/manager re-inspects |

---

## 9. Rollback Considerations

- **Database:** Migrations are forward-only (v1–v14). No downgrade path exists. A failed migration is rolled back via transaction, leaving the database at the previous version.
- **Configuration:** `pluton init` never overwrites an existing `pluton.yaml`. `pluton config` is read-only.
- **Package:** Previous versions can be reinstalled via `npm install pluton-harness@<previous-version>`.
- **Data:** User data in `.pluton/` is never modified by the package. `.pluton/` is gitignored and not part of the package.

---

## 10. Required Owner Approvals

| # | Approval | Status | Rationale |
| :--- | :--- | :--- | :--- |
| 1 | **Push repository changes** | COMPLETE | 7 granular commits pushed to origin/optimization/p0-reliability |
| 2 | **First public npm publish** | PENDING | Package is eligible (checks pass); requires owner decision to publish |
| 3 | **CI execution on macOS/Linux** | IN PROGRESS | Pushed; awaiting runner results |
| 4 | **POSIX permission check** | IN PROGRESS | Verified via Linux/macOS CI runner job |

---

## 11. Release Readiness Assessment

| Criterion | Status |
| :--- | :--- |
| Working tree understood | PASS — clean; all Phase 4 & 5 changes committed in 7 granular commits |
| Release candidate identified | PASS — commit 0b1948c (tracked by origin) |
| Cross-platform CI actually passed | PENDING — CI triggered on GitHub runners |
| Flaky test resolved | PASS — duplicate-intent suppression test fixed, 10/10 runs |
| Clean package installation | PASS — version, init, doctor all verified |
| Release checks pass | PASS — 16/16 passed, 1 not tested (POSIX on Windows), 0 blockers |
| No P0/P1 defects | PASS — none identified |
| Reliability guarantees preserved | PASS — all Phase 4/5 guarantees intact |

**Overall: READY — AWAITING CI RESULTS & PUBLICATION DECISION**

The release candidate is technically verified and publication-eligible:
1. Repository changes are committed and pushed to `optimization/p0-reliability`
2. Local release gate reports `TECHNICAL VALIDATION: PASS` and `PUBLICATION: ELIGIBLE`
3. CI workflow is triggered across Windows, macOS, and Linux runners
4. Clean package smoke test passes (4.27 MB package, 0 production vulnerabilities)

---

## 12. Remaining Actions for Owner Decision

1. **Review remote CI results** on Windows, macOS, and Linux
2. **Authorize first npm publish** — `npm publish` (when ready)
3. **Merge branch to `main`** — `git checkout main && git merge optimization/p0-reliability`
4. **Create release tag** — `git tag v0.1.0`

---
