# PLUTON 4.0 Baseline Test & Verification Report

Report Date: 2026-11-01  
Environment: Windows 11 Build 26300, Node.js v24.20.0, npm 10.9.9, OpenCode v2.2.5  
Execution Branch: `optimization/p0-reliability`  
Auditor: Automated Harness Reliability & Optimization Control

---

## 1. Executive Summary

| Verification Target | Command | Result | Pass Rate | Duration | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Typecheck** | `npm run typecheck` | **PASS** | 100% (0 errors) | 3.5s | Strict TypeScript `tsconfig.json` check passed. |
| **Production Build** | `npm run build` | **PASS** | 100% (0 errors) | 3.2s | Builds cleanly into `dist/` via `tsconfig.build.json`. |
| **Unit & Integration Suite** | `npx vitest run tests/unit tests/engines tests/config tests/integration tests/orchestrator tests/server tests/ui` | **PASS** | 162/162 files, 1,451/1,461 tests (10 skipped) | 138.48s | 0 failures across all 162 test suites. |
| **Live OpenCode ACP Tests** | `npm run test:live` | **PASS** | 3/3 tests passed | 9.06s | Real subprocess ACP communication, live inference, and session resume (`opencode/beam-free`). |
| **Asset Integrity** | `npm run verify:assets` | **PASS** | 60/60 checks passed | 0.8s | Package manifests, licenses, and file existence verified. |
| **Documentation Link Gate** | `npm run verify:docs` | **PASS** | 80 files, 48 links | 0.6s | Zero broken cross-references or doc links. |

---

## 2. Test Suite Breakdown

### 2.1 Core Subsystems Breakdown

| Test Directory | Files | Tests Passed | Tests Skipped | Failures | Focus Areas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `tests/unit/` | 109 | 1,063 | 8 | 0 | Store, domain, supervisor, model intelligence, MCP tools, ACP transport, security, TUI. |
| `tests/engines/` | 8 | 44 | 0 | 0 | OpenCode model validation, catalog mapping, ACP options, conformance. |
| `tests/config/` | 1 | 14 | 0 | 0 | Zod schema validation, pluton.yaml parsing, team config boundaries. |
| `tests/integration/`| 17 | 158 | 2 | 0 | Supervisor orchestration, CLI commands, approval flows, git integration. |
| `tests/orchestrator/`| 5 | 42 | 0 | 0 | Wakeup channels, lease manager, circuit breaker, usage ledger. |
| `tests/server/` | 6 | 48 | 0 | 0 | REST endpoints, `/api/models`, SSE log watcher, security headers. |
| `tests/ui/` | 15 | 82 | 0 | 0 | SPA components, activity timeline, cards, input status. |
| **Total Automated** | **162** | **1,451** | **10** | **0** | **Complete Green Suite** |

*Note: The 10 skipped tests are platform-gated checks (POSIX file modes, Unix socket semantics, Linux Landlock confinement) that correctly skip when executed on Windows.*

---

## 3. Real Engine Live Validation Evidence

Live validation executed using real OpenCode v2.2.5 on Windows 11 against the installed binary (`C:\Users\Asus\AppData\Roaming\npm\opencode.cmd`).

### Execution Details:
```bash
$env:PLUTON_LIVE_OPENCODE="1"
$env:PLUTON_LIVE_OPENCODE_MODEL="opencode/beam-free"
$env:PLUTON_LIVE_OPENCODE_RESUME="1"
npm run test:live
```

### Result:
```text
> pluton-harness@0.1.0 test:live
> vitest run --config vitest.live.config.ts

 RUN  v5.0.5 Y:/Pluton

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  02:59:15
   Duration  9.06s (tests 99%)
```

### Verified Behaviors:
1. **Engine Discovery (`adapter.discover()`):**
   - Correctly locates `opencode` binary and identifies version string (`opencode/2.2.5`).
   - Retrieves full model inventory (36 candidate models).
2. **ACP Session & Prompt Streaming (`adapter.startSession()` & `sendPrompt()`):**
   - Spawns real `opencode acp` child process over stdio JSON-RPC.
   - Pinned model configured via `session/set_config_option`.
   - Streaming text updates received; verified prompt marker `PLUTON_LIVE_OK`.
   - Outcome resolved as `success`.
3. **Session Resumption (`session/load`):**
   - Verified that prior session state and memory (`codeword BANANA`) persisted across session termination and resumed cleanly using `info.resumeToken`.

---

## 4. P0 Reliability Fixes Verified

1. **Elimination of Competing Fallback Authorities:**
   - Adapter-level silent auto-switching removed from `src/engines/opencode/adapter.ts`.
   - Hardcoded fallback preferences removed; supervisor confirmed as single fallback decision authority.
   - Explicit session model switching verified via `tests/unit/opencode-model-fallback.test.ts`.
2. **Persistent Supervisor Fallback Loop:**
   - Multi-attempt state preserved in `ModelFallbackState` (exhausted models, switch count, retry count).
   - Replay safety verified via tool traces: side-effecting operations block unsafe re-execution.
   - Structured `buildTaskRecoveryPrompt` informs replacement model of completed steps.
   - Full recovery cycle verified in `tests/unit/acceptance-reliability.test.ts`.
3. **Engine-Kind Boundary Protection:**
   - Production discovery excludes `devOnly` mock adapters.
   - Model selection filters candidates strictly to the target Ship's engine kind.
   - Verified in `tests/unit/supervisor-model-selection.test.ts` and `model-discovery.test.ts`.
4. **ACP Session Turn & Process Hygiene:**
   - Unacknowledged cancel interrupts trigger grace timeout and guarantee outcomes `cancelled` / `unknown`.
   - Consumer early termination poisons sessions to prevent turn interleaving.
   - Client close guards prevent killing already-exited processes while guaranteeing no orphan processes remain.
   - Verified in `tests/unit/acp-session-turn.test.ts` and `acp-client.test.ts`.
5. **Model Rediscovery Health Recovery:**
   - Periodic or on-demand discovery clears unavailable status for rediscovered models.
   - Verified in `tests/unit/model-discovery.test.ts`.
