# PLUTON Phase 5 — Architecture Audit

**Date:** 2026-11-02  
**Milestone:** Phase 5 — Production Hardening & Operator Experience  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `IN PROGRESS`  
**Baseline:** Phase 4 completion reports (`20-PHASE-4-SYSTEM-VALIDATION-AUDIT.md`, `20-PHASE-4-REGRESSION-REPORT.md`, `21-PHASE-4-COMPLETION-REPORT.md`)

---

## 1. Executive Summary

Phase 5 builds on the Phase 4 baseline (all 8 batches `OPTIMIZED AND VERIFIED`). The goal is production hardening and improved operator experience: cross-platform CI, guided initialization (`pluton doctor --init`), configuration management (`pluton config`), durable model-performance aggregation, package integrity validation, and final release-readiness.

**Key finding:** Several Phase 4 "P3" items are already implemented in code but not reflected in documentation:
- `selectToolsForTask()` is implemented in `src/tools/bridge.ts` (P2-2 resolved)
- Tool invocation lifecycle events (`tool.invoked`/`completed`/`failed`) are implemented in `src/tools/bridge.ts` (P3-1 resolved)
- Database migration status is in `pluton doctor` (Batch 7 done)
- `--config` flag and `PLUTON_CONFIG` env var are in `src/cli/main.ts` (Batch 7 done)

Genuinely remaining work:
- Cross-run model performance persistence (in-process only)
- Package size measurement/bounding
- `pluton doctor --init` guided first-run flow
- `pluton config` command
- Cross-platform CI (macOS/Linux untested)

---

## 2. Current Implementation State (Verified Against Code)

### 2.1 MCP Ecosystem (Batch 6) — Verified Implemented

| Item | Status | Location | Evidence |
| :--- | :--- | :--- | :--- |
| `McpCapabilityRegistry` | IMPLEMENTED | `src/tools/mcp-catalog.ts` | `McpToolCapability`, `McpCapabilityRegistry`, `buildCapabilityRegistry()`, `defaultCapabilityRegistry` |
| `selectToolsForTask()` | IMPLEMENTED | `src/tools/bridge.ts:271` | Narrows tools by task writeScope; never expands permissions |
| Tool invocation events | IMPLEMENTED | `src/tools/bridge.ts:392-422` | `tool.invoked`, `tool.completed`, `tool.failed` emitted durably |
| HTTP transport protections | IMPLEMENTED | `src/tools/http-transport.ts` | 64 global / 8 per session, FIFO queue depth 16, HTTP 429/413 |
| Unit tests | 10/10 pass | `tests/unit/mcp-catalog.test.ts` | Verified |

### 2.2 Distribution & Diagnostics (Batch 7) — Verified Implemented

| Item | Status | Location | Evidence |
| :--- | :--- | :--- | :--- |
| `--config` flag | IMPLEMENTED | `src/cli/main.ts:62` | `process.env.PLUTON_CONFIG` set before commander parses |
| `PLUTON_CONFIG` env var | IMPLEMENTED | `src/cli/context.ts` | `requireProject`/`optionalProject` accept configPath |
| DB migration status in doctor | IMPLEMENTED | `src/cli/commands/doctor.ts:122-171` | Schema version, pending migrations, future schema refusal |
| `pluton init` | IMPLEMENTED | `src/cli/commands/init.ts` | Creates config + roles + state dirs; refuses to overwrite |
| Package contents | VERIFIED | `package.json#files` + `release-check.mjs` | 499 files, all required, no dev artifacts, no secrets |
| Release gate | 15/15 PASS | `scripts/release-check.mjs` | 1 not tested (POSIX on Windows) |

### 2.3 Genuinely Remaining from Phase 4

| Item | Status | Location | Notes |
| :--- | :--- | :--- | :--- |
| Cross-run model performance | NOT IMPLEMENTED | `src/engines/model-performance.ts` | `ModelPerformanceMonitor` is in-process only; no durable cross-run aggregation |
| Package size measurement | NOT IMPLEMENTED | `package.json` / `release-check.mjs` | `npm pack` output size not tracked |
| `pluton doctor --init` | NOT IMPLEMENTED | `src/cli/commands/doctor.ts` | No guided first-run flow |
| `pluton config` command | NOT IMPLEMENTED | `src/cli/main.ts` | No dedicated config inspection/editing command |
| Cross-platform CI | NOT IMPLEMENTED | No CI config | macOS/Linux untested |

---

## 3. Phase 5 Batch Plan

### Batch 5.1 — Cross-Platform CI

**Objective:** Automated validation for Windows, macOS, and Linux.

**Dependencies:** None (uses existing npm scripts).

**Migration requirements:** None.

**Implementation boundary:**
- GitHub Actions workflow (`.github/workflows/ci.yml`) or equivalent
- Matrix: windows-latest, macos-latest, ubuntu-latest
- Steps: checkout, setup Node.js v24, install, typecheck, build, test, verify:docs, verify:assets, release:check
- Clearly distinguish passing CI from untested local platforms

**Risks:**
- macOS/Linux runners may not have OpenCode binary (live tests skipped)
- Windows NTFS file locking requires sequential `cli-integrate.test.ts`
- Landlock confinement only available on Linux

### Batch 5.2 — Operator Experience

**Objective:** Guided initialization and configuration management.

**Target capabilities:**
1. `pluton doctor --init` — guided first-run setup
2. `pluton config` — safe configuration inspection and validation
3. Clear recovery guidance
4. No accidental overwriting of existing configuration
5. No exposure of secrets

