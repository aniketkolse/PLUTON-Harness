# PLUTON 4.0 Phase 3 (P2) — Observability & Performance Audit

**Date:** 2026-11-01  
**Milestone:** Phase 3 (P2), Batch D — Observability & Performance  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host); POSIX-only sandbox checks remain `BLOCKED BY ENVIRONMENT`

---

## 1. Executive Summary

Batch D audited the observability and performance surfaces that let operators and
agents understand a run without trusting prose. The architecture is already
durable-state-first: the event log is the source of truth, SSE deltas are derived
from it, and performance baselines were established in Phase 2.

No new migration or table was added. The audit confirmed the existing surfaces
and recorded their contracts, tuning knobs, and residual limits. `RecoveryManager`
added a `durationMs` field to `RecoveryReport` so recovery latency is itself
observable.

---

## 2. Observability Surfaces

### 2.1 Durable event log

- `events` table is append-only with a monotonic `seq` per run.
- `appendEvent()` redacts secrets, strips control characters, and enforces a
  bounded payload cap (`max_event_payload_chars`).
- `eventsSince()` / `listEvents()` / `listTaskEvents()` provide forward reads;
  recovery uses bounded task-event reads.

### 2.2 SSE delivery

- `ServerEventBroadcaster` (`src/server/events.ts`) serves loopback-only,
  token-authenticated SSE clients and emits a heartbeat every 15 s.
- `ServerLogWatcher` (`src/server/log-watcher.ts`) tails the durable event log at
  a configurable poll interval, derives `run_state`/`task_state` frames, and
  collapses bursts per entity so a client receives one frame carrying the final
  state.
- History is never replayed; a reconnecting client does its REST initial load
  first, then consumes forward deltas.

### 2.3 Run/task activity

- `ActivityMapper` (`src/server/activity.ts`) converts durable events into
  concise conversation progress items. Only meaningful lifecycle transitions,
  communication, blockers and verification become activity; tool chatter stays
  out.
- `buildRunActivity()` maps oldest-first and drops events with no user-facing
  meaning.

### 2.4 Usage and budget

- `getRunUsage()` aggregates per-ship input/output tokens and cost.
- The supervisor records `usage` events through the ledger and enforces the
  run's usage budget; an over-budget turn interrupts the session.

### 2.5 Recovery latency

- `RecoveryReport.durationMs` records how long the recovery pass took, including
  approval expiry, task classification, verification verdicts, and finalization.

---

## 3. Performance Baseline (from `04-TEST-PERFORMANCE-BASELINE.md`)

| Suite / Domain | Tests | Duration | Bottleneck |
| :--- | :--- | :--- | :--- |
| `cli-integrate.test.ts` | 29 | ~247 s | Real Git repos, clones, fingerprints |
| `supervisor*.test.ts` | 63 (after Batch A/B) | ~31–34 s | Multi-agent scheduling, clock ticks |
| `tool-*.test.ts` | 100+ | ~15 s | HTTP sockets, JSON-RPC |
| Other integration | 48+ | ~22 s | CLI subprocesses |
| Unit tests | ~350+ | ~15 s | In-memory store, schema validation |
| **Full suite** | **1480** | **~280 s** | Dominated by cli-integrate + Git I/O |

Full suite result on this host: **162 files, 1470 passed, 10 skipped, 280.31 s**.

### 3.1 Known Windows constraints

- `cli-integrate.test.ts` must remain sequential in-file on Windows NTFS
  (`spawn git ENOENT` under bursts).
- File-level parallelism across independent files is safe and enabled.
- Background OpenCode model discovery is bypassed when test fixtures supply a
  custom `adapterFor`.

### 3.2 Tuning knobs

- `loopPollMs` — supervisor dispatch re-scan cadence (default 20 ms in tests).
- `logWatcherIntervalMs` — SSE tail cadence (configurable, test-tunable).
- `drainBoundMs` — post-loop drain bound for in-flight executors.
- `maxConcurrentWorkers`, `maxTasks`, `maxDelegationDepth` — run budget bounds.
- `maxQueueDepth` / `maxConcurrentRequests` — tool bridge backpressure.

---

## 4. Verification Evidence

| Command | Environment | Result |
| :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm test` | Windows 11, NTFS | **PASSED** (162 files, 1470 passed, 10 skipped, 280.31 s) |

No skips beyond the documented platform-guarded POSIX/Linux tests.

---

## 5. Residual Risks and Follow-ups

1. **No centralized metrics endpoint.** Observability is log/event based; there is
   no Prometheus/OpenTelemetry exporter. Operators rely on the event log and SSE.
2. **Recovery latency is measured but not alerted.** `durationMs` is recorded; a
   slow recovery is visible only by reading the event.
3. **UI latency under sustained fallback** is not benchmarked (carried from Batch C).
4. **Full-suite runtime (~5 min)** is dominated by Git I/O; Linux CI may reduce
   this via tmpfs.

---

## 6. Files Changed in Batch D

| File | Change |
| :--- | :--- |
| `src/orchestrator/recovery.ts` | `RecoveryReport.durationMs` for recovery latency observability. |
| `docs/optimization/10-OBSERVABILITY-PERFORMANCE-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch D status update. |

---

## 7. Sign-off

Batch D is **OPTIMIZED AND VERIFIED** on this host for TypeScript compilation,
production build, and the full test suite. Observability is durable-event-first;
performance baselines are established and unchanged by this batch.
