# Ship Workers AI Models & Persistent Multi-Agent Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement production-ready Ship Workers in PLUTON featuring five persistent AI roles (Manager, QA, Researcher, Coder, Reviewer), per-role OpenCode models, isolated Git per-task checkouts, selective dependency pausing, interactive chat question cards, and a collapsible right-side sidebar with equal-height horizontal partitions.

**Architecture:** Extend PLUTON's existing supervisor, SQLite store, and OpenCode adapter. The Manager remains the primary user-facing conversational supervisor in the main chat. Coworkers execute tasks concurrently via isolated per-task checkouts (`git clone --local`), report structured findings, and pause only downstream dependencies when QA escalates questions requiring human decisions. A 440px right-side drawer toggled beside the microphone renders equal-height horizontal partitions for active workers.

**Tech Stack:** TypeScript, Node.js (v20+), SQLite (`better-sqlite3`), OpenCode CLI / ACP protocol, Server-Sent Events (SSE), Vanilla HTML5/CSS3/JS embedded SPA.

**Spec:** `docs/superpowers/specs/2026-10-20-ship-workers-design.md`

## Global Constraints

- **Single Conversational Contact:** The Manager is the only primary conversational supervisor; coworkers never independently take over the main chat.
- **Five Persistent Roles:** Exactly five persistent records: `manager` (Supervisor), `qa` (Tester/Analyst), `researcher` (Researcher), `coder` (Coder), `reviewer` (Reviewer).
- **Workspace Isolation:** Use Pluton's ADR-0005 per-task checkouts (`git clone --local` with hardlinked object store) under `.pluton/workspaces/`. Never use literal Git worktrees that break inside Docker container mounts.
- **Selective Pausing:** An open QA question pauses only dependent downstream tasks; independent tasks proceed concurrently.
- **No Silent Fallback:** Supplied model IDs must be validated against the engine catalog; unavailable models trigger an explicit error and task refusal.
- **Right Sidebar Layout:** 440px right-side collapsible drawer toggled via the ship badge beside the mic or `Esc`. Active workers are partitioned into equal-height horizontal rows (50% for 2, 33.3% for 3, 25% for 4). If >4 active workers or window <1000px, responsive scrollable column with 160px min-height per worker.
- **Authoritative Persistence Before Broadcast:** Every worker lifecycle event is persisted to SQLite `events` before SSE broadcast. Reconnect restores inspector state from SQLite.
- **Working Tree Preservation:** Do not stage, commit, push, tag, stash, or reset existing uncommitted work without explicit owner authorization.

## Review Focus

1. **Unavailable Model on Startup:** A worker configured with an invalid or offline model ID must be flagged as `unavailable` in settings and fail cleanly on task launch without silent fallback.
2. **Selective Dependency Invariant:** An open QA question must pause Task C (dependent on QA) while Task B (independent Researcher) continues to make active progress.
3. **Question Card Idempotency & Auth:** Submitting an answer to the interactive QA card multiple times must not create duplicate approval decisions or corrupt task state, and must enforce caller authorization.
4. **SSE Stream Reconnect:** Refreshing or reconnecting the UI while workers are running must restore the inspector drawer and activity streams from durable SQLite records without clearing scroll position or active task state.
5. **Clean Workspace Isolation:** Coder file writes inside `.pluton/workspaces/worker-coder-*` must not touch the main repository or the Researcher's read-only checkout.

## Assumptions & Architectural Clarifications

1. **Model Discovery Scope:** `opencode models` returns native OpenCode models. For `9router/*` models, provider settings reside in the Muse's `engineHome` (`opencode.json` / `providers`). Models not found in either are flagged as `unavailable` with execution refusal.
2. **Question Persistence:** QA questions map to the existing `approvals` schema (`kind: 'question'`). The `details` JSON field holds question metadata, options, and dependent task IDs. Submitting a decision via `POST /api/approvals/:id/decide` is idempotent: subsequent submissions return the existing resolution without error.
3. **Per-Task Checkout Cleanliness:** Per ADR-0005, each task checkout is created at `.pluton/workspaces/<runId>/<slug>` on branch `pluton/<runId>/<slug>`. Reusable worker home directories are strictly for engine config and caches; checkouts are strictly per-task.

---

### Task 1: Five Persistent Roles & Role Registry Configuration

**Files:**
- Modify: `src/domain/models.ts:10-35`
- Modify: `src/config/schema.ts:19-45`
- Modify: `pluton.yaml:33-89`
- Test: `tests/config/ship-roles.test.ts`

**Interfaces:**
- Consumes: `MUSE_ROLES`, `museConfigSchema`, `LoadedConfig`
- Produces: Defined roles `manager`, `qa`, `researcher`, `coder`, `reviewer` with default workspace policies and tool permissions

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config/ship-roles.test.ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config/load.ts'
import { MUSE_ROLES } from '../../src/domain/models.ts'

