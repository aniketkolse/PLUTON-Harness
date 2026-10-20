# Ship Workers AI Models & Persistent Multi-Agent Workspaces Design

**Status:** Draft for Review  
**Date:** 2026-10-20  
**Target:** PLUTON Multi-Agent Orchestrator  
**Reference Document:** `docs/superpowers/specs/2026-10-20-ship-workers-design.md`

---

## 1. Intent & The Why

PLUTON currently supports a supervisor and worker architecture, but role boundaries, model specializations, and real-time observability are partially fragmented. Users require a cohesive multi-agent system where a single **Manager** maintains the primary conversation, while four specialized coworkers (**QA**, **Researcher**, **Coder**, **Reviewer**) collaborate concurrently on complex engineering objectives.

Crucially:
- Independent workers must operate with dedicated OpenCode models tailored to their roles.
- Workspaces must be strictly isolated using Git worktrees so workers do not corrupt each other's checkouts or the main tree.
- Downstream tasks that depend on ambiguous requirements must pause cleanly while unblocked parallel tasks continue.
- Users must have immediate visibility into live coworker actions through a collapsible right-side sidebar with equal-height horizontal partitions for each active worker.

---

## 2. Goals, Non-Goals, & Anti-Goals

### 2.1 Goals
1. **Five Persistent AI Roles**:
   - `manager`: Primary user-facing supervisor in main chat; task breakdown, DAG scheduler, integration control.
   - `qa`: Requirements analyst and tester; generates acceptance criteria, detects edge cases, generates structured questions.
   - `researcher`: Read-only investigator; inspects codebase, queries docs/web, produces evidence-backed reports.
   - `coder`: Implementation and test runner; operates in isolated worktrees (`.pluton/worktrees/worker-*`).
   - `reviewer`: Independent verifier; evaluates Coder diffs, tests, and security constraints.
2. **Per-Role OpenCode Model Configuration**:
   - Persist provider/model configurations per role.
   - Validate against OpenCode model catalog. Never silently substitute models.
3. **Selective Dependency Pausing**:
   - When QA identifies an unanswered question requiring user input, the Manager escalates it via an **Interactive QA Card** in the main chat.
   - **Only tasks dependent on the answer pause** in `waiting` state; unblocked tasks (e.g. Researcher queries, independent modules) proceed concurrently.
4. **Right-Side Inspector Sidebar**:
   - Toggled via the Ship Status indicator (`🚀`) directly beside the microphone in the composer, or via `Esc`.
   - Divided into **equal-height horizontal partitions** for active workers:
     - 2 active workers = 50% height each.
     - 3 active workers = 33.3% height each.
     - 4 active workers = 25% height each.
   - Each partition displays role header, status pill, assigned model, isolated workspace path, independent scrollable activity stream, and structured report footer.
5. **Durable Persistence & SSE Delivery**:
   - Authoritative state lives in SQLite store; SSE stream delivers live updates. On page reload or reconnect, the inspector state is restored from durable storage without data loss.

### 2.2 Non-Goals
- Coworkers directly hijacking or taking over the main chat conversation.
- Shared-write checkouts across concurrent workers.
- Building a secondary or competing orchestrator outside PLUTON's supervisor and SQLite store.
- Granting unrestricted root or host access beyond configured sandbox and tool policies.

### 2.3 Anti-Goals
- Silent model fallback when a configured model is offline or invalid.
- Blanket-pausing the entire team when only one subtask is awaiting clarification.
- Staging or committing working tree changes without explicit human authorization.

---

## 3. Architecture & System Flow

