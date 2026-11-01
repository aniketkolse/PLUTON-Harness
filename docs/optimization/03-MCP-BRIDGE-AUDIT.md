# PLUTON 4.0 MCP Tool Bridge Audit

Audit Date: 2026-11-01  
Subsystem: MCP Tool Bridge (`src/tools/`)  
Auditor: Automated Harness Reliability & Optimization Control  
Branch: `optimization/p0-reliability`

---

## 1. Executive Summary

The Pluton MCP Tool Bridge provides the restricted tool execution environment used by AI agent engine sessions (specifically OpenCode over ACP) to interact with the Pluton control plane. It enforces server-side identity, role-based permission validation, path containment, and audit logging.

This audit maps the complete execution path, analyzes buffer management, concurrency limits, backpressure, cancellation semantics, and resource lifecycles across stdio and HTTP transports.

### Key Audit Findings
1. **Unbounded Concurrency in HTTP Transport:** `ToolHttpServer` currently spawns an unconstrained asynchronous handler for every incoming HTTP POST without global or per-session concurrency limits.
2. **Session Lifecycle Memory Leak:** Sessions registered via `ToolHttpServer.register()` accumulate in `this.sessions` over the lifetime of a run. While `unregister()` exists, the orchestrator supervisor never calls it when tasks complete.
3. **Stdio Transport Head-of-Line Blocking:** `McpStdioServer.serve()` executes requests sequentially (`await this.handleLine`), causing long-running tools like `task.wait` to block all subsequent frames (including `ping` or read queries) on that stdio stream.
4. **Duplicate Interface Declaration:** `ToolBridgeLimits` is declared twice in `src/tools/bridge.ts` (lines 32–53 and lines 82–97).
5. **Slow/Infinite Stream Drain Risk:** `readBody()` in `ToolHttpServer` drains payloads exceeding `maxRequestBytes` without a timeout or socket termination, risking prolonged resource consumption by misbehaving clients.

---

## 2. Architecture & Execution Trace

### 2.1 Architecture Diagram

```
+--------------------------------------------------------------------------+
|                       OpenCode Agent Engine Session                      |
+--------------------------------------------------------------------------+
                                     |
                [HTTP POST / JSON-RPC 2.0 (Bearer Token)]
                                     v
+--------------------------------------------------------------------------+
| ToolHttpServer (src/tools/http-transport.ts)                             |
|  - Validates Bearer Token via timingSafeEqual()                          |
|  - Enforces maxRequestBytes (1 MB cap)                                   |
|  - Tracks in-flight requests in Set<Promise<void>>                      |
|  - Creates AbortSignal via requestSignal() (client disconnect / stop)    |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| McpStdioServer (src/tools/mcp-server.ts)                                 |
|  - Protocol framing (JSON-RPC 2.0)                                       |
|  - Validates initialize handshake (-32002 if uninitialized)              |
|  - Dispatches methods: tools/list, tools/call, ping                      |
|  - Formats MCP response payload (content: [{type: 'text', text}])        |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| PlutonToolBridge (src/tools/bridge.ts)                                   |
|  - Enforces Ship role permissions (store.getShip().permissions)         |
|  - Realpath filesystem containment (resolveSessionReadRoots)             |
|  - Zod argument schema validation (src/tools/catalog.ts)                 |
|  - Event auditing (tool.call, tool.denied) to durable SQLite Store       |
|  - Enforces maxToolResultChars cap on returned output                    |
+--------------------------------------------------------------------------+
                                     |
                                     v
+--------------------------------------------------------------------------+
| Tool Handlers (src/tools/handlers.ts)                                    |
|  - task.create / delegate / inspect / wait / cancel / request_revision   |
|  - diff.inspect / project.read / scope.declare / ship.message / inbox    |
|  - Long-polling task.wait: WakeupRegistry event wakeups + heartbeat     |
+--------------------------------------------------------------------------+
```

### 2.2 Trace of a Single Tool Invocation (`task.wait`)

1. **Agent Invocation:**
   The OpenCode engine sends an HTTP POST request to the local bridge endpoint:
   `POST http://127.0.0.1:<port>/ HTTP/1.1`
   `Authorization: Bearer <32-byte-token>`
   `Content-Type: application/json`
   `{"jsonrpc":"2.0","id":101,"method":"tools/call","params":{"name":"task.wait","arguments":{"taskIds":["task-1"],"timeoutSeconds":30}}}`