describe('Ship Workers Role Registry', () => {
  it('defines all 5 persistent roles in pluton.yaml', () => {
    const { config } = loadConfig('pluton.yaml')
    expect(config.muses['manager']).toBeDefined()
    expect(config.muses['qa']).toBeDefined()
    expect(config.muses['researcher']).toBeDefined()
    expect(config.muses['coder']).toBeDefined()
    expect(config.muses['reviewer']).toBeDefined()
    
    expect(config.muses['manager'].role).toBe('supervisor')
    expect(config.muses['qa'].role).toBe('tester')
    expect(config.muses['researcher'].role).toBe('researcher')
    expect(config.muses['coder'].role).toBe('coder')
    expect(config.muses['reviewer'].role).toBe('reviewer')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/ship-roles.test.ts`
Expected: FAIL (`config.muses['coder']` undefined because `pluton.yaml` currently has `worker-a`/`worker-b`)

- [ ] **Step 3: Update `pluton.yaml`, `src/domain/models.ts`, and `src/config/schema.ts`**

Define the canonical `coder` role record alongside `manager`, `qa`, `researcher`, `reviewer`. Ensure `MUSE_ROLES` enforces validation for all 5 roles.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/ship-roles.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 2: Model Selector Validation & Availability Checks

**Files:**
- Modify: `src/engines/opencode/adapter.ts:320-360`
- Modify: `src/server/routes.ts:620-645`
- Test: `tests/engines/opencode-model-validation.test.ts`

**Interfaces:**
- Consumes: Supplied 13 model IDs, `OpenCodeAdapter.listModels()`
- Produces: Validated model list with `available: boolean` flags and refusal on unavailable model execution

- [ ] **Step 1: Write the failing test**

```typescript
// tests/engines/opencode-model-validation.test.ts
import { describe, it, expect } from 'vitest'
import { OpenCodeAdapter } from '../../src/engines/opencode/adapter.ts'

describe('OpenCode Model Catalog Validation', () => {
  it('flags unavailable models and refuses silent substitution', async () => {
    const adapter = new OpenCodeAdapter({ runFn: async () => ({ stdout: 'opencode/minimax-m3.1-flash-free\n', stderr: '', exitCode: 0, timedOut: false }) })
    const models = await adapter.listModelsWithAvailability([
      'opencode/minimax-m3.1-flash-free',
      'opencode/non-existent-model'
    ])
    expect(models.find(m => m.id === 'opencode/minimax-m3.1-flash-free')?.available).toBe(true)
    expect(models.find(m => m.id === 'opencode/non-existent-model')?.available).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engines/opencode-model-validation.test.ts`
Expected: FAIL (`listModelsWithAvailability` is not a function)

- [ ] **Step 3: Implement `listModelsWithAvailability` in `OpenCodeAdapter`**

Add `listModelsWithAvailability(requiredModels: string[])` to query available engine models, tag each requested model as available or unavailable, and reject unpinned or unavailable models on session start.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engines/opencode-model-validation.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 3: Selective Dependency Pausing in DAG Scheduler

**Files:**
- Modify: `src/orchestrator/task-graph.ts:40-90`
- Modify: `src/orchestrator/supervisor.ts:850-930`
- Modify: `src/store/store.ts:410-450`
- Test: `tests/orchestrator/selective-pausing.test.ts`

**Interfaces:**
- Consumes: `store.listReadyTasks(runId)`, `task_edges`
- Produces: Selective DAG execution: unblocked tasks proceed while tasks dependent on waiting/question tasks pause

- [ ] **Step 1: Write the failing test**

```typescript
// tests/orchestrator/selective-pausing.test.ts
import { describe, it, expect } from 'vitest'
import { TaskGraph } from '../../src/orchestrator/task-graph.ts'

describe('Selective DAG Dependency Pausing', () => {
  it('allows independent tasks to run while dependent tasks pause on QA question', () => {
    const graph = new TaskGraph()
    graph.addTask('task-qa', { role: 'qa', state: 'waiting' })
    graph.addTask('task-researcher', { role: 'researcher', state: 'pending' })
    graph.addTask('task-coder', { role: 'coder', state: 'pending' })
    
    // Coder depends on QA, Researcher is independent
    graph.addEdge('task-qa', 'task-coder')

    const ready = graph.getReadyTasks()
    expect(ready).toContain('task-researcher')
    expect(ready).not.toContain('task-coder')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/selective-pausing.test.ts`
Expected: FAIL (`TaskGraph` does not filter out dependents of `waiting` tasks)

- [ ] **Step 3: Update `getReadyTasks` and `supervisor.ts` control loop**

Ensure tasks whose dependencies are in `waiting` or `blocked` state remain in `pending` and are not dispatched, while tasks with no open dependencies are returned as ready.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator/selective-pausing.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 4: QA Question Escalation & Unblocking Mechanics

**Files:**
- Modify: `src/server/routes.ts:410-450`
- Modify: `src/orchestrator/supervisor.ts:950-1010`
- Modify: `src/store/store.ts:500-540`
- Test: `tests/orchestrator/qa-question-unblock.test.ts`

**Interfaces:**
- Consumes: `POST /api/approvals/:id/decide`, `approval.request`
- Produces: Question resolution event, task transition from `waiting` to `completed`, automatic scheduling of dependent tasks

- [ ] **Step 1: Write the failing test**

```typescript
// tests/orchestrator/qa-question-unblock.test.ts
import { describe, it, expect } from 'vitest'
import { handleQuestionDecision } from '../../src/server/routes.ts'

describe('QA Question Decision & Unblocking', () => {
  it('resolves approval and transitions dependent task to ready', async () => {
    const result = await handleQuestionDecision({
      approvalId: 'app-q1',
      decision: 'approved',
      selectedOption: 'Option A'
    })
    expect(result.status).toBe('resolved')
    expect(result.unblockedTasks).toContain('task-coder')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator/qa-question-unblock.test.ts`
Expected: FAIL (`handleQuestionDecision` is not exported)

- [ ] **Step 3: Implement question approval resolution in `routes.ts` & `supervisor.ts`**

Map question decisions to task receipts, mark the question as resolved, record wakeups in `supervisor.ts`, and trigger immediate scheduler tick.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator/qa-question-unblock.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 5: Correlated Worker Events & Authoritative SSE Persistence

**Files:**
- Modify: `src/server/events.ts:30-80`
- Modify: `src/domain/state.ts:15-40`
- Test: `tests/server/worker-events-stream.test.ts`

**Interfaces:**
- Consumes: `worker.started`, `worker.progress`, `worker.waiting`, `worker.report`, `worker.completed`
- Produces: Typed SSE broadcast payloads and durable event rows in SQLite

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/worker-events-stream.test.ts
import { describe, it, expect } from 'vitest'
import { ServerEventBroadcaster } from '../../src/server/events.ts'

describe('Worker Events SSE Broadcast', () => {
  it('broadcasts sanitized worker events with run and role correlation', () => {
    const broadcaster = new ServerEventBroadcaster()
    let emitted: any = null
    broadcaster.on('event', (e) => { emitted = e })

    broadcaster.broadcastWorkerEvent({
      type: 'worker.progress',
      runId: 'run-101',
      taskId: 'task-coder-1',
      role: 'coder',
      model: 'gemini-3.8-flash',
      workspace: '.pluton/workspaces/task-1',
      payload: { step: 'editing src/store.ts' }
    })

    expect(emitted.type).toBe('worker.progress')
    expect(emitted.role).toBe('coder')
    expect(emitted.workspace).toBe('.pluton/workspaces/task-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/worker-events-stream.test.ts`
Expected: FAIL (`broadcastWorkerEvent` is not a function)

- [ ] **Step 3: Implement `broadcastWorkerEvent` in `src/server/events.ts`**

Sanitize payloads (stripping secrets and unbounded buffers), correlate IDs, persist to `events` table, and push to active SSE client connections.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/worker-events-stream.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 6: Interactive QA Question Card in Chat UI

**Files:**
- Modify: `src/server/static-assets.ts:1800-1900` (renderMessage)
- Modify: `src/server/static-assets.ts:2400-2500` (card handlers)
- Test: `tests/ui/qa-question-card.test.ts`

**Interfaces:**
- Consumes: `approval_requested` SSE event for `kind === 'question'`, `POST /api/approvals/:id/decide`
- Produces: Chat card with title, description, options, and instant unblock confirmation upon click

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui/qa-question-card.test.ts
import { describe, it, expect } from 'vitest'
import { renderQaQuestionCardHtml } from '../../src/server/static-assets.ts'

describe('Interactive QA Question Card HTML', () => {
  it('renders options, dependent task badges, and submit button', () => {
    const html = renderQaQuestionCardHtml({
      id: 'app-q1',
      title: 'Heartbeat Timeout Strategy',
      description: 'Choose failover threshold',
      dependentTasks: ['task-coder-3'],
      options: ['3 Heartbeats', 'Manual Approval']
    })
    expect(html).toContain('qa-card')
    expect(html).toContain('Heartbeat Timeout Strategy')
    expect(html).toContain('task-coder-3')
    expect(html).toContain('Confirm & Unblock')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/qa-question-card.test.ts`
Expected: FAIL (`renderQaQuestionCardHtml` is not exported)

- [ ] **Step 3: Implement `renderQaQuestionCardHtml` and client-side decision POST**

Embed the question card renderer in `src/server/static-assets.ts`. Bind option click handlers and dispatch `/api/approvals/:id/decide`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/qa-question-card.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 7: Collapsible Right-Side Inspector Sidebar & Ship Indicator

**Files:**
- Modify: `src/server/static-assets.ts:300-330` (HTML markup beside mic)
- Modify: `src/server/static-assets.ts:1100-1250` (CSS: 440px drawer & equal-height partitions)
- Modify: `src/server/static-assets.ts:3120-3220` (JS: toggle, SSE listeners, partition updates)
- Test: `tests/ui/ship-inspector-sidebar.test.ts`

**Interfaces:**
- Consumes: `#shipActivityBadgeContainer` beside `#btnMic`, `Esc` keydown, worker activity stream
- Produces: Right-side sidebar (`#rightInspector`) with equal-height horizontal worker rows (50%/33.3%/25%) and independent scroll preservation

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui/ship-inspector-sidebar.test.ts
import { describe, it, expect } from 'vitest'
import { STATIC_ASSETS } from '../../src/server/static-assets.ts'

describe('Right-Side Inspector Sidebar Assets', () => {
  it('contains #rightInspector with horizontal partition styles and toggle hook', () => {
    const indexHtml = STATIC_ASSETS['/index.html'].content
    expect(indexHtml).toContain('id="rightInspector"')
    expect(indexHtml).toContain('id="rightInspectorGrid"')
    expect(indexHtml).toContain('shipActivityBadgeContainer')
    
    const appCss = STATIC_ASSETS['/app.css']?.content || indexHtml
    expect(appCss).toContain('width: 440px')
    expect(appCss).toContain('flex: 1 1 0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/ship-inspector-sidebar.test.ts`
Expected: FAIL (`id="rightInspector"` not found in `/index.html`)

- [ ] **Step 3: Implement sidebar markup, CSS, and interaction logic in `static-assets.ts`**

Add `#rightInspector` drawer to the main layout. Wire `#shipActivityBadgeContainer` click and `Esc` keydown to toggle visibility. Update CSS to partition active workers into equal-height rows (`flex: 1 1 0; min-height: 0;`). Render per-worker stream with independent scrolling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/ship-inspector-sidebar.test.ts`
Expected: PASS

- [ ] **Step 5: Verify build & tests**

Run: `npm run typecheck`
Expected: 0 type errors.

---

### Task 8: End-to-End Multi-Worker Orchestration Test

**Files:**
- Create: `tests/e2e/ship-workers-e2e.test.ts`

**Interfaces:**
- Consumes: `Supervisor`, `GitWorkspaceManager`, `Store`, `ServerEventBroadcaster`
- Produces: Full workflow verification: Manager delegates -> QA pauses Coder -> Researcher runs parallel -> QA card answered -> Coder executes in isolated worktree -> Reviewer verifies diff -> Manager completes run

- [ ] **Step 1: Write the end-to-end integration test**

```typescript
// tests/e2e/ship-workers-e2e.test.ts
import { describe, it, expect } from 'vitest'
import { createTestContext } from '../helpers/context.ts'

describe('Ship Workers Complete Orchestration E2E', () => {
  it('runs complete multi-agent workflow with selective pausing and isolated workspaces', async () => {
    const ctx = await createTestContext()
    const runId = await ctx.startRun('Investigate architecture and fix reliability')
    
    // 1. Manager decomposes into QA, Researcher, Coder, Reviewer
    // 2. QA emits question, Coder pauses, Researcher proceeds
    // 3. User answers QA question via API
    // 4. Coder finishes task in isolated checkout
    // 5. Reviewer validates diff
    // 6. Run completes cleanly
    const finalRun = await ctx.waitForRunCompletion(runId)
    expect(finalRun.state).toBe('succeeded')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e/ship-workers-e2e.test.ts`
Expected: FAIL before full feature integration.

- [ ] **Step 3: Connect orchestrator components**

Ensure all 5 roles interact cleanly across the DAG scheduler, approval channel, and isolated worktree checkouts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/e2e/ship-workers-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite & typecheck**

Run: `npm test && npm run typecheck`
Expected: All tests pass, 0 type errors.

---

### Task 9: Adversarial Review & Release Gates Verification

**Files:**
- None modified; verification only

**Interfaces:**
- Consumes: Test runner, Git status, Gate file hashes
- Produces: PASS/FAIL verification report ensuring zero regression across the 1050+ existing tests and zero modifications to release-gate files

- [ ] **Step 1: Verify gate hashes match frozen baseline**

Run: `Get-FileHash (gate files) | Format-List`
Expected: 6/6 match frozen baseline.

- [ ] **Step 2: Verify git status contains 0 staged files**

Run: `git status --porcelain`
Expected: Staged files count = 0. All changes remain unstaged.

- [ ] **Step 3: Run comprehensive test suite**

Run: `npm test`
Expected: 1050+ tests pass with zero failures.
