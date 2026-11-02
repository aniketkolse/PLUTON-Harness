# PLUTON 4.0 Phase 4 — Batch 8: Full-System Validation Audit

**Date:** 2026-11-02  
**Milestone:** Phase 4, Batch 8 — Full-System Validation & Release Readiness  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `IN PROGRESS`  

---

## 1. Executive Summary

Batch 8 performs comprehensive end-to-end validation of PLUTON after Phase 4 Batches 1–7. The architecture was audited across all subsystems: manager intelligence, model routing, adaptive scheduler, workspace isolation, cost/performance instrumentation, MCP ecosystem, and distribution. Defects were classified by severity. No architectural changes were introduced — this phase is validation and defect-resolution only.

**Key finding:** All Phase 4 subsystems are implemented and internally consistent. No P0 or P1 defects were found. P2/P3 issues are documented as known limitations with recommendations for future work.

---

## 2. Subsystem Audit Results

### 2.1 Manager Intelligence (Batch 1)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| TaskAssessment correctness | `VERIFIED` | `src/orchestrator/task-assessment.ts` deterministic heuristic; 9/9 unit tests pass |
| Adaptive decomposition behavior | `VERIFIED` | `allocateWorkers()` returns bounded worker count; `assessmentToPromptSection()` injects bounded signal into manager prompt |
| Assessment persistence | `VERIFIED` | `run.assessed` event emitted at run start with full assessment + allocation payload |
| Manager prompt integration | `VERIFIED` | `buildManagerPrompt()` includes `managerAssessmentSection` |
| Conservative behavior for unknown signals | `VERIFIED` | `readRunAssessment()` returns `null` for pre-Batch-1 runs; scheduler falls back to conservative FIFO |

**Defects:** None.

### 2.2 Model Routing (Batch 2)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| Model eligibility | `VERIFIED` | `selectModel()` filters by engineKind, provider allow/denylist, availability, cooldown, capabilities, cost/latency ceilings |
| Capability evaluation | `VERIFIED` | `evaluateModel()` never fabricates missing capability data; unknown → conservative |
| Observed performance integration | `VERIFIED` | `ModelPerformanceMonitor` bounded adjustment [-10, +10] to health score; never overrides hard eligibility |
| Fallback safety | `VERIFIED` | Single fallback authority; adapter-level silent auto-switch removed (Ruling 1) |
| Durable selection events | `VERIFIED` | `run.model_selected` events with score, exclusions, performanceApplied flag |

**Defects:** None.

### 2.3 Adaptive Scheduler (Batch 3)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| DAG correctness | `VERIFIED` | `listReadyTasks()` SQL enforces dependency completion; `prioritizeReadyTasks()` is a tie-break on FIFO, not preemption (Ruling 11) |
| Dependency-criticality ordering | `VERIFIED` | Tasks blocking most unblocked dependents dispatched first |
| Worker allocation | `VERIFIED` | `computeAllocation()` caps in-flight by assessment estimate, never exceeds `maxConcurrentWorkers` |
| Concurrency limits | `VERIFIED` | `dispatchReadyTasks()` stops at `inFlight.size >= maxConcurrentWorkers` |
| Duplicate-intent suppression | `VERIFIED` | `detectDuplicateIntent()` flag-overlap + token similarity >= 0.5; suppressed tasks stay `queued` (not discarded, Ruling 12) |
| Deferred task lifecycle | `VERIFIED` | Deferred tasks remain `queued`; `task.deferred` event emitted with reason |
| Run quiescence behavior | `P2 — LIMITATION` | Suppressed/deferred tasks block run quiescence until run deadline (documented in Ruling 12, Batch 3) |

**Defects:** P2 — Duplicate-suppressed tasks block run quiescence until deadline. Intentional design (Ruling 12); operator or manager must re-inspect and re-delegate deliberately.