2. **HTTP Ingestion & Authentication (`ToolHttpServer`):**
   - `handleRequest(req, res)` matches the token against `this.sessions` using timing-safe `timingSafeEqual()`.
   - `readBody(req)` streams the body, enforcing `maxRequestBytes` (1,048,576 bytes).
   - Generates an `AbortSignal` tied to client socket close and server shutdown: `this.requestSignal(res)`.

3. **MCP Protocol Dispatch (`McpStdioServer`):**
   - `handleLine(body, { signal })` parses JSON, validates the JSON-RPC envelope, checks that the session has been initialized.
   - Dispatches to `dispatchToolCall()` which invokes `this.host.call("task.wait", args, { signal })`.

4. **Authorization & Security Guard (`PlutonToolBridge`):**
   - Verifies `callerShipId` is an enabled Ship for `projectId`.
   - Checks that the Ship holds the `result.collect` permission required for `task.wait`.
   - Validates arguments against `TOOL_SCHEMAS['task.wait']` via Zod.
   - Records an audit event `tool.call` with execution duration once completed.

5. **Tool Execution (`TOOL_HANDLERS['task.wait']`):**
   - Verifies task visibility and status from SQLite `Store`.
   - Enters `waitSlice()` loop listening to `WakeupRegistry` on channel `run:<runId>:task:task-1`.
   - If the task completes, wakes up immediately and returns `{ reason: 'settled', settled: true, tasks: [...] }`.
   - If client disconnects or server stops, the `signal` abort listener breaks the loop immediately, returning `{ reason: 'aborted', timedOut: false }`.

6. **Serialization & Response Delivery:**
   - Result is bounded by `maxToolResultChars` (default 120,000 chars) via `this.bound()`.
   - Formatted as an MCP tool result: `{"jsonrpc":"2.0","id":101,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}`.
   - Sent over HTTP with status 200, `Content-Type: application/json`.

---

## 3. Subsystem Breakdown & Source Responsibilities

| File | Primary Responsibility | Critical Interfaces & Invariants |
| :--- | :--- | :--- |
| `src/tools/mcp-server.ts` | MCP stdio framing & JSON-RPC 2.0 | `McpToolHost`, `McpStdioServer`, `maxMessageBytes` (1 MB) |
| `src/tools/http-transport.ts` | Multiplexed HTTP/AF_UNIX server | `ToolHttpServer`, `maxRequestBytes` (1 MB), `DRAIN_GRACE_MS` (5s) |
| `src/tools/bridge.ts` | Authorization, path containment, auditing | `PlutonToolBridge`, `ToolBridgeLimits`, `maxToolResultChars` (120 KB) |
| `src/tools/catalog.ts` | Tool definitions, permissions, schemas | `TOOL_DEFS`, `TOOL_SCHEMAS`, `toolInfosForMcp()` |
| `src/tools/operator-catalog.ts` | Operator chat tool definitions | `OPERATOR_TOOL_DEFS`, `OPERATOR_TOOL_SCHEMAS` |
| `src/tools/handlers.ts` | Implementation of all tool operations | `TOOL_HANDLERS`, `waitSlice()`, `wakeupChannelFor()` |
| `src/cli/commands/mcp.ts` | Standalone stdio MCP server command | `pluton mcp serve`, `mcpServePlan()` |

---

## 4. Concurrency, Queueing & Buffer Analysis

### 4.1 Concurrency Behavior
- **Current State:** HTTP transport has **zero concurrency limits**. Multiple agent sessions or parallel requests within a session execute simultaneously without queuing, rate limiting, or backpressure.
- **Risks:**
  - Burst traffic can exhaust Node.js file descriptors or event loop capacity.
  - Concurrent mutating operations across tasks in the same run can cause SQLite write contention (`database is locked` / `SQLITE_BUSY`).
- **Required Hardening:**
  - Introduce configurable `maxConcurrentRequests` (global server level) and `maxConcurrentRequestsPerSession` (session level).
  - Implement bounded queueing with explicit backpressure: return HTTP 429 / 503 or JSON-RPC error code `-32000` (`capacity_exhausted`) when limits are exceeded.

### 4.2 Buffer & Memory Management
- **Body & Message Caps:**
  - `maxRequestBytes` = 1 MB (enforced in `ToolHttpServer`).
  - `maxMessageBytes` = 1 MB (enforced in `McpStdioServer`).
  - `maxToolResultChars` = 120,000 characters (enforced in `PlutonToolBridge`).
