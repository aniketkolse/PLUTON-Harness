# Multi-Agent Reliability and Verified Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Pluton-Harness with robust multi-agent coordination, file ownership lease tracking, independent verification (tamper detection, diff analysis, acceptance criteria audit), runtime resilience with circuit breakers and recovery, shared usage budget ledgers, and Orchestra inspector diagnostics.

**Architecture:** 
1. `FileLeaseManager` + migration 5 tracks explicit write scopes, queues/rejects overlapping edits, and prevents concurrent dependency/lockfile modifications.
2. `IndependentVerifier` audits Git diffs, detects test tampering/weakening, scans sensitive paths, validates acceptance criteria against test evidence, and enforces bounded repair cycles.
3. `CircuitBreaker` + retry policy stops unproductive loops upon repeated identical errors and handles interrupted run recovery.
4. `UsageLedger` aggregates token counts per Muse and run-wide with budget caps.
5. Orchestra inspector displays write scopes, conflicts, retry/circuit states, verification progress, and token metrics.

**Tech Stack:** TypeScript (ESM, strict), Node 24 SQLite (`node:sqlite`), Vitest, Pluton TUI theme primitives.

---

## Task 1: Baseline Architecture Audit & Plan Recording

**Files:**
- Create: `docs/superpowers/plans/2026-10-17-multi-agent-reliability.md`
- Test: `npm run check`

- [x] **Step 1: Verify current clean build and all 72 test suites pass**
- [x] **Step 2: Record baseline documentation**

---

## Task 2: Multi-Agent Conflict Prevention & File Ownership Leases

**Files:**
- Create: `src/orchestrator/lease-manager.ts`
- Modify: `src/store/migrations.ts` (Migration 5: file_leases)
- Modify: `src/store/store.ts`
- Modify: `src/tools/catalog.ts` (add `scope.declare` / `scope.release`)
- Modify: `src/tools/bridge.ts`
- Modify: `src/orchestrator/supervisor.ts`
- Test: `tests/unit/lease-manager.test.ts`
- Test: `tests/integration/multi-agent-conflict.test.ts`

- [ ] **Step 1: Write failing unit test for `FileLeaseManager`**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement Migration 5 and `FileLeaseManager` with lockfile protection and conflict detection**
- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Integrate write scope check into `supervisor.dispatchReadyTasks`**

---

## Task 3: Independent Verification & Test Integrity Audit

**Files:**
- Create: `src/verify/independent.ts`
- Modify: `src/verify/runner.ts`
- Test: `tests/unit/independent-verifier.test.ts`
- Test: `tests/integration/independent-verification-pipeline.test.ts`

- [ ] **Step 1: Write failing test for tamper detection (deleted/skipped tests) and sensitive file audit**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement `IndependentVerifier` with acceptance criteria grading and bounded repair cycles**
- [ ] **Step 4: Verify tests pass**

---

## Task 4: Runtime Resilience, Circuit Breakers & Interrupted-Run Recovery

**Files:**
- Create: `src/orchestrator/circuit-breaker.ts`
- Modify: `src/orchestrator/supervisor.ts`
- Modify: `src/store/store.ts`
- Test: `tests/unit/circuit-breaker.test.ts`
- Test: `tests/integration/run-recovery.test.ts`

- [ ] **Step 1: Write failing unit test for circuit breaker and retry limits**
- [ ] **Step 2: Implement failure fingerprinting, retry management, and interrupted run recovery**
- [ ] **Step 3: Verify tests pass**

---

## Task 5: Shared Usage Budget Ledger & Context Protection

**Files:**
- Create: `src/orchestrator/usage-ledger.ts`
- Modify: `src/store/migrations.ts` (Migration 5 or usage table)
- Modify: `src/store/store.ts`
- Modify: `src/orchestrator/supervisor.ts`
- Test: `tests/unit/usage-ledger.test.ts`

- [ ] **Step 1: Write failing test for run-wide usage aggregation and budget enforcement**
- [ ] **Step 2: Implement `UsageLedger` and event recording**
- [ ] **Step 3: Verify tests pass**

---

## Task 6: TUI Orchestra Inspector Enrichment

**Files:**
- Modify: `src/tui/orchestra.ts`
- Modify: `src/chat/session.ts`
- Test: `tests/unit/tui-orchestra-enrichment.test.ts`

- [ ] **Step 1: Write failing test for expanded inspector displaying write scopes, conflicts, and verification progress**
- [ ] **Step 2: Update `renderOrchestraInspector` to render lease scopes, blocked reasons, circuit state, and usage**
- [ ] **Step 3: Verify tests pass**

---

## Task 7: Full System Verification & Live Scratch Project Validation

**Files:**
- Test: `.pluton-tmp/smoke-docker/`
- Test: `tests/integration/smoke-docker-milestone3.test.ts`

- [ ] **Step 1: Execute full test suite (`npm run check`)**
- [ ] **Step 2: Run multi-agent conflict and verification live tests in `.pluton-tmp/smoke-docker`**
- [ ] **Step 3: Build distribution (`npm run build`) and verify CLI**
- [ ] **Step 4: Commit changes and prepare comprehensive milestone report**
