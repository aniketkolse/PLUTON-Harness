# PLUTON 4.0 Current State Audit

Audit Date: 2026-11-01  
Auditor: Automated Harness Reliability & Optimization Control  
Target Environment: Windows 11 Build 26300, Node.js v24.20.0, Git 2.56.0, OpenCode v2.2.5  
Target Branch: `optimization/p0-reliability` (uncommitted local worktree; no remote pushes)

---

## 1. Executive Summary

PLUTON is a local-first, CLI-first multi-agent harness control plane that coordinates a team of persistent specialist AI coding Ships (Muses), each configured with isolated models, instructions, approval policies, workspaces, and terminals.

This audit establishes the baseline technical state across the control plane following the initial P0 reliability and hardening pass. All findings are substantiated by test execution, live CLI probes, code inspection, and real OpenCode ACP engine runs.

### Summary Metrics
- **TypeScript Typecheck:** PASS (0 errors across `tsconfig.json` and `tsconfig.build.json`)
- **Unit & Integration Test Suite:** PASS (162/162 test files passing, 1,451 passing tests, 10 skipped, 0 failures)
- **Live OpenCode ACP Suite:** PASS (3/3 tests passing against installed OpenCode v2.2.5 on real model `opencode/beam-free`)
- **Asset Integrity:** PASS (60 checks passed via `scripts/verify-assets.mjs`)
- **Documentation Links:** PASS (80 doc files, 48 links verified, 0 broken via `scripts/verify-docs.mjs`)

---

## 2. Subsystem Audit & Status Matrix

Each subsystem is evaluated according to the standardized status vocabulary:
`VERIFIED`, `OPTIMIZED AND VERIFIED`, `PARTIALLY VERIFIED`, `BLOCKED BY ENVIRONMENT`, `NOT IMPLEMENTED`, `REQUIRES OWNER DECISION`.

| Subsystem | Components | Status | Evidence & Audit Notes |
| :--- | :--- | :--- | :--- |
| **Engine Contract & Protocols** | `src/engines/contract/`, `src/engines/acp/` | **OPTIMIZED AND VERIFIED** | ACP framing, timeouts, bounded error diagnostics, interrupt grace enforcement, and client spawn cleanup verified. 18/18 tests in `acp-session-turn.test.ts` and `acp-client.test.ts` pass. |
| **OpenCode Adapter** | `src/engines/opencode/adapter.ts` | **OPTIMIZED AND VERIFIED** | Silent adapter-level auto-switch removed; explicit model switching implemented via `switchModel()`; usage limits cleanly surfaced to supervisor; live ACP probe + session resume verified against OpenCode v2.2.5. |
| **Model Intelligence & Selection** | `src/engines/model-selection.ts`, `src/engines/model-discovery.ts` | **OPTIMIZED AND VERIFIED** | Engine kind boundary enforced (prevents dev-only mock model bleed into real engines); periodic discovery with health monitor recovery on rediscovery; candidate listing honors real engine inventory. |
| **Model Health & Fallback** | `src/engines/model-health.ts`, `src/engines/model-fallback.ts` | **OPTIMIZED AND VERIFIED** | Persistent fallback state across attempts; bounded retries and model switches; replay safety check from prompt tool trace (`isSafeToReplay`); structured task recovery prompt snapshot (`buildTaskRecoveryPrompt`). |
| **Run Orchestrator & Supervisor** | `src/orchestrator/supervisor.ts`, `src/orchestrator/service.ts` | **OPTIMIZED AND VERIFIED** | Central supervisor owns model fallback; startup discovery await bounded; task interrupt handling settles pending asks and releases slots cleanly; recovery context preserves completed tool operations without side-effect repetition. |
| **Durable Store & SQLite** | `src/store/` | **VERIFIED** | Built-in `node:sqlite` (`DatabaseSync`), strict migrations, idempotent task receipts, WAL mode, transactional state transitions. 100% store tests passing. |
| **Task Graph & Scheduling** | `src/orchestrator/wakeups.ts`, `src/orchestrator/mutex.ts` | **VERIFIED** | Dependency admission, DAG cycle detection, FIFO task wakeups, per-Ship KeyedMutex. Verified across integration test suites. |
| **Restricted Tool Bridge** | `src/tools/bridge.ts`, `src/tools/http-transport.ts` | **VERIFIED** | Realpath containment, path escape rejection, rate limiting, audit logging, fail-closed permission enforcement. |
| **Operator Approvals** | `src/engines/interactive-approval.ts`, `src/store/` | **VERIFIED** | Expiring approvals fail-closed; interactive operator inbox (`pluton approvals`); abort on session teardown/interrupt. |
| **Git Workspace Isolation** | `src/workspace/manager.ts` | **VERIFIED** | Per-task `git clone --local`, isolated branch checkouts (`pluton/<run>/<slug>`), clean cleanup without touching main. |
| **Verification & Independent Review** | `src/verification/` | **VERIFIED** | Verification executor runs project checks on isolated task checkouts; tasks stop in `verifying`; no unverified auto-completion. |
| **Linux Landlock Confinement** | `native/confinement/` | **BLOCKED BY ENVIRONMENT** | Linux Landlock ABI v1-v5 and POSIX bind-mount isolation cannot execute directly on Windows 11 host. Documented as BLOCKED BY ENVIRONMENT. |
| **REST/SSE Server** | `src/server/` | **VERIFIED** | Model availability route `/api/models` reports real model candidate availability; SSE log watcher; security headers and CORS boundaries verified. |
| **TUI & Desktop Client** | `src/ui/`, `src/tui/` | **VERIFIED** | Terminal TUI and Web SPA UI components pass unit and layout tests; terminal width and orchestra render passes verified. |