- **Identified Memory Leaks:**
  - In `src/orchestrator/service.ts`, `mcpServerFor` calls `http.register(bridge, ...)` for every task session and fallback attempt.
  - `http.unregister(token)` is never invoked upon task completion, causing tokens and associated bridge instances to persist in memory until `http.stop()`.

### 4.3 Cancellation & Timeout Semantics
- **HTTP Transport:** `res.once('close', ...)` properly signals cancellation via `AbortSignal`.
- **Drain on Shutdown:** `ToolHttpServer.stop()` aborts in-flight signals and waits up to `DRAIN_GRACE_MS` (5 seconds) for handlers to finish cleanly.
- **Invariant Preserved:** Cancellation terminates wait loops and prevents unneeded processing, but does not claim to roll back external side effects that have already committed to disk or git.

---

## 5. Test Coverage & Gap Analysis

### 5.1 Existing Tests
- `tests/unit/tool-http.test.ts`:
  - Token auth (valid, invalid, missing).
  - Protocol handshake, `tools/list`, and `tools/call`.
  - Session isolation across multiple tokens.
  - Notification 202 response.
  - Oversized body (413) and non-POST methods (405).
  - Server shutdown abort and drain grace period.
- `tests/unit/tool-bridge.test.ts`:
  - Permission enforcement and `tool.denied` auditing.
  - Path traversal and realpath escape rejection.
  - Task delegation, inspection, wait, and result reading.
- `tests/unit/mcp-server.test.ts`:
  - Framing, JSON-RPC parsing, error codes.
  - Uninitialized gate (-32002).

### 5.2 Gaps Identified for Phase A Hardening
1. **Concurrency and Backpressure:** No test currently verifies behavior when request volume exceeds server or session concurrency bounds.
2. **Session Cleanup:** No test validates `unregister()` behavior during task completion in the supervisor.
3. **Queue Rejection & Error Formatting:** No test asserts structured `capacity_exhausted` responses when overloaded.
4. **Duplicate Interface Cleanup:** Redundant `ToolBridgeLimits` interface in `src/tools/bridge.ts` must be consolidated.

---

## 6. Phase A Hardening Implementation & Verification

### 6.1 Changes Made
1. **Bounded Concurrency & FIFO Queueing (`src/tools/http-transport.ts`):**
   - Added configurable parameters: `maxConcurrentRequests` (default 64), `maxConcurrentRequestsPerSession` (default 8), and `maxQueueDepth` (default 16).
   - Enforced slot acquisition via `acquireSlot()` before dispatching to `session.server.handleLine()`.
   - Built a FIFO queue that schedules waiting requests as active slots complete.
   - Enforced backpressure: requests arriving when `queue.length >= maxQueueDepth` immediately receive HTTP 429 `{ error: 'capacity_exhausted', message: 'tool bridge concurrency capacity exceeded' }`.
   - Enforced client disconnect and cancellation handling: queued requests whose client disconnects or aborts are removed from the queue without executing or consuming a concurrency slot.
2. **Infinite Stream / Payload runaway drain protection (`src/tools/http-transport.ts`):**
   - `readBody()` now discards incoming stream data via `req.resume(); break` if body exceeds `maxRequestBytes * 2`, preventing unbounded slow-drain memory and CPU consumption while still cleanly delivering HTTP 413.
3. **Session Lifecycle Unregistration (`src/tools/http-transport.ts`, `src/orchestrator/supervisor.ts`, `src/orchestrator/service.ts`):**
   - Added `unregisterMatching(predicate: (spec: ToolHttpSessionSpec) => boolean): number` to `ToolHttpServer`, purging matching session tokens and canceling any pending queued requests for those sessions.
   - Added `onTaskTeardown` hook to `SupervisorOptions` and wired it into `RunSupervisor.executeTask()`'s `finally` block.
   - In `src/orchestrator/service.ts`, wired `onTaskTeardown` to unregister matching task tokens (`http.unregisterMatching(spec => spec.taskId === taskId)`) as soon as each task finishes.
4. **Cleaned Duplicate Interface (`src/tools/bridge.ts`):**
   - Removed redundant duplicate `interface ToolBridgeLimits` declaration.

### 6.2 Test Verification
- All 11 tests in `tests/unit/tool-http.test.ts` passing (including new tests for session concurrency limits, queue depth, backpressure 429, queued cancellation, and `unregisterMatching`).
- All 100 tool/MCP related tests passing across 6 suites.
- `npm run typecheck` passing with zero errors.

