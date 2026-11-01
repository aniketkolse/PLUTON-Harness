# PLUTON 4.0 Feature Maturity Matrix

Audit Date: 2026-11-01  
Maturity Vocabulary:
- **Production Ready:** Fully implemented, verified against real dependencies and specifications, pass full automated test suites, robust error handling and fail-safe defaults.
- **Beta / Hardened:** Core flows complete and verified; bounded edge cases handled; ongoing optimization in progress.
- **Environment Restricted:** Implementation complete but restricted or unexercised due to host OS or physical environment constraints (e.g. Linux Landlock on Windows).
- **Deprecated / Retired:** Superceded architectures intentionally removed (e.g. Docker container worker model, Qwen Code adapter).

Status Vocabulary:
`VERIFIED`, `OPTIMIZED AND VERIFIED`, `PARTIALLY VERIFIED`, `BLOCKED BY ENVIRONMENT`, `NOT IMPLEMENTED`, `REQUIRES OWNER DECISION`.

---

## Feature Matrix

| Feature Area | Feature Item | Maturity Level | Status | Test & Verification Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Inference Engines** | OpenCode ACP Integration | Production Ready | **OPTIMIZED AND VERIFIED** | ACP framing, timeouts, cancel notification, stdio stream handling. Live ACP session & load tested with real OpenCode binary (`tests/live/opencode.live.test.ts`). |
| | OpenCode Explicit Model Switch | Production Ready | **OPTIMIZED AND VERIFIED** | Session `switchModel()` verifies `session/set_config_option` response; silent auto-switch eliminated (`tests/unit/opencode-model-fallback.test.ts`). |
| | Mock Engine Adapter | Development Only | **VERIFIED** | Pinned to `devOnly: true`; excluded from production selection (`tests/unit/engines.test.ts`). |
| | Qwen Code Engine | Retired | **NOT IMPLEMENTED** | Formally deprecated and excised in Phase 4 migration; no active code references. |
| **Model Selection & Intelligence** | Capability & Preference Ranking | Production Ready | **OPTIMIZED AND VERIFIED** | Ranks candidates based on role hints, latency, cost, and context constraints without faking unknown capabilities (`tests/unit/model-selection.test.ts`). |
| | Engine Boundary Isolation | Production Ready | **OPTIMIZED AND VERIFIED** | Strictly isolates model selection to matching engine kinds; dev-only mock models cannot be picked for real Ships (`tests/unit/supervisor-model-selection.test.ts`). |
| | Dynamic Model Discovery | Production Ready | **OPTIMIZED AND VERIFIED** | Periodic and on-demand discovery via `ModelDiscoveryService`; coalesces in-flight queries; unref timer (`tests/unit/model-discovery.test.ts`). |
| | Model Rediscovery Recovery | Production Ready | **OPTIMIZED AND VERIFIED** | Rediscovery clears unavailable state in `ModelHealthMonitor` when engine reports model as healthy (`tests/unit/model-discovery.test.ts`). |
| **Fault Tolerance & Fallbacks** | Error Classification | Production Ready | **VERIFIED** | Error patterns mapped to categories (`usage-limit`, `provider-unavailable`, `auth-failure`, etc.) with bounded cooldowns (`tests/unit/model-health.test.ts`). |
| | Replay Safety Verification | Production Ready | **OPTIMIZED AND VERIFIED** | `isSafeToReplay` analyzes `toolTrace`; prohibits retry if side-effects occurred (`src/engines/model-fallback.ts`). |
| | Structured Task Recovery Prompt | Production Ready | **OPTIMIZED AND VERIFIED** | `buildTaskRecoveryPrompt` creates snapshot of prior completed operations, failure reason, and workspace directory (`src/orchestrator/supervisor.ts`). |
| | Persistent Fallback Loop | Production Ready | **OPTIMIZED AND VERIFIED** | Supervisor manages fallback state across multiple attempts; bounded by `maxTotalFallbacks` (`tests/unit/acceptance-reliability.test.ts`). |
| **Orchestration & Scheduling** | DAG Task Scheduling | Production Ready | **VERIFIED** | Topological dependency admission, cycle detection, ready queue scheduling (`tests/unit/task-graph.test.ts`). |
| | Ship Keyed Mutex | Production Ready | **VERIFIED** | Guarantees single-task execution per Ship worker checkout (`tests/unit/mutex.test.ts`). |
| | Turn Interrupt & Grace Timing | Production Ready | **OPTIMIZED AND VERIFIED** | `session.interrupt()` cancels turns, triggers grace timer, prevents silent success on timeout or abort (`tests/unit/acp-session-turn.test.ts`). |
| | Usage Budgets & Ledgers | Production Ready | **VERIFIED** | Real-time tracking of token counts, chars, and costs with hard run limits (`tests/unit/usage-ledger.test.ts`). |
| **Security & Isolation** | Git Workspace Isolation | Production Ready | **VERIFIED** | Per-task clone isolation; checkout branch `pluton/<run>/<slug>`; main branch protected (`tests/unit/workspace.test.ts`). |
| | Tool Bridge Realpath Containment| Production Ready | **VERIFIED** | Blocks symlink traversal, directory traversal (`..`), UNC paths, and case-aliasing (`tests/unit/tool-bridge.test.ts`, `path-safety.test.ts`). |
| | Operator Approval Lifecycle | Production Ready | **VERIFIED** | Fail-closed approvals with timeout TTLs; clean abort on session termination (`tests/unit/engine-interactive-approval.test.ts`). |
| | Linux Landlock Confinement | Platform Gated | **BLOCKED BY ENVIRONMENT** | Linux Landlock ABI v1-v5 isolation; cannot run natively on Windows host (`native/confinement/`). |
| **Verification & Delivery** | Independent Verification | Production Ready | **VERIFIED** | Project checks run in task checkout before completion; task transitions to `verifying` then `completed` (`tests/unit/independent-verifier.test.ts`). |
| | Git Integration & Merge | Production Ready | **VERIFIED** | Merges verified task branches into `pluton/integration/<run>`; never merges directly to `main` without operator approval (`tests/unit/trusted-git.test.ts`). |
| **Storage & Presentation** | SQLite Persistence (WAL Mode) | Production Ready | **VERIFIED** | Synchronous WAL mode, atomic transitions, strict schema migrations via `node:sqlite` (`tests/unit/store.test.ts`). |
| | FTS5 Full-Text Search | Production Ready | **VERIFIED** | Full-text search across messages, tasks, and event logs (`tests/unit/fts-search.test.ts`). |
| | Local REST Server & SSE | Production Ready | **VERIFIED** | `/api/models`, run status, and event streaming routes with security headers (`tests/server/`). |
| | Terminal TUI & Web SPA | Production Ready | **VERIFIED** | Terminal dashboard, chat interface, and web UI renderer (`tests/ui/`, `tests/unit/tui-*.test.ts`). |

---

## Coverage and Risk Analysis

1. **Test Suite Coverage:**
   - Unit and integration tests cover all core components with 1,451 passing test cases.
   - Live tests verify real end-to-end ACP JSON-RPC communication against `opencode` v2.2.5.
2. **Environmental Limits:**
   - POSIX file mode checks and Linux Landlock security features are conditionally tested and report environment skips on Windows.
3. **Operational Hardening:**
   - Memory leak guards on client close (`cleanupChild`) prevent orphaned child process handles.
   - Supervisor model fallback state persistence ensures no infinite retry loops on exhausted providers.
