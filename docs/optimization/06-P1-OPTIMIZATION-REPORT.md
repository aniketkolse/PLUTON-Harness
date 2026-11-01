# PLUTON 4.0 Phase 2 (P1) Optimization & Hardening Report

**Date:** 2026-11-01  
**Milestone:** Phase 2 (P1 Items) — MCP Tool Bridge Hardening, Test Suite Performance Baseline, and SQLite FTS5 Search Verification  
**Branch:** `optimization/p0-reliability` (local worktree, no unauthorized remote push)  
**Status:** `ALL P1 OBJECTIVES OPTIMIZED AND VERIFIED`  

---

## 1. Executive Summary

Phase 2 (P1 Items) focused on three core engineering areas:
1. **MCP Tool Bridge Concurrency & Buffer Hardening:** Eliminated uncontrolled concurrency on the HTTP bridge, added per-server and per-session concurrency gates, implemented FIFO request queueing with HTTP 429 backpressure, protected against unbounded stream payloads, and wired session lifecycle teardown.
2. **Test Suite Performance Profiling & Baseline:** Profiled the test suite across unit, integration, and domain tiers, identified `cli-integrate.test.ts` as the primary long pole (~247s), uncovered Windows NTFS in-file concurrency hazards (`spawn git ENOENT`), and resolved background OpenCode process storming.
3. **SQLite FTS5 Search Correctness & Security:** Audited and verified query sanitization against SQL/FTS5 parser injection, confirmed index consistency across triggers (`INSERT`, `UPDATE`, `DELETE`), validated BM25 relevance ordering and limit clamping, and tested multilingual Unicode handling.

All cross-subsystem test suites and TypeScript checks pass with zero errors and no regressions.

---

## 2. Phase A: MCP Tool Bridge Concurrency & Buffer Hardening

### 2.1 Problems Addressed
- Prior to this phase, `ToolHttpServer` had no bounds on concurrent requests being processed. High concurrency could overwhelm database connections or CPU workers.
- No backpressure mechanism existed to notify clients when capacity was exhausted.
- Oversized bodies (> 1MB) could consume unbounded memory if a misbehaving client sent gigabytes of continuous data.
- Task sessions remained registered indefinitely until server shutdown.

### 2.2 Implemented Solutions (`src/tools/http-transport.ts`)
1. **Configurable Concurrency Limits:**
   - `maxConcurrentRequests` (default 64): Global in-flight request limit.
   - `maxConcurrentRequestsPerSession` (default 8): Per-session in-flight request limit.
   - `maxQueueDepth` (default 16): Maximum pending requests waiting for a slot.
2. **FIFO Scheduling & Backpressure:**
   - Arriving requests within concurrency bounds acquire a slot immediately.
   - Requests exceeding concurrent capacity enter a FIFO queue.
   - If queue depth reaches `maxQueueDepth`, requests immediately receive HTTP 429 `{ error: 'capacity_exhausted', message: 'tool bridge concurrency capacity exceeded' }`.
   - Queued requests monitor client disconnect (`req.on('close')`, `res.on('close')`); aborted requests are purged from the queue without consuming slots or executing.
3. **Stream Overflow Protection:**
   - If a request body exceeds `maxRequestBytes * 2`, the server calls `req.resume(); break` to safely discard incoming chunks while keeping the socket open to deliver a clean HTTP 413 response.
4. **Session Lifecycle Teardown:**
   - Added `unregisterMatching(predicate)` to `ToolHttpServer`.
   - Added `onTaskTeardown` hook to `RunSupervisor` options, invoked on task finish.
   - In `src/orchestrator/service.ts`, wired `onTaskTeardown` to purge finished task tokens and queued requests (`http.unregisterMatching(spec => spec.taskId === taskId)`).
5. **Code Consolidation:**
   - Removed redundant duplicate `interface ToolBridgeLimits` declaration in `src/tools/bridge.ts`.

### 2.3 Verification
- All 11 tests in `tests/unit/tool-http.test.ts` passing (including concurrency limit enforcement, backpressure 429 rejection, queued abort handling, and token unregistration).
- All 100 tool and MCP tests passing across 6 suites.

---

## 3. Phase B: Test Suite Performance Baseline & Profiling

### 3.1 Profiling Findings
- Total suite execution time: **~350–370 seconds**.
- Longest suite: `tests/integration/cli-integrate.test.ts` (~247 seconds, ~67% of total test duration).
  - Test suite creates 29 fresh Git repositories, performs branch merges, computes SHA-256 worktree content fingerprints, and executes verification processes in disposable directories.
