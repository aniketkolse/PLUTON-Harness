# PLUTON 4.0 Test Suite Performance Baseline & Profiling

**Date:** 2026-11-01  
**Environment:** Node.js v24.20.0, Windows 11 Build 26300, 24 Logical Cores (Intel Core i7-14650HX), 16GB RAM, NTFS filesystem.  
**Test Runner:** Vitest v5.0.5  

---

## 1. Executive Summary

This audit profiles the execution time, resource consumption, and concurrency characteristics of Pluton's test suite (~1,240 tests across unit, integration, and domain layers).

Key findings:
1. **The Long Pole Suite:** `tests/integration/cli-integrate.test.ts` executes in ~247 seconds (over 4 minutes), accounting for more than 60% of total test runtime.
2. **Root Cause of CLI-Integrate Latency:** Each of the 29 tests initializes real Git repositories, commits files, clones worktrees, executes verification checks in isolated directories, and computes cryptographic worktree fingerprints.
3. **In-File Concurrency Hazard on Windows NTFS:** Attempting `describe.concurrent` within `cli-integrate.test.ts` spawns hundreds of concurrent `git` subprocesses, exhausting Windows process table slots and causing intermittent `spawn git ENOENT` and file locking errors. In-file execution within this suite must remain sequential.
4. **Fast Unit Tier:** Unit tests (`tests/unit/*.test.ts`) are highly efficient, completing 450+ tests in ~25-30 seconds total.
5. **Supervisor and Engine Layer:** `tests/integration/supervisor.test.ts` and `supervisor-ownership.test.ts` complete in ~31 seconds across 20+ tests involving multi-agent scheduling and simulated clock ticks.

---

## 2. Test Execution Profile Breakdown

| Test Domain / Suite | Test Count | Measured Duration | Primary Bottleneck |
| :--- | :--- | :--- | :--- |
| `tests/integration/cli-integrate.test.ts` | 29 | **~247 s** | Heavy disk I/O, `git init`/`clone`/`commit`, file hash verification |
| `tests/integration/supervisor*.test.ts` | 25 | **~31 s** | Complex multi-turn agent turns, mock session clock timeouts |
| `tests/unit/tool-*.test.ts` | 100 | **~15 s** | Tool bridge authorization, HTTP sockets, JSON-RPC parsing |
| `tests/integration/cli-*.test.ts` (excl. integrate) | 48 | **~22 s** | Subprocess CLI invocations and stdout parsing |
| `tests/integration/session-*.test.ts` | 24 | **~12 s** | SQLite inbox message routes and session event logging |
| `tests/integration/verify*.test.ts` | 11 | **~8 s** | Confinement checks, disposable snapshot creation |
| All remaining unit tests (`tests/unit/*`) | ~350 | **~15 s** | In-memory store operations, AST parsing, schema validations |

Total full suite run time: **~350–370 seconds** (~6 minutes).

---

## 3. Bottleneck Analysis & Structural Findings

### 3.1 `tests/integration/cli-integrate.test.ts`
- **What it does:** Tests the end-to-end `pluton integrate` pipeline: detects conflicting files, validates Git commit signatures and worktree fingerprints, enforces verification drift protections, runs post-merge checks, and commits clean results.
- **Why it takes ~247s:** 
  - Each test invokes `git` synchronously or asynchronously dozens of times (`git init`, `git add`, `git commit`, `git checkout`, `git rev-parse`, `git status`).
  - Disk operations on Windows NTFS have significantly higher syscall and file creation overhead compared to tmpfs on Linux.
- **Concurrency experiment results:**
  - When marked `describe.concurrent`, 29 tests attempted simultaneous `git clone` and worktree initialization.
  - Windows failed under the process burst with `WorkspaceError: could not read HEAD of fresh clone: spawn git ENOENT`.
  - **Verdict:** Must keep tests within `cli-integrate.test.ts` sequential, but file-level parallelism across different files remains safe.

### 3.2 OpenCode Background Model Discovery Process Storming
- **Identified Issue:** When `RunSupervisor` or `createProjectContext` initialized during integration runs without an explicit discovery mock, `ModelDiscoveryService` spawned `opencode models --standalone`. Under high test parallelism, dozens of OpenCode CLI processes were spawned, competing for port locks and memory.
- **Resolution:** Added an engine discovery bypass in `src/orchestrator/service.ts` when a custom `adapterFor` is supplied in test fixtures, eliminating background process storms.

---

## 4. Optimization Recommendations & Execution Strategy

1. **Targeted CI / Developer Workflows:**
   - Developers should run `npx vitest run tests/unit/` for fast feedback (< 25 seconds).
   - Fast integration suite can be run via: `npx vitest run tests/integration/ --exclude tests/integration/cli-integrate.test.ts` (~50 seconds).
   - Full integration gating (`npm test`) should include `cli-integrate.test.ts` but without forced in-file concurrency.
2. **Pool & Concurrency Configuration in `vitest.config.ts`:**
   - Keep `fileParallelism: true` (Vitest default) to run independent files in worker threads.
   - Maintain sequential in-file execution for Git-heavy integration suites to avoid Windows process spawn exhaustion.
3. **Artifact and Temp Directory Hygiene:**
   - Ensure all tests register cleanup in `afterEach` or `onTestFinished` to prevent SQLite WAL locks and abandoned temporary directories.
