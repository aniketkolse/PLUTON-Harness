# PLUTON 4.0 Phase 4 — Batch 6: MCP Ecosystem Audit

**Date:** 2026-11-02  
**Milestone:** Phase 4, Batch 6 — MCP Ecosystem Maturity  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (audit only; implementation pending)

---

## 1. Executive Summary

Batch 6 audits PLUTON's MCP (Model Context Protocol) ecosystem: the stdio and HTTP transports, the tool bridge authorization boundary, the Pluton tool catalog, the operator tool catalog, and the tool handlers. The architecture is cleanly layered: transport → auth boundary → tool catalog → handlers. Every call is validated server-side against the caller's Ship identity, permissions, run budget, and live graph state.

Key finding: MCP exposure is deliberately **restricted** — Pluton exposes only its own restricted tool surface, not arbitrary engine capabilities. Tool catalog entries are static (Zod schemas + handler definitions), there is no capability registry beyond static definitions, no per-task tool selection beyond permission checks, no usage observability beyond the `tool.call` audit event, and no health/liveness reporting for MCP servers beyond the store-level session state.

---

## 2. Existing MCP Architecture (Verified)

### 2.1 Components

| Component | Location | Role |
| :--- | :--- | :--- |
| `McpStdioServer` | `src/tools/mcp-server.ts` | Loopback-only stdio JSON-RPC 2.0 server. Implements `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. One JSON object per line, no Content-Length framing. |
| `ToolHttpServer` | `src/tools/http-transport.ts` | HTTP/JSON-RPC bridge for remote (restricted native) sessions. Per-session bearer token auth, loopback-only TCP, optional AF_UNIX socket (Linux only). Bounded concurrency (64 global, 8 per session), FIFO queue (depth 16), HTTP 429 capacity exhaustion, stream overflow protection (HTTP 413), session lifecycle teardown. |
| `PlutonToolBridge` | `src/tools/bridge.ts` | Authorization boundary. One bridge per engine session. Caller identity (Ship) and permissions bound at construction. Every call validated against permissions, run budget, and graph state. Every call audited as a durable event. |
| `TOOL_SCHEMAS` / `TOOL_DEFS` | `src/tools/catalog.ts` | Zod schemas + descriptions for Pluton tools (task.create, task.delegate, task.inspect, task.wait, task.get_result, task.cancel, task.request_revision, review.report, ship.propose_create, muse.propose_create, approval.request, diff.inspect, project.read, run.stop, scope.declare, scope.release, ship.message, ship.inbox). |
| `OPERATOR_TOOL_SCHEMAS` / `OPERATOR_TOOL_DEFS` | `src/tools/operator-catalog.ts` | Operator-scoped tools (project.status, run.list, run.get, run.start, approvals.list). Used by `pluton chat` operator surface. |
| `PlutonToolBridge.listTools()` | `src/tools/bridge.ts:234` | Filters `TOOL_SCHEMAS` / `OPERATOR_TOOL_SCHEMAS` by caller permissions. Returns only tools the caller is authorized to call. |

### 2.2 Guarantees Preserved

- Loopback-only TCP (`127.0.0.1`); optional AF_UNIX socket on Linux only.
- Bearer token auth per session; token never logged.
- Per-session concurrency limits (64 global, 8 per session), FIFO queue depth 16, HTTP 429 when queue saturated.
- Stream overflow protection: bodies > `maxRequestBytes * 2` drained and answered with HTTP 413.
- Every call permission-checked against caller's Ship permissions at call time.
- Every call audited as a durable `tool.call` event (outcome, tool name, duration).
- Model prose never authoritative; only handler-accepted calls recorded.

---

## 3. Audit Findings & Architectural Gaps

### Gap 1 — No MCP capability registry (MEDIUM impact)

`McpToolInfo` carries only `name`, `description`, `inputSchema`. There is **no** representation of:

- Server identity/version (only set at construction, not queryable)
- Tool availability / health status
- Permission requirements per tool (implicit in `PlutonToolBridge` but not queryable)
- Execution constraints (timeouts, max retries)
- Deprecation status

Operators and managers cannot query "what tools are available and healthy" beyond the static schema list.

### Gap 2 — No tool invocation observability beyond audit events (MEDIUM impact)

`PlutonToolBridge.audit()` records `tool.call` events with `ok`, `mutating`, `durationMs`, and optional `errorCode`. However:

- No per-tool invocation latency histogram
- No success/failure rates per tool
- No timeout rates
- No tool usage per agent/ship or per task aggregation (derivable from events but not aggregated)
- No tool execution lifecycle events (discovery, selection, invocation start/completion, cancellation)

### Gap 3 — No task-aware tool selection (LOW impact)

Tool selection is purely permission-based: `this.permissions.includes(def.permission)`. There is **no** task-aware filtering (e.g., "this task only needs `diff.inspect` and `task.inspect`"). Workers see all tools they have permission for, even if unrelated to their task. This is acceptable under Pluton's least-privilege-by-permission model, but it means a coder with `task.create` could theoretically create tasks outside their intended scope if the manager prompt is weak.

### Gap 4 — No duplicate tool invocation detection (LOW impact)

Unlike task-level duplicate detection (Batch 3), there is **no** duplicate tool invocation detection at the MCP layer. A model could call the same tool repeatedly (e.g., `task.create` in a loop) subject only to `maxConcurrentRequests` and run budget limits.

### Gap 5 — HTTP transport UNIX socket is Linux-only (LOW impact, documented)

`ToolHttpServer` supports AF_UNIX sockets on Linux only. Windows/macOS fall back to loopback TCP. This is already documented in the code and ADR-0010 context.

---

## 6. Isolation Strategy Comparison

| Strategy | Verdict | Rationale |
| :--- | :--- | :--- |
| Keep per-session MCP over stdio + HTTP | **Retain** | Clean separation, token-based auth, loopback/AF_UNIX confinement, proven in production |
| Add MCP capability discovery endpoint | Deferred | Would require extending `McpStdioServer`/`ToolHttpServer` with a capabilities endpoint; not in scope for this batch |
| Per-task MCP server instances | Rejected | Over-engineering; per-session bridges already isolate tool access by caller identity |
| Global tool allowlist per task | Deferred | Could narrow tool surface per task, but adds complexity; current per-Ship permission model is sufficient |

---

## 7. Proposed Improvements (Batch 6 Scope)

All improvements are **additive**; none replace `McpStdioServer`, `ToolHttpServer`, `PlutonToolBridge`, or `TOOL_SCHEMAS`.

### 7.1 MCP Capability Registry

**New file:** `src/tools/mcp-catalog.ts`

- `McpToolCapability` — name, description, inputSchema, permission, mutating, available (boolean), health status, execution constraints (timeout, max retries)
- `McpCapabilityRegistry` — register/discover tools, query by capability, health tracking
- `buildCapabilityRegistry()` — builds from `TOOL_SCHEMAS` catalog (one entry per Pluton tool)
- `capabilityEntryToMcpToolInfo()` / `capabilityEntriesToMcpToolInfos()` — adapts to MCP `McpToolInfo` format
- `defaultCapabilityRegistry` — exported default built from Pluton tool catalog

### 5.2 Least-Privilege Tool Selection

Add task-aware tool filtering in `PlutonToolBridge`:

- `selectToolsForTask(taskId, availableTools)` — filters tools based on task writeScope
- Never silently expands permissions; only narrows
- Decisions explainable: record `task.tool_selection` event with selected tools and reasons

### 5.3 Tool Invocation Observability

Extend `PlutonToolBridge.call()` to emit structured events:

- `tool.invoked`: tool name, caller, task, startedAt
- `tool.completed`: tool, taskId, shipId, durationMs
- `tool.failed`: tool, taskId, shipId, durationMs, errorCode, errorMessage
- `tool.timed_out`: tool, taskId, shipId, durationMs, timeout value
- `tool.cancelled`: tool, taskId, shipId, reason
- All events bounded, redacted, never log complete tool outputs unnecessarily

### 5.4 Integration Reliability (Documented, No Code Change Unless Needed)

- Connection lifecycle: already handled by `AbortSignal` per request, `shutdown` controller, drain queue bounded by `DRAIN_GRACE_MS`
- Timeout behavior: per-request `AbortSignal`; engine sessions interrupt on timeout
- Error classification: `tool.call` events record `errorCode` (ZodError → `invalid_arguments`, PlutonError → code, else `internal_error`)
- Request cancellation: `AbortSignal` per request; `session.interrupt()` on engine timeout
- Resource cleanup: `inFlight` set drained on `stop()` with `DRAIN_GRACE_MS` bound
- Safe retry: **no automatic retry**. Non-idempotent operations are never auto-retried. Callers decide.

---

## 6. What Is NOT in Scope

- New MCP transport (SSE, Streamable HTTP): stdio + HTTP are sufficient
- MCP resource listing (`resources/list`, `resources/read`): not in Pluton's scope
- MCP sampling/roots: not needed for Pluton's tool model
- Auto-retry of non-idempotent operations: explicitly forbidden
- New database table for capabilities: reuse event log + in-memory registry (consistent with Ruling 5)

---

## 7. Acceptance Criteria (Measurable)

| # | Criterion | How Measured |
| :--- | :--- | :--- |
| 1 | Tool capability registry exposes name, description, inputSchema, permission, availability | Unit tests on `McpToolCapability` / registry |
| 2 | Least-privilege tool selection narrows tools by task | Unit tests: task-scoped session sees fewer tools than operator session |
| 3 | No silent permission expansion | Unit tests: worker cannot call tools outside its permissions |
| 4 | Tool invocation events are durable | Integration test: `tool.invoked`/`tool.completed`/`tool.failed` events in store |
| 5 | Concurrency limits preserved (64 global, 8 per session) | Existing `tests/unit/tool-http.test.ts` still passes |
| 6 | No new dependencies; typecheck + build + tests pass | `npm run typecheck`, `npm run build`, `npm test` |

---

## 8. Residual Risks & Limitations

1. Tool capability registry is in-memory only (consistent with Ruling 13: observed performance is cross-tick but in-process only)
2. Least-privilege selection is heuristic (writeScope/acceptance criteria based), not semantic
3. No automatic retry: operators must handle failed tool calls manually (by design)
4. Windows does not support AF_UNIX; loopback TCP is used instead (documented)

---

## 9. Files To Be Changed (Planned)

| File | Change |
| :--- | :--- |
| `docs/optimization/18-MCP-ECOSYSTEM-AUDIT.md` | This audit |
| `src/tools/mcp-catalog.ts` | **New.** Capability registry: `McpToolCapability`, `McpCapabilityRegistry` |
| `src/tools/catalog.ts` | Extend `TOOL_SCHEMAS` entries with capability metadata (optional, backward compatible) |
| `src/tools/bridge.ts` | Add `selectToolsForTask`, tool invocation observability events |
| `src/tools/mcp-server.ts` | No changes (transport layer sufficient) |
| `src/tools/http-transport.ts` | No changes (transport limits already verified) |
| `tests/unit/mcp-catalog.test.ts` | **New.** Capability registry, duplicate registration, schema validation |
| `tests/unit/tool-bridge.test.ts` | Extend: least-privilege tool selection, permission enforcement |
| `tests/integration/mcp.test.ts` | **New.** Connection failures, timeout behavior, queue saturation, concurrency limits, safe retry |
| `docs/optimization/PROGRESS.md` | Batch 6 status + rulings |

---

## 10. Sign-off

Audit complete. No implementation files modified yet. The MCP ecosystem is sound (stdio + HTTP transport, token-based auth, bounded concurrency, permission-checked tool bridge). Batch 6 will harden the capability registry, add least-privilege tool selection, and add tool invocation observability without changing the transport or security boundaries.

**Next:** Step 2 — implement `src/tools/mcp-catalog.ts` capability registry.