```
                           +---------------------------+
                           |  User in Main Chat UI     |
                           +-------------+-------------+
                                         |
                                         v
                           +---------------------------+
                           |     Manager (Supervisor)   |
                           |  (OpenCode: Primary Model)|
                           +-------------+-------------+
                                         |
                     +-------------------+-------------------+
                     | Creates DAG tasks & dependencies     |
                     v                                       v
         +-----------------------+               +-----------------------+
         |     Task 1: QA        |               |   Task 2: Researcher  |
         | (Opus Thinking/Gemini)|               | (MiniMax/GLM/Nemotron)|
         +-----------+-----------+               +-----------+-----------+
                     |                                       |
    [Has Blocking Question?]                                 |
        /           \                                        |
     (Yes)          (No)                                     |
      /               \                                      |
     v                 v                                     |
+-------------------+   +--------------------+               |
| Interactive Card  |   | Unblocked Progress |               |
| in Chat: Pauses   |   +---------+----------+               |
| Task 3 (Coder)    |             |                          |
+---------+---------+             |                          |
          | (User Answers)        |                          |
          v                       v                          v
    +------------------------------------------------------------+
    |                    Task 3: Coder                           |
    |      (Isolated Git Worktree: .pluton/worktrees/worker-*)    |
    |          Implements, Runs Tests, Emits Diff & Report        |
    +-----------------------------+------------------------------+
                                  |
                                  v
    +------------------------------------------------------------+
    |                    Task 4: Reviewer                        |
    |       (Independent Verification of Diff & Test Evidence)    |
    +-----------------------------+------------------------------+
                                  |
                                  v
    +------------------------------------------------------------+
    |           Manager Coordinates Integration & Report         |
    +------------------------------------------------------------+
```

---

## 4. Detailed Component Design

### 4.1 Worker Registry & Role Definitions
Stored in `muses` table / `pluton.yaml` team definition:
- `manager`: role `supervisor`, workspace `coordinator-read-only`, permissions include task creation/orchestration/integration.
- `qa`: role `tester`, workspace `isolated-task-checkout` or `read-only` (for requirement analysis), tool policy for requirement analysis and test execution.
- `researcher`: role `researcher`, workspace `read-only`, tool policy for web search, document inspection, and codebase grepping.
- `coder`: role `coder`, workspace `isolated-task-checkout`, tool policy for file editing, bash/terminal, and test execution.
- `reviewer`: role `reviewer`, workspace `read-only`, tool policy for diff inspection, test execution, and static checks.

### 4.2 Model Selector & Catalog Validation
Supported IDs supplied:
- `9router/ag/claude-opus-4-6-thinking`
- `9router/ag/gemini-3.8-flash`
- `9router/ag/gemini-3.8-flash-high`
- `opencode/beam-free`
- `opencode/big-pickle`
- `opencode/deepseek-v4.1-flash-free`
- `opencode/glm-5.3-flash-free`
- `opencode/longcat-2.5-preview-free`
- `opencode/mimo-v2.6-flash-free`
- `opencode/minimax-m3.1-flash-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/nemotron-3.5-lightning-free`
- `opencode/nemotron-3.5-super-vl-free`

**Rules & Validation Contract:**
- Persist per-role model choice in `muses.model` / `pluton.yaml`.
- Query `OpenCodeAdapter.listModels()` (which runs `opencode models`) on discovery. For `9router/*` models, Pluton resolves custom providers via `opencode.json` provider config in the Muse's `engineHome` (`XDG_CONFIG_HOME`).
- If a configured model is not available or rejected by the engine adapter, mark its state as `unavailable` with a visible indicator in Settings and refuse task start. Never silently substitute a different model.

### 4.3 Manager Delegation & Task Graph
- The Manager translates goals into tasks in the `tasks` table with edge constraints in `task_edges`.
- Concurrency bounded by `runtime.max_concurrent_workers` (default 3).
- **Selective Dependency Pausing Mechanics:** Under Pluton's DAG scheduler (`store.listReadyTasks`), tasks with unfulfilled dependencies remain in `pending`. When QA initiates a question requiring user decision, the QA task transitions to `waiting` (via an open question approval). Downstream tasks dependent on QA remain `pending` and do not launch, while independent tasks (e.g. Researcher documentation queries) are unblocked and execute concurrently.
- **Manager Session Lifecycle:** Conforms to Pluton's process leak prevention (CS-9): the Manager session decomposes tasks via MCP tools and completes its turn without leaking indefinite ACP container processes. When a user confirms a QA decision, the supervisor receives a wakeup tick, records the resolution, and proceeds with the DAG.

