# PLUTON Implementation Roadmap — Phase 1 audit output

**Date:** 2026-10-18 · **Baseline:** `main` @ `506fa72` — typecheck/build/unit/E2E green (`docs/PLUTON_BASELINE_REPORT.md`)
**Inputs:** `docs/PLUTON_FEATURE_PARITY.md` (gap analysis), `docs/PLUTON_ARCHITECTURE.md` (as-built), the four reference volumes, and the conversation requirements R1–R5.

## Guardrails (from the mission)

- Do not rewrite the repository; preserve the existing backend and agent execution logic.
- Do not assume a feature is required because it exists in the reference harness; every phase names the Pluton goal it serves.
- No claim of "done" without executable evidence; every phase lists acceptance tests and a rollback.
- Backward compatibility by default: config schema is `.strict()`, DB migrations are forward-only, no silent behavior changes.
- Nothing below is started. This phase produced documents only.

## Phase status

| Phase | Goal | Status |
|---|---|---|
| P0 | Baseline integrity | ✅ Done — all executed suites green (2026-10-18) |
| P1 | Guardrails and honesty (small, foundational) | ▶ In progress — PR-1 ✅ + PR-2 ✅ in the working tree (2026-10-18, uncommitted); PR-3 next |
| P2 | Observability: session query/projection + replay | Planned |
| P3 | Approval channel and tool pipeline seams | Planned (one open decision) |
| P4 | Machine interfaces: SDK / API gateway | Decision-gated |
| P5 | Composition kernel (dsh §02–§06 parity) | Decision-gated (ADR first) |
| P6 | Quality gates and delivery | Ongoing |

Explicit non-goals unless the owner requests them: Cordis plugin market/resolvers, HMR, Electron desktop, Python wheel, web-UI parity, PTC/workflow engine. These are dsh capabilities with no demonstrated Pluton need (see parity doc §F).

---

## P1 — Guardrails and honesty (next)

### PR-1 (recommended first PR): Enforce configured usage budgets; wire `max_retries_per_task`

**Why first:** it is the smallest change that turns an already-landed feature slice (usage tracking, commit `d5938cf`) into an actual guardrail; it is fully isolated; it closes G1 and L3 from the audit; it provides the cost/token control multi-agent runs need before any scaling work.

**Problem evidence (verified):**
- Budget logic exists and is unit-tested (`src/orchestrator/usage-ledger.ts:118–173`; `tests/unit/usage-ledger.test.ts`; `tests/integration/multi-agent-reliability.test.ts:244`) but the supervisor builds the ledger with `undefined` limits (`src/orchestrator/supervisor.ts:226`) and `createRunSupervisor` passes none (`src/cli/commands/run.ts:261–306`).
- `runtimeConfigSchema` has no token/cost fields (`src/config/schema.ts:43–63`).
- `runtime.max_retries_per_task` exists (default 1, `schema.ts:54`) but is never passed; the effective supervisor default is 2 (`supervisor.ts:227`).

**Changes (specific):**
1. `src/config/schema.ts` — add optional fields to `runtimeConfigSchema` (absent = current behavior; safe bounds; field-level errors):
   `max_run_input_tokens`, `max_run_output_tokens`, `max_run_cost_usd`, `max_muse_input_tokens`, `max_muse_output_tokens`, `max_muse_cost_usd` (ints ≥ 1 / numbers > 0 with conservative maxima).
2. `src/orchestrator/run-setup.ts` — add `usageBudgetsFromRuntime(runtime): BudgetLimits | undefined` (returns `undefined` when no field is set) and add `maxRetriesPerTask` to `SupervisorSettings` (from `runtime.max_retries_per_task`).
3. `src/cli/commands/run.ts` (`createRunSupervisor`, ~line 261) — pass `usageLedger: new UsageLedger(run.id, budgets, store)` when budgets exist, and `maxRetriesPerTask: settings.maxRetriesPerTask`.
4. Tests:
   - `tests/unit/run-setup.test.ts` — mapping: undefined when unset; correct mapping when set; retries mapped.
   - `tests/integration/supervisor-usage-budget.test.ts` (new, mock engine) — scripted usage events exceed a tiny budget → session interrupted at the next usage event; `run_usage` rows persisted; diagnostic/event recorded. Retry-wiring assertions: `max_retries_per_task: 0` → exactly one attempt (no `task.retry_scheduled`); `: 2` → retry scheduled up to the bound.
5. Note in `docs/ROADMAP.md` status paragraph (docs follow code, per R4 honesty rules).

**Acceptance criteria:**
- With no new keys, `npm run check` is unchanged-green (backward compatible).
- With a budget configured, a run whose recorded usage exceeds it is interrupted and the breach is durable and inspectable (usage rows + event/diagnostic), never silent.
- Retry attempt counts follow `runtime.max_retries_per_task` exactly.
- Out-of-range values are rejected at load with field-level errors.

**Validation commands (exact):**
```powershell
npx vitest run tests/unit/run-setup.test.ts tests/integration/supervisor-usage-budget.test.ts
npm run check
$env:PLUTON_E2E_DOCKER='1'; npm run test:e2e   # regression: expected 5/5
```

**Rollback:** revert the single commit; remove the new keys from any `pluton.yaml` first (the schema is `.strict()`, so an older build rejects unknown keys); no DB migration, no on-disk state change. Risk note: engine-reported `cost_usd` may be 0 on free models, so token budgets are the dependable axis — document this in the config comments.