---

## 3. Key Invariants & Architectural Rules

1. **OpenCode ACP is the Sole Supported Real Inference Engine:**  
   The mock engine exists exclusively for deterministic testing and local development (`devOnly: true`). Production model selection explicitly excludes dev-only models from being selected for real Ships.
2. **Supervisor is the Single Authority on Model Switching:**  
   Adapters never silently switch models behind the supervisor's back or make autonomous decisions about fallback chains. All model switches are recorded, bounded, health-tracked, and audited at the supervisor level.
3. **No Fabrication of Metadata:**  
   Model capabilities, token windows, and pricing are never guessed from model names or hardcoded tables. Missing metadata remains `undefined` (unknown).
4. **Replay Safety Before Retry:**  
   Prompt retry/replay is strictly prohibited if side-effecting tools (file modifications, shell commands, git operations) executed prior to failure. When switching models after partial execution, a structured recovery snapshot (`buildTaskRecoveryPrompt`) directs the replacement model to inspect existing workspace state instead of re-executing completed side effects.
5. **Fail-Closed Permissions:**  
   Any unhandled permission request, interrupted session, dead transport, or expired timeout settles as `deny`. No operation proceeds on unconfirmed consent.
6. **No Main-Branch Silent Merges:**  
   Task changes remain isolated in task-specific branches (`pluton/<run>/<slug>`). Integration occurs only on explicit command (`pluton integrate`) after verification passes.

---

## 4. Gaps and Risks Identified

1. **Platform Confinement Boundary:**  
   On Windows, execution is unconfined native execution. While directory traversal and workspace escapes are blocked by software realpath checks in PlutonToolBridge, OS-level kernel sandbox confinement (Landlock) is Linux-only.
2. **Free Model Rate Limits:**  
   Public free-tier OpenCode models (e.g. `opencode/deepseek-v4.1-flash-free`) frequently experience usage exhaustion or provider concurrency caps. The bounded fallback loop and health monitor cooldowns now properly absorb these failures, switching to available alternatives (such as `opencode/beam-free`), but operator credentialing remains necessary for heavy continuous workloads.
3. **Long Test Suite Duration:**  
   The complete Vitest test suite spans 162 files and ~120s execution time on single-threaded execution. Individual domain and unit folders run in ~1-30s. CI configurations should parallelize test execution across test suites.