### 4.4 QA Escalation & Question Contract
- QA workers communicate questions using the existing approval and permissions protocol:
  - QA emits a question of type `question` with structured options (or a free-form query) via `approval.request`.
  - The Question is persisted in the `approvals` table (`kind: 'question'`) with run and task correlation.
  - Chat stream renders the interactive QA card.
  - Answering the card calls `POST /api/approvals/:id/decide` with the selected option or answer.
  - The supervisor records the answer in the task receipt, transitions QA to `completed`, and the scheduler automatically unblocks dependent tasks.

### 4.5 Right-Side Inspector Sidebar Layout
- **Toggle**: Click the Ship indicator beside the mic (`#shipActivityBadgeContainer`), or press `Esc`.
- **Dimensions**: Fixed 440px width on desktop (overlay with scrim below 1000px breakpoint).
- **Partitioning**: Container `#rightInspectorGrid` uses flex column layout:
  - Active worker panels have `flex: 1 1 0; min-height: 0;`.
  - Exactly equal vertical heights (50% for 2, 33.3% for 3, 25% for 4).
- **Per-Worker Panel**:
  - `header`: Role avatar + label + status badge (`Running`, `Waiting`, `Paused`, `Completed`).
  - `meta`: Model tag + Worktree path tag (`.pluton/worktrees/worker-*`).
  - `stream`: Scrollable log view with timestamps, tool invocations, and warnings. Independent scroll preserves scroll position across SSE events.
  - `footer`: Structured report card (files changed, tests run, blockers).

### 4.6 Workspaces & Integration Safeguards
- Follows Pluton's proven ADR-0005 architecture: per-task isolated checkouts using `git clone --local` (hardlinked object store) under Pluton's workspaces root (`.pluton/workspaces/` or configured workspace directory).
- Avoids literal `git worktree` `.git` pointer breakage inside Docker container bind mounts.
- Checkouts are created strictly per-task: `pluton/<runId>/<slug>` to prevent sequential task cross-contamination.
- Integration into main workspace requires:
  1. No protected path violations (`src/workspace/protected-paths.ts`).
  2. Clean test/verification report.
  3. Reviewer approval.
  4. Human approval if `git.require_approval_for_main_branch_integration` is true.

---

## 5. Event Protocol & Persistence

### 5.1 Correlated Events
- `worker.created`: Worker instance registered.
- `worker.started`: Session launched with specific model and workspace.
- `worker.progress`: Live tool or reasoning step.
- `worker.question`: QA inquiry (optional human escalation).
- `worker.waiting`: Paused awaiting dependency or human input.
- `worker.report`: Structured outcome submitted to Manager.
- `worker.completed`: Task finished successfully.
- `worker.failed`: Task crashed or failed validation.
- `worker.cancelled`: Cancelled via user or circuit breaker.

### 5.2 Crash Recovery & Ownership
- SQLite persists task states, lease tokens, and supervisor ownership epochs.
- On server restart:
  - Supervisor ownership lease is verified.
  - Active tasks with missing heartbeats transition to `failed` or prompt for retry.
  - Worktree cleanup occurs only for explicitly verified inactive runs.

---

## 6. Verification & Test Plan

1. **Unit Tests**:
   - Role configuration schema validation and default assignment.
   - Model catalog discovery and unavailable model rejection.
   - DAG scheduler selective pause: verify Task C pauses on Task A without blocking Task B.
2. **Integration Tests**:
   - Multi-worker concurrent execution using deterministic mock OpenCode adapters.
   - Question resolution unblock cycle: question created -> tasks paused -> answer submitted -> tasks unpaused.
   - Git worktree isolation: ensure Coder workspace modifications do not appear in Researcher checkout.
3. **Frontend Tests**:
   - Ship indicator count updates and toggle behavior.
   - Right-side sidebar open/close via mic button and Esc.
   - Equal-height horizontal partition styling for 2, 3, and 4 active workers.
   - Interactive QA card submission and state change.
4. **Adversarial & Regression Gates**:
   - Zero modifications to protected release-gate files.
   - Working tree preservation (no uncommitted files staged or discarded).

---

## 7. What's Left to the Builder

- Exact CSS transitions and animation timing for the sidebar slide-in.
- Specific SVG iconography for each role badge.
- Formatting helpers for elapsed run time in the panel streams.
- Fine-grained heuristics for when Manager can auto-answer QA questions from local context vs escalating to the user.
