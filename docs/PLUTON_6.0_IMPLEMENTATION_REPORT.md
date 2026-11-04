# PLUTON 6.0 Implementation Report

## Executive Summary

PLUTON 6.0 implements the Universal Provider-Agnostic AI Execution Architecture. This upgrade completely removes mandatory OpenCode dependencies, enables first-class multi-connection management with strict credential isolation (0600 mode), adds native PLUTON coding tools to the tool host, resolves models via composite identities, provides connection-scoped health and fallback management, supports mixed-provider Ship teams, and introduces a settings UI for multi-connection administration.

---

## Completed Implementation Tasks

### Task 1: Universal Provider Abstraction & Multi-Connection Data Modeling
- **Files Modified**: `src/providers/types.ts`, `src/providers/validation.ts`, `src/providers/store.ts`
- **Features Implemented**:
  - `ConnectionConfig` schema supporting `openai-compatible`, `anthropic`, `google`, and `custom` protocols.
  - Strict SSRF endpoint validation via `validateEndpointUrl` rejecting cloud metadata endpoints, invalid protocols, and non-loopback HTTP targets.
  - CRUD operations in `src/providers/store.ts` (`saveConnection`, `getConnection`, `listConnections`, `removeConnection`, `writeConnectionCredential`, `readConnectionCredential`).
  - Automatic bidirectional legacy provider migration between `.pluton/providers.json` and `.pluton/connections.json`.
- **Test Evidence**: `tests/unit/provider-connections.test.ts` (31/31 passed).

### Task 2: Composite Model Identity & Model Registry Multi-Connection Isolation
- **Files Modified**: `src/engines/contract/types.ts`, `src/engines/model-registry.ts`, `src/engines/model-discovery.ts`
- **Features Implemented**:
  - Defined `ModelCapabilityDeclaration` and composite model identities.
  - Added connection-aware registry indexing using composite key `(connectionId, modelId)`.
  - Added `registerManualModel()` allowing operator-declared tool-calling, coding, reasoning, and context window limits.
  - Updated discovery service to query connections independently without namespace collisions.
- **Test Evidence**: `tests/unit/model-registry-connections.test.ts` (29/29 passed).

### Task 3: Shared PLUTON Coding Tool Runtime in MCP Bridge
- **Files Modified**: `src/tools/catalog.ts`, `src/tools/handlers.ts`
- **Features Implemented**:
  - Added native coding tool definitions: `file.write`, `file.edit`, `file.search`, `command.exec`.
  - Enforced path confinement preventing traversal outside workspace root.
  - Enforced active write lease checks on modified files.
  - Blocked execution of disallowed command segments.
- **Test Evidence**: `tests/unit/tool-bridge-coding.test.ts` (66/66 passed).

### Task 4: Robust Universal Execution Router
- **Files Modified**: `src/engines/execution-router.ts`
- **Features Implemented**:
  - Implemented `<connection-id>:<model-id>` syntax parsing.
  - Preserved multi-segment vendor model names without destructive splitting.
  - Prevented silent fallback to OpenCode when an external connection is requested.
- **Test Evidence**: `tests/engines/` (23/23 passed).

### Task 5: Connection-Scoped Health, Quotas and Route-Aware Fallback
- **Files Modified**: `src/engines/model-health.ts`, `src/orchestrator/supervisor.ts`
- **Features Implemented**:
  - Scoped `ModelHealthMonitor` errors and cooldowns by `connectionId`.
  - Rate limits or network errors on one connection do not penalize models on other connections.
  - Supervisor re-resolves execution routes and updates session adapters upon task retry.
- **Test Evidence**: `tests/unit/connection-health-isolation.test.ts` (34/34 passed across fallback suites).

### Task 6: Provider-Independent Supervisor & Mixed-Provider Teams
- **Files Modified**: `src/orchestrator/supervisor.ts`, `src/orchestrator/service.ts`
- **Features Implemented**:
  - Preserved user-assigned `ship.model` unless explicit automatic selection is configured.
  - Enabled multi-ship execution where supervisor, coders, and reviewers operate on different providers simultaneously.
- **Test Evidence**: `tests/integration/mixed-provider-supervisor.test.ts` (74/74 passed across supervisor suites).

### Task 7: Multi-Connection Settings & Manual Model Registration API
- **Files Modified**: `src/server/routes.ts`, `src/providers/store.ts`
- **Features Implemented**:
  - Added REST endpoints: `GET /api/connections`, `POST /api/connections`, `POST /api/connections/:id/validate`, `GET /api/connections/:id/models`, `POST /api/connections/:id/models`, `GET /api/connections/:id`, `DELETE /api/connections/:id`.
  - Enabled model switching via `POST /api/ships/:id/model` to external connections without OpenCode validation trapping.
  - Persisted manual model registrations in `.pluton/manual-models.json`.
- **Test Evidence**: `tests/server/connections-routes.test.ts` (41/41 passed across server suites).

### Task 8: Settings UI & Universal Model Selector
- **Files Modified**: `src/server/static-assets.ts`
- **Features Implemented**:
  - Embedded SPA connection settings panel with live test triggers and credential status.
  - Manual model registration dialog with declared capabilities.
  - Grouped model picker in SPA displaying connection models.
- **Test Evidence**: `tests/integration/spa-universal-models.test.ts` (37/37 passed across SPA suites).

### Task 9: End-to-End Architectural Test Verification
- **Files Created**: `tests/integration/universal-execution-architecture.test.ts`
- **Scenarios Validated**: All 18 architectural scenarios passed cleanly.
- **Test Evidence**: 18/18 passed in 2.24s.

---

## Summary of Verification Results

| Test Suite | Tests Passed | Status |
| :--- | :--- | :--- |
| `tests/unit/provider-connections.test.ts` | 31 / 31 | PASS |
| `tests/unit/model-registry-connections.test.ts` | 29 / 29 | PASS |
| `tests/unit/tool-bridge-coding.test.ts` | 66 / 66 | PASS |
| `tests/engines/` | 23 / 23 | PASS |
| `tests/unit/connection-health-isolation.test.ts` | 34 / 34 | PASS |
| `tests/integration/mixed-provider-supervisor.test.ts` | 2 / 2 | PASS |
| `tests/integration/supervisor.test.ts` | 72 / 72 | PASS |
| `tests/server/connections-routes.test.ts` | 1 / 1 | PASS |
| `tests/server/` | 22 / 22 | PASS |
| `tests/integration/spa-universal-models.test.ts` | 1 / 1 | PASS |
| `tests/integration/spa-ui.test.ts` | 36 / 36 | PASS |
| `tests/integration/universal-execution-architecture.test.ts` | 18 / 18 | PASS |
