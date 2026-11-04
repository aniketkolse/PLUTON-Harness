# PLUTON 6.0 Acceptance Report

## Final Acceptance Verdict: APPROVED

All architectural requirements, quality gates, security invariants, and test specifications for PLUTON 6.0 have been verified and passed.

---

## Acceptance Criteria Verification Matrix

| Criterion | Requirement | Verification Method | Result |
| :--- | :--- | :--- | :--- |
| **AC-1** | OpenCode is strictly optional; zero mandatory runtime dependency | `universal-execution-architecture.test.ts` (Scenario 2, 7) | **PASS** |
| **AC-2** | Multi-connection isolation to same provider without state collision | `universal-execution-architecture.test.ts` (Scenario 6) | **PASS** |
| **AC-3** | Secure credential isolation in `.pluton/provider-homes/` (mode 0600) | `provider-connections.test.ts` & `universal-execution-architecture.test.ts` (Scenario 17) | **PASS** |
| **AC-4** | Composite model identity `(connectionId, modelId)` preserved | `model-registry-connections.test.ts` & `universal-execution-architecture.test.ts` (Scenario 4, 5) | **PASS** |
| **AC-5** | Native PLUTON coding tools (`file.write`, `file.edit`, `file.search`, `command.exec`) | `tool-bridge-coding.test.ts` & `universal-execution-architecture.test.ts` (Scenario 11) | **PASS** |
| **AC-6** | Workspace boundary & path traversal protection | `tool-bridge-coding.test.ts` & `universal-execution-architecture.test.ts` (Scenario 18) | **PASS** |
| **AC-7** | Mixed-provider Ship teams operate concurrently | `mixed-provider-supervisor.test.ts` & `universal-execution-architecture.test.ts` (Scenario 12) | **PASS** |
| **AC-8** | Connection-scoped health, quotas and fallback | `connection-health-isolation.test.ts` & `universal-execution-architecture.test.ts` (Scenario 8, 9) | **PASS** |
| **AC-9** | Multi-connection management REST API | `connections-routes.test.ts` | **PASS** |
| **AC-10**| SPA settings UI for connections and manual model registration | `spa-universal-models.test.ts` & `spa-ui.test.ts` | **PASS** |

---

## 18 Architectural Scenarios Matrix

| Scenario | Description | Verdict |
| :--- | :--- | :--- |
| **1** | OpenCode model executes through OpenCode engine route | **PASS** |
| **2** | External model executes through its own HTTP adapter route | **PASS** |
| **3** | Custom compatible API endpoint can be saved and loaded with headers | **PASS** |
| **4** | Manually registered model resolves with user-declared capabilities | **PASS** |
| **5** | Multiple providers work simultaneously in registry without collisions | **PASS** |
| **6** | Multiple connections to same provider remain strictly isolated | **PASS** |
| **7** | External models resolve without OpenCode validation dependency | **PASS** |
| **8** | OpenCode quota exhaustion does not affect external connection health | **PASS** |
| **9** | Failures on Connection A do not impact Connection B | **PASS** |
| **10** | Unsupported capabilities are evaluated accurately in model selector | **PASS** |
| **11** | Tool calls `file.write` and `command.exec` execute safely within workspace | **PASS** |
| **12** | Supervisor orchestrates multiple Ships on different providers simultaneously | **PASS** |
| **13** | Assigned model identity survives server restart in SQLite store | **PASS** |
| **14** | Task assignment record preserves provider and model identity on admission | **PASS** |
| **15** | Cancellation stops running tasks cleanly | **PASS** |
| **16** | SSRF and invalid credentials reject connection activation | **PASS** |
| **17** | Private credentials never leak in `listConnections` or REST responses | **PASS** |
| **18** | Workspace policy and path security checks prevent directory traversal | **PASS** |

---

## Security & Confinement Audit Sign-Off

1. **SSRF Guard**: Confirmed through `validateEndpointUrl` rejecting cloud metadata addresses (`169.254.169.254`), non-HTTP/HTTPS protocols, non-loopback HTTP endpoints, and URL-embedded credentials.
2. **Credential Storage**: Confirmed through mode 0600 file creation on disk, zero persistence into `pluton.yaml`, zero transmission over public API lists.
3. **Path Traversal Guard**: Confirmed through `safeResolvePath` and `PlutonToolBridge` preventing directory traversal outside the active workspace or project checkout.
4. **Lease Locking**: Confirmed write leases must be acquired before `file.write` or `file.edit` modifies files.

---

## Non-Regression & Backward Compatibility Sign-Off

1. **Legacy Provider Store**: Existing `.pluton/providers.json` configurations are transparently migrated into `.pluton/connections.json` while maintaining full backward-compatible access.
2. **Pluton Configuration Preservation**: `pluton.yaml` has remained untouched and uncommitted throughout execution.
3. **Full Vitest Suite Status**: All existing unit, engine, store, supervisor, server, and SPA tests pass cleanly without regressions.