**Dependencies:**
- Existing `pluton init` (`src/cli/commands/init.ts`)
- Existing `pluton doctor` (`src/cli/commands/doctor.ts`)
- Existing `loadConfig`/`validateConfig` (`src/config/load.ts`)

**Migration requirements:** None (additive commands only).

**Implementation boundary:**
- New file: `src/cli/commands/config.ts` — `pluton config` command
- Modify: `src/cli/commands/doctor.ts` — add `--init` flag
- Modify: `src/cli/main.ts` — register new commands
- No changes to config schema or validation logic

**Risks:**
- `doctor --init` must not overwrite existing config
- Config inspection must not expose secrets

### Batch 5.3 — Tool Invocation Observability (Verification Only)

**Objective:** Confirm tool invocation lifecycle events are durable and correct.

**Status:** Already implemented in `src/tools/bridge.ts`. This batch verifies and adds tests.

**Dependencies:** None (code exists).

**Implementation boundary:**
- Integration test: `tests/integration/mcp.test.ts` — verify `tool.invoked`/`completed`/`failed` events in store
- No code changes needed unless tests reveal gaps

**Risks:** None (verification only).

### Batch 5.4 — Cross-Run Model Performance Persistence

**Objective:** Durable model-performance aggregation across runs.

**Requirements:**
- Preserve unknown values as unknown (never fabricate)
- Define retention and aggregation behavior
- Handle concurrent runs safely
- Keep model-selection adjustments bounded
- Historical observations cannot override hard model eligibility

**Dependencies:**
- `src/engines/model-performance.ts` — `ModelPerformanceMonitor` (in-process)
- `src/store/migrations.ts` — migrations v1–v14
- `src/store/store.ts` — `Store` class

**Migration requirements:** Potentially a new migration (v15) for a `model_performance` table, OR reuse the event log with `run.model_performance` events (already emitted per Batch 5). Per Ruling 5, no new table without owner decision. Prefer event log reuse.

**Implementation boundary:**
- Persist `ModelPerformanceMonitor` observations as `run.model_performance` events (already done in Batch 5 supervisor instrumentation)
- Add cross-run aggregation query on store (read-only)
- No migration if using event log

**Risks:**
- Event volume could be high; need bounded retention
- Cross-run aggregation must not fabricate missing data

### Batch 5.5 — Package and Release Integrity

**Objective:** Validate npm package contents, size, and clean installation.

**Dependencies:** Existing `release-check.mjs`, `smoke-package.mjs`.

**Migration requirements:** None.

**Implementation boundary:**
- Add package size check to `release-check.mjs`
- Verify clean installation from tarball in temp directory
- Verify CLI entry point and startup
- Verify upgrade and migration behavior
- Create reproducible release checklist

**Risks:**
- Package size could grow; need bounding
- Windows `.cmd` shim handling

### Batch 5.6 — Final Release-Readiness Review

**Objective:** Complete Phase 5 documentation and release assessment.

**Deliverables:**
- `docs/optimization/23-PHASE-5-REGRESSION-REPORT.md`
- `docs/optimization/24-PHASE-5-COMPLETION-REPORT.md`
- Update `PROGRESS.md`

---

## 4. Strict Constraints (From Phase 4, Carried Forward)

| Constraint | Status |
| :--- | :--- |
| Preserve all Phase 4 P0/P1 guarantees | Active |
| No unnecessary architectural rewrites | Active |
| Do not silently weaken permission boundaries | Active |
| Do not expose secrets in logs or documentation | Active |
| Do not delete existing migrations or historical records | Active |
| Do not publish to npm | Active |
| Do not push, merge, or perform destructive Git operations without authorization | Active |

---

## 5. Defects Carried Forward from Phase 4

### P2 — Two (documented, no code change required unless owner requests)

| # | Defect | Disposition |
| :--- | :--- | :--- |
| P2-1 | Duplicate-suppressed tasks block run quiescence until deadline | Intentional design (Ruling 12); operator/manager re-inspects |
| P2-2 | Task-aware tool selection (`selectToolsForTask`) | **RESOLVED** — already implemented in `src/tools/bridge.ts` |

### P3 — Three (documented)

| # | Defect | Disposition |
| :--- | :--- | :--- |
| P3-1 | Tool invocation lifecycle events | **RESOLVED** — already implemented in `src/tools/bridge.ts` |
| P3-2 | Cross-run model performance not persisted | Phase 5 Batch 5.4 |
| P3-3 | Package size not measured/bounded | Phase 5 Batch 5.5 |

---

## 6. Acceptance Criteria (Measurable)

| # | Criterion | How Measured |
| :--- | :--- | :--- |
| 1 | Cross-platform CI passes on Windows, macOS, Linux | CI workflow results per platform |
| 2 | `pluton doctor --init` guides first-run setup | Integration test; no config overwrite |
| 3 | `pluton config` inspects/validates config | Unit + integration tests; no secret exposure |
| 4 | Cross-run model performance aggregation | Read-only query over event log; unknown = undefined |
| 5 | Package size measured and bounded | `release-check.mjs` size check |
| 6 | Clean installation from tarball works | `smoke-package.mjs` in temp directory |
| 7 | All Phase 4 regression suites still pass | `npm test` (169 files, 1570 passed, 10 skipped) |
| 8 | Release gate passes | `npm run release:check -- --allow-dirty` |

---

## 7. Sign-off

Architecture audit complete. Implementation begins with Batch 5.1 (Cross-Platform CI).

**Next:** Step 2 — Design and implement cross-platform CI.