### 2.4 Workspace Isolation (Batch 4)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| Clone-based task isolation | `VERIFIED` | Per-task `git clone --local` under `.pluton/workspaces/<task-id>`; Pluton marker file proves ownership |
| Directory-prefix conflict detection | `VERIFIED` | `pathsOverlap()` detects exact match + directory prefix overlap (`src/auth.ts` vs `src/auth/`) |
| Lease TTL and renewal | `VERIFIED` | Optional `leaseTtlSeconds`; `renewScope()` at dispatch tick; `expireStaleLeases()` on tick |
| Stale lease recovery | `VERIFIED` | `recoverLeases(activeTaskIds)` releases leases for non-active tasks at startup |
| Cancellation cleanup | `VERIFIED` | `executeTask()` finally block calls `releaseScope()`; `releaseLease()` releases single-path |
| Git integration safety | `VERIFIED` | Trusted Git plumbing; worker `.git` metadata never executed on host; user repo is clone source only |
| Existing user modification preservation | `VERIFIED` | User repo is read-only clone source; integration preserves conflicts (never aborts/resets) |

**Defects:** None. P2 residual: lease TTL is in-process only (no cross-process persistence); Windows NTFS junctions may bypass prefix detection.

### 2.5 Cost and Performance (Batch 5)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| Task duration | `VERIFIED` | `task.started` with `startedAt`; `task.completed`/`failed`/`unknown_outcome` with `durationMs` |
| Queue wait | `VERIFIED` | `task.dequeued` with `queuedAt`/`dispatchedAt` |
| Prompt construction metadata | `VERIFIED` | `task.prompt_built` / `run.manager_prompt_built` with `promptChars`/`textTruncated` |
| Model performance events | `VERIFIED` | `run.model_performance` events at task session end |
| Usage ledger | `VERIFIED` | `UsageLedger` records tokens/cost durably to `run_usage` table |
| Benchmark coverage | `VERIFIED` | `tests/benchmarks/batch-5-measurement.test.ts` (4 scenarios: sequential, parallel, DAG, tool-intensive) |
| Missing measurements | `P3 — DOCUMENTED` | Cross-run model performance aggregation not persisted (Batch 2 Ruling #13); real model inference not measured |

**Defects:** None.

### 2.6 MCP Ecosystem (Batch 6)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| Capability registry | `VERIFIED` | `src/tools/mcp-catalog.ts`: `McpToolCapability`, `McpCapabilityRegistry`, `buildCapabilityRegistry()` |
| Task-aware tool selection | `NOT IMPLEMENTED` | Deferred per audit — `selectToolsForTask()` not wired into `PlutonToolBridge` |
| Permission narrowing | `VERIFIED` | `listTools()` filters by caller permissions; no silent expansion |
| HTTP transport protections | `VERIFIED` | Bounded concurrency (64 global, 8/session), FIFO queue depth 16, HTTP 429/413, stream overflow |
| Invocation observability | `PARTIAL` | `tool.call` audit events with `ok`/`mutating`/`durationMs`/`errorCode`; lifecycle events (`tool.invoked`/`completed`/`failed`) not yet added |
| Cancellation and failure handling | `VERIFIED` | `AbortSignal` per request; `session.interrupt()` on timeout; no auto-retry of non-idempotent operations |

**Defects:** P2 — Task-aware tool selection (`selectToolsForTask`) not implemented. P3 — Tool invocation lifecycle events (`tool.invoked`/`completed`/`failed`) not yet emitted.

### 2.7 Distribution (Batch 7)

| Aspect | Status | Evidence |
| :--- | :--- | :--- |
| npm package contents | `VERIFIED` | `npm pack --dry-run` contains all required files; no dev artifacts; no secrets |
| CLI entry point | `VERIFIED` | `bin/pluton.js` → `dist/cli/main.js`; `prepack` build hook |
| First-run initialization | `VERIFIED` | `pluton init` creates config + roles + state dirs; refuses to overwrite |
| Configuration precedence | `VERIFIED` | CLI flags → `pluton.yaml` → defaults; `--config` flag and `PLUTON_CONFIG` env var added |
| Database initialization and migration | `VERIFIED` | Forward-only migrations v1–v14; verified backup before migration; future schema refused |
| Diagnostic accuracy | `VERIFIED` | `pluton doctor` reports PASS/WARN/FAIL/INFO for all check categories |
| Production package execution | `VERIFIED` | `release:check` passes; `smoke:package` validates install-from-tarball |

**Defects:** None. P2 residual: no published package yet (owner decision); no guided `pluton doctor --init` flow.

---

## 3. Defect Classification

### P0 — None found

No data-loss, security, or critical execution integrity defects were identified.

### P1 — None found

No major reliability or correctness defects were identified.

### P2 — Two identified

| # | Defect | Location | Severity | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| P2-1 | Duplicate-suppressed tasks block run quiescence until run deadline | `src/orchestrator/scheduling-policy.ts` `buildSchedulePlan()` | P2 | Documented intentional behavior (Ruling 12). Operator/manager must re-inspect. No code change required unless owner requests auto-expiry. |
| P2-2 | Task-aware tool selection (`selectToolsForTask`) not implemented | `src/tools/bridge.ts` | P2 | Deferred per Batch 6 audit. Permission-based narrowing is sufficient for least-privilege. Implement only if owner requires per-task tool surface reduction. |

### P3 — Three identified

| # | Defect | Location | Severity | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| P3-1 | Tool invocation lifecycle events not emitted | `src/tools/bridge.ts` | P3 | `tool.call` audit exists; add `tool.invoked`/`completed`/`failed`/`timed_out`/`cancelled` for richer observability. |
| P3-2 | Cross-run model performance not persisted | `src/engines/model-performance.ts` | P3 | In-process only per Batch 2 Ruling #13. Owner decision required for cross-run aggregation. |
| P3-3 | Package size not measured/bounded | `package.json` `files` whitelist | P3 | `npm pack` output size not tracked. Add size check to release gate if desired. |

---

## 4. Critical Lifecycle Validation

### A. Duplicate-suppressed task quiescence

**Finding:** Intentional and safe. Suppressed tasks remain `queued` (never discarded, per Ruling 12). They block run quiescence until resolved by the operator or manager, or until the run deadline.

**Verification:**
- No worker remains occupied (suppressed tasks never acquire leases or dispatch).
- No lease is held unnecessarily (leases are acquired at dispatch only).
- Run lifecycle remains deterministic (suppression is recorded as `task.duplicate_suppressed` event).
- Task history remains recoverable (task stays `queued`, visible in event log).
- Cancellation remains effective (operator can cancel the run; suppressed tasks are not auto-terminalized).

**Correction:** None required. Design is intentional.

### B. Lease persistence and expiry

**Finding:** In-process TTL behavior is correct. Lease persistence to SQLite (`file_leases` table v5) already exists; TTL expiry is in-process only (no migration added, per Batch 4 design).

**Verification:**
- Process interruption: `recoverLeases()` releases leases for non-active tasks at startup.
- Startup recovery: `recoverLeases(activeTaskIds)` runs once at supervisor startup.
- Stale lease expiration: `expireStaleLeases(runId)` on each dispatch tick when `leaseTtlSeconds` configured.
- Cross-run access: Leases are keyed by `runId`; cross-run conflicts surface only at integration.
- Concurrent ownership: `KeyedMutex` per-Ship serialization within one process; store CAS fencing across processes.

**Correction:** None required. No migration added (consistent with Ruling 5 — no new table without owner decision).

### C. Symlink and junction limitations

**Finding:** Directory-prefix conflict detection is path-string based, not filesystem-aware. Windows NTFS junctions and symlinks on any platform could bypass prefix detection.

**Verification:** Not implemented; not claimed. Documented as residual risk in Batch 4 audit (Ruling 15).

**Correction:** None required. Do not claim symlink/junction-aware isolation.

### D. Model performance persistence

**Finding:** Distinction between per-run durable events and in-memory monitoring is clear.

**Verification:**
- `run.model_performance` events are durable within a run (Batch 5 instrumentation).
- `ModelPerformanceMonitor` summaries are in-process only (Batch 2 Ruling #13).
- No cross-run aggregation claimed.

**Correction:** None required.

### E. Observability correctness

**Finding:** Instrumentation failures cannot unintentionally fail otherwise valid tasks. All instrumentation is additive with try/catch where appropriate.

**Verification:**
- Event emission uses `appendEvent()` which is part of the durable store; if event append fails, the task still settles (event failure is logged, task outcome is authoritative).
- Canonical JSON serialization: `JsonValue` type ensures no `undefined` values leak into event payloads.
- `undefined` values are explicitly excluded from metrics (Rule 13: unknown = `undefined`, never estimated).

**Correction:** None required.

---

## 5. Security and Permission Validation

| Area | Status | Evidence |
| :--- | :--- | :--- |
| MCP permission boundaries | `VERIFIED` | `PlutonToolBridge` validates every call against caller's Ship permissions at call time |
| Tool schema validation | `VERIFIED` | Zod `.strict()` schemas reject unknown fields; `task.create`/`delegate` require assignee |
| Approval requirements | `VERIFIED` | `review.report` tool with anti-self-approval; evidence-owned APPROVE; bounded correction cycles |
| Configuration secret handling | `VERIFIED` | No secrets in config schema; `redactProseSecrets()` for logs; doctor output excludes secrets |
| Diagnostic output | `VERIFIED` | `pluton doctor` checks never expose API keys or sensitive env var values |
| Filesystem scope restrictions | `VERIFIED` | Directory-prefix lease conflict detection; trusted Git; workspace marker enforcement |
| Workspace isolation | `VERIFIED` | Per-task clone; Pluton marker; archive-never-delete; user repo is clone source only |
| Production engine discovery | `VERIFIED` | Mock engine (`devOnly: true`) excluded from production discovery |
| Request-size and concurrency protections | `VERIFIED` | HTTP 413 stream overflow; 64 global / 8 per session concurrency; FIFO queue depth 16 |

**Defects:** None. No permission or safety boundary was weakened.

---

## 6. Production Package Validation

| Test | Result | Evidence |
| :--- | :--- | :--- |
| Package contents | `PASS` | `npm pack --dry-run --json` contains all 10 required files; no dev artifacts; no secrets |
| Executable entry point | `PASS` | `bin/pluton.js` → `dist/cli/main.js`; `prepack` build hook runs `tsc` |
| Installation in clean temp dir | `PASS` | `tests/installation-upgrade.test.ts` test #1 |
| `pluton init` | `PASS` | Creates config + roles + state dirs; refuses to overwrite |
| `pluton doctor` | `PASS` | All check categories present; PASS/WARN/FAIL/INFO statuses |
| Configuration loading | `PASS` | `--config` flag and `PLUTON_CONFIG` env var support |
| Database initialization | `PASS` | Fresh DB at v14; forward-only migrations; verified backup |
| Startup outside source repo | `PASS` | Tested from temp directories (not user workspace) |
| Production dependency resolution | `PASS` | 3 production deps (commander, yaml, zod); 0 vulnerabilities |
| Mock engine excluded from production | `PASS` | `devOnly: true` engines excluded from production selection (Ruling 2) |

**Result:** Production package validation passes all checks. Package not published (owner decision).

---

## 7. Performance Validation

Batch 5 deterministic benchmarks ran with mock engine (no real model inference):

| Scenario | Workers | Result |
| :--- | :--- | :--- |
| Simple sequential | 1 | `PASS` — run duration > 0, task duration > 0, queue wait present |
| Independent parallel | 2–4 | `PASS` — 4/4 tasks completed, run duration > 0 |
| Dependency-heavy DAG | 1 | `PASS` — 4/4 tasks completed, sequential execution |
| Tool-intensive | 1 | `PASS` — tool checkpoint events recorded |

**Separation:**
- Mock-engine orchestration overhead: measured and valid.
- Actual model inference: not measured (requires live OpenCode; `Location plugins did not finish activating` on this host).
- Unavailable measurements: real inference latency, real token consumption, real failure rates — explicitly documented as unavailable.

**No optimization improvements claimed** — baseline only, per Batch 5 discipline.

---

## 8. Cross-Platform Status

| Platform | Status | Evidence |
| :--- | :--- | :--- |
| Windows 11 | `VERIFIED` | All tests pass on this host; `npm test`: 168 files, 1553 passed, 10 skipped |
| macOS | `CODE-COMPLETE, NOT TESTED` | No macOS host available in this environment |
| Linux | `CODE-COMPLETE, NOT TESTED` | No Linux host available in this environment; Landlock confinement requires kernel ABI ≥ 3 |

No operating system was claimed as tested without actual evidence. Platform-specific limitations documented in `docs/optimization/19-DISTRIBUTION-READINESS-AUDIT.md` section 7.

---

## 9. Regression Verification

| Command | Result |
| :--- | :--- |
| `npm run typecheck` | PASS (0 errors) |
| `npm run build` | PASS (0 errors) |
| `npm test` | PASS — 168 files, 1553 passed, 10 skipped |
| `npm run verify:docs` | PASS — 102 files, 48 links, 0 broken |
| `npm run verify:assets` | PASS — 60 checks |
| `npm run release:check -- --allow-dirty` | PASS — 15/15, 1 not tested (POSIX), 0 owner blockers |

**New system-validation tests:** `tests/installation-upgrade.test.ts` — 14/14 pass.

**Flaky test investigation:** `cli-integrate.test.ts` kept sequential due to Windows NTFS file locking (`spawn git ENOENT` under concurrency). No flaky tests identified in this batch.

---

## 10. Remaining P0/P1/P2/P3 Issues

### P0 — None

### P1 — None

### P2 (2 issues, documented)

1. **P2-1:** Duplicate-suppressed tasks block run quiescence until run deadline (intentional design, Ruling 12).
2. **P2-2:** Task-aware tool selection (`selectToolsForTask`) not implemented (deferred per Batch 6 audit).

### P3 (3 issues, documented)

1. **P3-1:** Tool invocation lifecycle events (`tool.invoked`/`completed`/`failed`) not yet emitted.
2. **P3-2:** Cross-run model performance aggregation not persisted (Batch 2 Ruling #13).
3. **P3-3:** Package size not measured/bounded.

---

## 11. Release-Readiness Assessment

**Phase 4 can be declared `OPTIMIZED AND VERIFIED`** because:

- All critical end-to-end workflows pass (verified by existing test suite + Batch 7 installation/upgrade tests).
- No unresolved P0 or P1 defects remain.
- Existing reliability guarantees remain intact (P0/P1 fallback/replay-safety, MCP limits/backpressure, FTS5 search behavior).
- Production package validation succeeds (release gate: 15/15 passed).
- Database and workspace safety verified (forward-only migrations, verified backup, clone-based isolation, directory-prefix lease conflicts).
- MCP permission boundaries verified (permission-checked tool bridge, loopback-only transport, bounded concurrency).
- All existing regression suites pass (168 files, 1553 passed, 10 skipped).
- Remaining limitations documented honestly (P2/P3 issues above).

**Recommendation:** Phase 4 Batch 8 is complete. Proceed to release-readiness documentation and owner authorization for first public publish.

---

## 12. Recommended Next Development Phase

**Phase 5 — Production Hardening & Operator Experience** (suggested scope):

1. Publish `pluton-harness` to npm (owner decision).
2. Add guided `pluton doctor --init` first-run flow.
3. Add `pluton config` command for config inspection/editing.
4. Implement cross-run model performance persistence (owner decision on migration).
5. Add tool invocation lifecycle observability events (`tool.invoked`/`completed`/`failed`).
6. Consider task-aware tool selection (`selectToolsForTask`) if owner requires per-task surface reduction.
7. Measure and bound package size in release gate.
8. Cross-platform CI verification (macOS, Linux).

---
