# ADR-0007 — Dynamic delegation policy

- Status: Accepted (2026-10-16)

## Context

The Manager Muse may want specialists beyond the predefined team. Unbounded recursive delegation,
cycles, duplicate wakeups and hidden team growth are exactly the failure modes the prompt bans.

## Decision

- Delegation happens **only** through the daemon's restricted tool bridge; every call is
  validated server-side against caller identity, task, policy and runtime state. Manager prose is
  never authoritative state.
- **Hard limits (config, with safe upper bounds enforced at load time):**
  `max_team_size` (default 8), `max_delegation_depth` (default 3), `max_tasks_per_run`
  (default 20), `max_child_tasks_per_task` (default 5), per-task/per-run wall-clock budgets,
  max concurrent workers (default 3).
- **Graph invariants (validated before admission):** no dependency cycles; a child may not
  delegate to an ancestor; delegation depth of a new task = parent depth + 1, rejected beyond the
  limit; task count cap checked transactionally so parallel proposals cannot overshoot.
- **Dynamic specialists:** `muse.propose_create` is validated against policy (role, engine
  availability, model catalogue, team size, permissions) and — when it adds an engine or expands
  capabilities — requires an approval record per policy. Every creation and refusal is an event
  visible in `pluton logs`/`status`. Predefined-team mode can be enforced by config.
- A child completion wakes its parent **exactly once** (receipt); parents wait event-driven with
  timeout, not by polling loops.

## Consequences

- The Manager can scale the team within explicit bounds and never by spawning processes itself.
- Refusals are first-class, inspectable outcomes rather than silent truncation.

## Evidence

- Prompt §1.4 and §5.
- Enforced in `src/orchestrator/task-graph.ts` (depth/fan-out/task-cap/dependency/cycle admission)
  and the restricted bridge in `src/tools/`: `catalog.ts` (schema + permission per tool),
  `bridge.ts` (server-side identity/permission enforcement, per-call audit events, bounded results),
  `handlers.ts` (ancestor-assignee delegation rule, task-subtree visibility, cancel/stop transitions),
  `mcp-server.ts` (MCP stdio protocol layer) — with conformance tests in
  `tests/unit/tool-bridge.test.ts` (permissions, scopes, timeouts, bounding, MCP integration),
  `tests/unit/mcp-server.test.ts` and `tests/unit/wakeups.test.ts` (one wakeup per completed child,
  consume-once).
- `muse.propose_create` is operator-gated in this build: it validates team-size/role/engine/model
  limits and records a pending approval row (plus a `muse.proposal_recorded` event); nothing is
  instantiated silently, and applying an approved proposal is pending the run loop.
- Engine-side tool consumption recon (OpenCode v2 `mcp.servers.*` shape and Code-Mode visibility,
  Qwen approval-gated project scope, recommended host-side Streamable HTTP endpoint with per-Muse
  bearer tokens, stdio fallback) recorded in
  `docs/reverse-engineering/engine-mcp-integration.md`; container→host reachability is a Phase 6
  test item.