- In-File Concurrency Hazard on Windows:
  - Attempting in-file parallelization (`describe.concurrent`) causes concurrent bursts of `git clone` and process spawns, triggering `WorkspaceError: could not read HEAD of fresh clone: spawn git ENOENT` and NTFS file-locking contention.
  - In-file execution within `cli-integrate.test.ts` must remain sequential on Windows.
- OpenCode Model Discovery Process Storming:
  - Integration tests creating a supervisor without an explicit mock triggered background `opencode models --standalone` CLI invocations.
  - Bypassed in `src/orchestrator/service.ts` when test fixtures provide a custom `adapterFor`.

### 3.2 Documentation
- Detailed profiling timings, bottleneck analysis, and developer workflow recommendations recorded in `docs/optimization/04-TEST-PERFORMANCE-BASELINE.md`.

---

## 4. Phase C: SQLite FTS5 Full-Text Search Audit

### 4.1 Correctness & Security Audit
- Query sanitization in `src/store/fts.ts` (`sanitizeFtsQuery`) extracts tokens using `[\p{L}\p{N}_-]+`, safely dropping FTS5 operator keywords (`AND`, `OR`, `NOT`, `NEAR`), column prefixes, brackets, and quotes.
- Parameterized execution (`MATCH ?`) with prepared statements prevents SQL injection.
- Security test matrix verified against SQL injection payloads (`'; DROP TABLE ...`), FTS operator hijacking, unbalanced quotes, null bytes, and 4,000+ character strings without errors or index corruption.
- Triggers `ai_*`, `ad_*`, and `au_*` reliably synchronize inserts, deletes, and direct SQL updates.
- Limit clamping enforces bounds between 1 and 1000 (`Math.max(1, Math.min(limit, 1000))`).
- BM25 rank ordering and match snippets (`[...]`) verified.
- Typed `rank?: number` property added to `SearchMessageResult` and `SearchEventResult` in `src/store/store.ts`.

### 4.2 Documentation
- Complete FTS5 schema, trigger mechanics, security evaluation, and multilingual tokenizer behavior documented in `docs/optimization/05-FTS5-SEARCH-AUDIT.md`.

---

## 5. Summary of Files Changed

| File | Change Description |
| :--- | :--- |
| `src/tools/http-transport.ts` | Added concurrency limits, FIFO queueing, HTTP 429 backpressure, stream drain caps, and session unregistration. |
| `src/tools/bridge.ts` | Cleaned duplicate `ToolBridgeLimits` interface. |
| `src/orchestrator/supervisor.ts` | Added `onTaskTeardown` hook to `SupervisorOptions` and wired it into task execution teardown. |
| `src/orchestrator/service.ts` | Connected `onTaskTeardown` to `ToolHttpServer.unregisterMatching` for task token cleanup; eliminated background model discovery storms. |
| `src/store/store.ts` | Added `rank?: number` property to `SearchMessageResult` and `SearchEventResult`. |
| `tests/unit/tool-http.test.ts` | Added test cases for concurrency limiting, queue depth, HTTP 429 backpressure, and unregistration. |
| `tests/unit/fts-search.test.ts` | Added comprehensive adversarial security, multilingual, limit clamping, BM25 rank, and UPDATE trigger test cases. |
| `docs/optimization/03-MCP-BRIDGE-AUDIT.md` | Completed Phase A MCP Tool Bridge audit and verification report. |
| `docs/optimization/04-TEST-PERFORMANCE-BASELINE.md` | Completed Phase B test performance baseline and profiling documentation. |
| `docs/optimization/05-FTS5-SEARCH-AUDIT.md` | Completed Phase C SQLite FTS5 search audit and verification documentation. |
| `docs/optimization/06-P1-OPTIMIZATION-REPORT.md` | Completed overall Phase 2 (P1) optimization and reliability report. |
| `docs/optimization/PROGRESS.md` | Updated roadmap tracking ledger with Phase 2 verified milestones. |

---

## 6. Verification Sign-Off

- `npm run typecheck`: **PASSED** (0 errors)
- `npm run build`: **PASSED** (0 errors)
- `tests/unit/tool-*.test.ts` + `mcp-server.test.ts`: **PASSED** (100/100 tests)
- `tests/unit/fts-search.test.ts`: **PASSED** (10/10 tests)
- `tests/integration/supervisor*.test.ts`: **PASSED** (25/25 tests)
- `tests/integration/cli-*.test.ts`: **PASSED** (all CLI suites passing)
- Session isolation, replay-safety, and fallback guarantees: **PRESERVED**
