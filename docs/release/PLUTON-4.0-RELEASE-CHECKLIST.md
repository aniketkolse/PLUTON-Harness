# PLUTON 4.0 — Release Checklist

**Date:** 2026-11-02  
**Milestone:** PLUTON 4.0 — Pre-Release Verification & Stability Gate  
**Branch:** `optimization/p0-reliability`  
**Release Candidate Commit:** `9a32bfd` (PLUTON Phase 4 Batch 6: MCP Ecosystem Maturity)  
**Working Tree:** Dirty (uncommitted Phase 4 & Phase 5 changes)  
**Status:** READY WITH BLOCKERS  

---

## 1. Release Candidate Identification

| Item | Value |
| :--- | :--- |
| Version | 0.1.0 |
| Package name | pluton-harness |
| Branch | optimization/p0-reliability |
| Base commit | 9a32bfd |
| Node.js requirement | >=24.0.0 |
| License | Apache-2.0 |

---

## 2. Build and Test Results

| Check | Result | Details |
| :--- | :--- | :--- |
| `npm run typecheck` | PASS | 0 TypeScript errors |
| `npm run build` | PASS | 0 errors |
| `npm test` | PASS | 169 files, 1570 passed, 10 skipped |
| `npm run verify:docs` | PASS | 108 files, 48 links, 0 broken |
| `npm run verify:assets` | PASS | 60 checks |
| `npm run release:check -- --allow-dirty` | PASS | 16/16, 1 not tested, 0 failed |

**Skipped tests (10):** Platform-guarded POSIX/Linux tests on Windows host.

**Not tested (1):** POSIX file permission enforcement (0600) — runs on Linux/macOS CI jobs.

---

## 3. Cross-Platform CI

| Platform | Status | Evidence |
| :--- | :--- | :--- |
| Windows (windows-latest) | BLOCKED | CI workflow defined in `.github/workflows/ci.yml`, not yet executed on GitHub runners |
| macOS (macos-latest) | BLOCKED | CI workflow defined, not yet executed |
| Linux (ubuntu-latest) | BLOCKED | CI workflow defined, not yet executed |

**Blocker reason:** CI workflow has not been triggered because repository changes have not been pushed to GitHub. Per constraints, no push without explicit authorization. Cross-platform verification cannot be claimed until CI runs on actual runners.

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

| # | Approval | Rationale |
| :--- | :--- | :--- |
| 1 | **Push repository changes** | Working tree is dirty with Phase 4 & 5 changes. Push required to trigger CI on GitHub runners. |
| 2 | **First public npm publish** | `package.json` has no `private` flag. `release:check` reports "PUBLICATION: BLOCKED — --allow-dirty override in effect". Publish requires clean commit tree + owner authorization. |
| 3 | **CI execution on macOS/Linux** | Cross-platform verification requires actual CI runner execution. Cannot be claimed from Windows host alone. |
| 4 | **POSIX permission check** | Release check 11 is "NOT TESTED" on Windows. Requires Linux/macOS CI job to verify 0600 file permissions. |

---

## 11. Release Readiness Assessment

| Criterion | Status |
| :--- | :--- |
| Working tree understood | PASS — dirty with documented Phase 4/5 changes |
| Release candidate identified | PASS — commit 9a32bfd + uncommitted changes |
| Cross-platform CI actually passed | BLOCKED — not yet executed on GitHub runners |
| Flaky test resolved | PASS — duplicate-intent suppression test fixed, 10/10 runs |
| Clean package installation | PASS — version, init, doctor all verified |
| Release checks pass | PASS — 16/16, 1 not tested (POSIX on Windows) |
| No P0/P1 defects | PASS — none identified |
| Reliability guarantees preserved | PASS — all Phase 4/5 guarantees intact |

**Overall: READY WITH BLOCKERS**

The release candidate is technically sound but cannot be declared fully READY until:
1. Repository changes are pushed to trigger CI on GitHub runners (owner authorization required)
2. CI passes on Windows, macOS, and Linux
3. Clean commit tree is established for publication

---

## 12. Exact Actions Requiring Owner Authorization

1. **Push changes to `optimization/p0-reliability` branch** — enables CI execution on GitHub runners
2. **Review CI results** on Windows, macOS, and Linux
3. **Establish clean commit tree** — commit Phase 4 & 5 changes
4. **Re-run `release:check` without `--allow-dirty`** — on clean tree
5. **Authorize first npm publish** — `npm publish` (package is not `private`)
6. **Create release tag** — `git tag v0.1.0`

---