### PR-2: Honest TUI usage display (small)

Replace the fabricated constants path (`src/chat/session.ts:71–72, 1045–1050`): show tokens as reported; show cost only when the engine reported it; show context % only when a real context window is known, otherwise render "unknown". Tests: unit assertions for all three states. Rollback: revert; display-only.

**Landed 2026-10-18 (working tree, uncommitted):** `usage.costUsd` accumulates in `src/tui/state.ts` (null until an engine reports one); the status bar renders `Context: unknown` when no real window is known and omits cost when unreported (`src/ui/status.ts`); `ChatSession` passes only reported telemetry (`src/chat/session.ts`). Verified: targeted 24/24, `npm run check` 777/90, Docker E2E 5/5.

### PR-3: Transport retry for side-effect-free phases

Bounded exponential backoff + jitter for engine **spawn and transport handshake** only (`src/engines/acp/client.ts` `start()` path; adapter `startSession`). Explicit non-goal: retrying a prompt that may have reached the model (ADR-0006 A2: never blindly resend). Tests: injected spawn fails N times then succeeds → one session, N+1 spawns, capped delay; prompt-phase failures unchanged. Rollback: revert; no protocol change.

### P1 exit criteria

G1, L2, L3, G3 closed with tests; all suites green; no config/schema break for existing projects.

---

## P2 — Observability: session query, projections, replay

**Goal:** make the append-only log queryable, so the operator, audit, and future SDK do not re-scan raw rows (parity §09–§11).

**Items:**
1. Read-model module (e.g. `src/store/query.ts`) over `events`, `tasks`, `approvals`, `run_usage`, `chat_messages`: "tasks by state in run", "pending approvals", "usage per Muse", "recent events since seq".
2. Seq-cursor replay API (Last-Event-ID semantics) resolving O1; decision recorded as an ADR; CLI surface `pluton logs --json` reusing it.
3. Optional: session export/import (JSONL) — reuses the engine contract's `sessionExport` capability (currently unused).

**Acceptance tests:** projection queries against fixture stores; cursor reconnect test (no gaps, no duplicates). **Rollback:** additive module + ADR; no schema change (optionally a new migration for indexes only, which is forward-only). **Depends on:** P1 done (not strictly required, but sequencing keeps diffs small).

## P3 — Approval channel and tool pipeline

**Goal:** close G2 honestly; add extension seams only if Q2 confirms a need.

**Items:**
1. ADR for the approval model (O2): vocabulary, defaults, fail-closed resolution, elevation journal.
2. Engine `approval_request` events surfaced to the operator (chat/TUI inbox + `pluton approvals`); decision recorded durably and applied; interim honesty fix: denials recorded into task result evidence so a no-op cannot pass as unqualified success.
3. Tool pipeline seams (pre/post-execute hooks, concurrency-safety metadata) — only if the composition decision (Q2) makes extension a goal; otherwise record as rejected.

**Acceptance tests:** operator approves a scripted engine request → engine proceeds, decision durable; deny → task result carries denial evidence; hook-order tests if seams land. **Rollback:** feature-flagged channel; ADR documents removal path.

## P4 — Machine interfaces (decision-gated: Q3)

**Goal:** expose Pluton programmatically without weakening the control-plane model.

**Sequence:** read-only SDK (status/task/graph/events JSON) → typed gateway/BFF if buy-in → web UI only if explicitly wanted. **Depends on:** P2 query API. **Rollback:** additive; SDK versioned independently.

## P5 — Composition kernel (decision-gated: Q2)

**Goal:** decide whether Pluton adopts a Cordis-style service kernel (parity §02–§06) or keeps static composition.

**Process:** write the ADR first (options: status quo / minimal service registry + lifecycle / full plugin composition). Implementation only after acceptance; minimal scope if chosen: typed service registry with lifecycle events and dependency-direction tests. Market/HMR/Electron/Python parity stay rejected unless re-scoped by the owner. **Rollback:** N/A when ADR-only; a future implementation would be staged behind the registry, not by rewriting modules.

## P6 — Quality gates and delivery (ongoing)

1. Capability conformance test (A7): adapters ↔ capability table drift fails CI.
2. State-coverage test (R3): every declared state is entered/left by a test or removed.
3. Doc-drift check (O5) and dependency-boundary test (R4).
4. Coverage threshold in CI; packaging and license decision (O8) before any distribution.
5. Sandbox: egress-filter enforcement for `network_policy: restricted` (documented today as not an egress filter).

---

## Dependency-ordered summary

```
P1 (PR-1 budgets/retries → PR-2 honest display → PR-3 transport retry)
  └─> P2 query/projection/replay (O1 ADR)
        └─> P3 approval channel (O2 ADR)            [interim honesty fix may run in parallel]
        └─> P4 SDK → gateway → web (Q3 decision)
  └─> P5 kernel decision (Q2)  [ADR only until decided]
  └─> P6 gates (independent, can start any time)
```

## Open decisions needed before P2–P6 can be scheduled

Q1 `REA.txt` location · Q2 kernel applicability · Q3 SDK/web scope · Q4 approval channel scope · Q5 replay protocol · Q6 budget semantics (PR-1 assumption stated above) · Q7 PTC/workflow need · Q8 delivery/license.
