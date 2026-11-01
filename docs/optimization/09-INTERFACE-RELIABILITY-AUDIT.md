# PLUTON 4.0 Phase 3 (P2) — Interface Reliability Audit

**Date:** 2026-11-01  
**Milestone:** Phase 3 (P2), Batch C — TUI / Graphical Workspace Reliability  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (Windows host); POSIX-only sandbox checks remain `BLOCKED BY ENVIRONMENT`

---

## 1. Executive Summary

Batch C audited the TUI and graphical workspace surfaces against the now-durable
run state. The interfaces were already built on the durable event log and REST
state rather than in-memory optimism, so the audit focused on state coverage,
reconnect behavior, and workspace identity. One concrete gap was closed: the
Orchestra inspector's task-state badge did not cover `pending` or
`unknown_outcome`, so those tasks rendered as the generic `[..]` placeholder.

Verification on this host: `npm run typecheck`, `npm run build`, `npm run verify:assets`,
`npm run verify:docs`, and the full TUI/chat/workspace test sets passed.

---

## 2. Surface Inventory

| Surface | Location | Data source | Notes |
| :--- | :--- | :--- | :--- |
| TUI Orchestra inspector | `src/tui/orchestra.ts` | Durable task/ship/approval/event snapshots | State badges per task; verification summary line. |
| TUI state reducer | `src/tui/state.ts` | Engine events + run state | Accumulates streaming/tool/usage; does not fabricate completion. |
| TUI activity refinement | `src/tui/activity.ts` | Durable events | Maps lifecycle events to conversation progress. |
| Full-screen chat session | `src/tui/terminal.ts` + `chat-session*.test.ts` | Durable store + SSE | Reconnect reads persisted state. |
| Server REST/SSE | `src/server/server.ts`, `routes.ts`, `events.ts`, `log-watcher.ts` | Durable store + event log | Forward-only cursor; no history replay on reconnect. |
| SPA (graphical) | `src/server/static-assets.ts` + `src/ui/*` | REST + SSE | Shares the server contract. |
| Desktop launcher | `src/desktop/launcher.ts` | Server instance file | Loopback + token auth. |
| Workspace manager | `src/workspace/manager.ts` | Git checkouts + markers | Reattach/archive/create on restart. |

---

## 3. Reliability Findings and Controls

### 3.1 Durable-state-first rendering

- The Orchestra inspector renders task states from durable rows; `verifying` is
  shown as `[v]` and a verified summary is printed when present.
- The log watcher derives `run_state`/`task_state` SSE frames from the durable
  event log and reads the current store state for each entity, so a reconnecting
  client's REST initial load plus forward deltas converge on the same truth.
- History is never replayed; a fresh client does its REST initial load first.

### 3.2 State coverage fix (closed)

`TaskInspectorItem.state` includes `pending`, `running`, `completed`, `failed`,
`blocked`, `verifying` and now `unknown_outcome` (added to the interface). The
render switch now maps:

- `pending` → dim `[.]`
- `unknown_outcome` → error `[?]`

Previously both fell through to the generic `[..]`, making recovered/unknown tasks
indistinguishable from not-yet-loaded ones.

### 3.3 Workspace identity and restart

- Checkouts are never overwritten or deleted on restart: a valid marker reattaches
  the same checkout (dirty state intact); an invalid marker is archived under
  `.pluton/workspaces-attic`; a missing path provisions a fresh checkout.
- Workspace rows transition `active → archived/removed`; the task's `workspaceId`
  is updated to the fresh row.
- This is covered by T5/T6/T7 in the restart-reconciliation suite.

### 3.4 Approval and verification surfaces

- Pending approvals are rendered in the Orchestra inspector (up to 3, with a
  "+N more" overflow line).
- Verification summary renders when present; `verifying` tasks show `[v]`.
- The new verification status vocabulary (`NOT_REQUIRED`, `PENDING`, `RUNNING`,
  `PASSED`, `FAILED`, `BLOCKED`, `UNKNOWN`) is available to surfaces via
  `src/verify/strategy.ts`.

### 3.5 SSE reconnect

- The broadcaster is a loopback-only, token-authenticated SSE stream.
- The log watcher polls the durable event log at a configurable cadence and
  collapses bursts per entity, so a client that reconnects mid-burst receives
  one frame carrying the final state.
- No server-side state is lost on client disconnect; long waits observe the
  abort signal and return promptly.

---

## 4. Verification Evidence

| Command | Environment | Result |
| :--- | :--- | :--- |
| `npm run typecheck` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run build` | Windows 11, Node.js v24.20.0 | **PASSED** (0 errors) |
| `npm run verify:assets` | Windows 11 | **PASSED** (60 checks) |
| `npm run verify:docs` | Windows 11 | **PASSED** (0 broken links) |
| TUI unit suites (16 files) | Windows 11 | **PASSED** (109/109) |
| Chat-session integration suites (3 files) | Windows 11 | **PASSED** (12/12) |
| Workspace unit/integration suites | Windows 11 | **PASSED** |

No skips reported in the focused suites.

---

## 5. Residual Risks and Follow-ups

1. The graphical SPA is served from compiled static assets; a stale cached build
   can lag behind the server contract. `verify:assets` guards the asset set, but
   cache-busting headers are limited to `no-cache` on `index.html`.
2. Full-screen TUI rendering depends on terminal dimensions; very small
   terminals truncate the Orchestra inspector. This is inherent to the layout.
3. Real-time reactivity during model fallback transitions is not separately
   benchmarked; the fallback path emits `worker.progress` events, but UI latency
   under sustained fallback has not been measured.

---

## 6. Files Changed in Batch C

| File | Change |
| :--- | :--- |
| `src/tui/orchestra.ts` | Added `unknown_outcome` to the task-state interface and badge switch; added `pending` badge. |
| `docs/optimization/09-INTERFACE-RELIABILITY-AUDIT.md` | This audit. |
| `docs/optimization/PROGRESS.md` | Batch C status update. |

---

## 7. Sign-off

Batch C is **OPTIMIZED AND VERIFIED** on this host for TypeScript compilation,
production build, asset verification, documentation links, and the TUI/chat/
workspace test suites. The interface layer is durable-state-first and reconnect-safe.
