# Decoupled Inbox & Step Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Decouple user prompt admission from execution by introducing a persistent `session_inbox` and an asynchronous `SessionRunner` drain loop inspired by OpenCode's session architecture, eliminating 409 concurrency rejections and enabling multi-prompt queuing.

**Architecture:** A durable SQLite `session_inbox` table stores incoming user messages in FIFO order per session. `POST /api/sessions/:id/prompt` accepts messages immediately with `202 Accepted` without blocking on engine availability. A process-level `SessionRunner` coordinates per-session drain loops, processing turns sequentially, streaming tokens/tools over SSE, and handling operator cancellation cleanly.

**Tech Stack:** Node.js 24 (`node:sqlite`), TypeScript 5.9, SSE (`ServerSSEEvent`), Vitest.

**Spec:** OpenCode REA analysis `Y:\Setup\opencode-rea-analysis.md` (Sections 3.1–3.4: Session Architecture, Event Sourcing, Session Runner, Inbox System).

## Global Constraints
- Node.js ≥ 24 with built-in `node:sqlite` (no external SQLite native binaries).
- Forward-only migrations in `src/store/migrations.ts` (Rule: never edit shipped migrations 1–10; add Migration 11).
- No broken existing tests; maintain 100% pass rate across the 131 test files.
- Zero external runtime dependencies added.

## Review Focus
1. Rapid double-submit: Two prompts submitted in quick succession for the same session must both be accepted and processed in order without 409 errors.
2. Mid-flight cancellation: Cancelling a running session must terminate the active engine process, mark remaining queued inbox items as cancelled, and emit a clean `turn_end` event.
3. Crash recovery / restart: On server startup, any inbox items left in `processing` state must be marked `interrupted` or requeued, avoiding infinite stuck processing states.
4. Mode preservation: Plan vs Chat mode flags must be persisted per inbox item so queued plan prompts execute in plan mode even if subsequent prompts are chat mode.
5. Workspace switching with queued items: Changing workspace root while an inbox has pending items must apply cleanly to subsequent turns.

---

### Task 1: Migration 11: `session_inbox` Table & Store CRUD Operations

**Files:**
- Modify: `src/store/migrations.ts:400-415`
- Modify: `src/store/store.ts:1630-1670`
- Test: `tests/unit/session-inbox-store.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface InboxItem {
    id: string
    sessionId: string
    seq: number
    text: string
    mode: string
    state: 'enqueued' | 'processing' | 'delivered' | 'cancelled' | 'failed'
    createdAt: string
    processedAt: string | null
  }

  // Store methods:
  enqueueInboxItem(spec: { sessionId: string; text: string; mode?: string }): InboxItem
  listPendingInbox(sessionId: string): InboxItem[]
  getInboxItem(id: string): InboxItem | null
  updateInboxState(id: string, state: InboxItem['state'], processedAt?: string): void
  cancelPendingInbox(sessionId: string): number
  recoverStaleInboxItems(): number
  ```

- [x] **Step 1: Write the failing unit test**

Create `tests/unit/session-inbox-store.test.ts`:
```typescript
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'

describe('Session Inbox Store', () => {
  it('applies Migration 11 and manages inbox lifecycle', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const store = new Store(db)

    const proj = store.insertProject({
      name: 'test',
      rootPath: '/tmp/test',
      configPath: '/tmp/test/pluton.yaml',
      defaultBranch: 'main',
    })
    const session = store.createChatSession({
      projectId: proj.id,
      shipId: 'supervisor',
      title: 'Inbox Test',
    })

    // Enqueue
    const item1 = store.enqueueInboxItem({ sessionId: session.id, text: 'First prompt', mode: 'chat' })
    const item2 = store.enqueueInboxItem({ sessionId: session.id, text: 'Second prompt', mode: 'plan' })
    expect(item1.seq).toBe(1)
    expect(item2.seq).toBe(2)
    expect(item1.state).toBe('enqueued')

    // List pending
    const pending = store.listPendingInbox(session.id)
    expect(pending).toHaveLength(2)
    expect(pending[0]!.text).toBe('First prompt')

    // Update state
    store.updateInboxState(item1.id, 'processing')
    expect(store.getInboxItem(item1.id)?.state).toBe('processing')

    // Cancel pending
    const cancelledCount = store.cancelPendingInbox(session.id)
    expect(cancelledCount).toBe(1) // item2 was enqueued, item1 was processing
    expect(store.getInboxItem(item2.id)?.state).toBe('cancelled')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-inbox-store.test.ts`
Expected: FAIL with `store.enqueueInboxItem is not a function` or table does not exist.

- [x] **Step 3: Implement Migration 11 in `src/store/migrations.ts` and CRUD in `src/store/store.ts`**

In `src/store/migrations.ts`:
```typescript
  {
    version: 11,
    name: 'session-inbox',
    statements: [
      `CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'chat',
        state TEXT NOT NULL DEFAULT 'enqueued',
        created_at TEXT NOT NULL,
        processed_at TEXT
      )`,
      `CREATE INDEX idx_inbox_session_state ON session_inbox(session_id, state, seq)`,
    ],
  },
```

In `src/store/store.ts`:
Implement `enqueueInboxItem`, `listPendingInbox`, `getInboxItem`, `updateInboxState`, `cancelPendingInbox`, and `recoverStaleInboxItems`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/session-inbox-store.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/store/migrations.ts src/store/store.ts tests/unit/session-inbox-store.test.ts
git commit -m "feat(store): add session_inbox table and store operations (Migration 11)"
```

---

### Task 2: SessionRunner Execution Coordinator

**Files:**
- Create: `src/server/session-runner.ts`
- Test: `tests/unit/session-runner.test.ts`

**Interfaces:**
- Consumes:
  - `Store` from `src/store/store.ts`
  - `Broadcaster` from `src/server/events.ts`
  - `EngineSession`, `EngineAdapter` from `src/engines/contract/types.ts`
- Produces:
  ```typescript
  export interface SessionRunnerOptions {
    store: Store
    broadcaster: Broadcaster
    adapterResolver: (shipId: string, workspaceRoot: string) => EngineAdapter
    workspaceResolver: (sessionId: string) => string
    approvalTimeoutMinutes: number
  }

  export class SessionRunner {
    constructor(options: SessionRunnerOptions)
    enqueue(sessionId: string, text: string, mode?: string): InboxItem
    wake(sessionId: string): Promise<void>
    cancel(sessionId: string): Promise<boolean>
    isBusy(sessionId: string): boolean
    getQueueLength(sessionId: string): number
    close(): Promise<void>
  }
  ```

- [x] **Step 1: Write the failing unit test**

Create `tests/unit/session-runner.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { SessionRunner } from '../../src/server/session-runner.ts'
import { Broadcaster } from '../../src/server/events.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'

describe('SessionRunner', () => {
  it('drains enqueued inbox items sequentially and broadcasts turn events', async () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const store = new Store(db)
    const broadcaster = new Broadcaster()
    const broadcastEvents: any[] = []
    broadcaster.subscribe((e) => broadcastEvents.push(e))

    const proj = store.insertProject({ name: 'p', rootPath: '/tmp/p', configPath: '/tmp/p/pluton.yaml', defaultBranch: 'main' })
    const ship = store.insertShip({
      projectId: proj.id,
      slug: 'coder',
      displayName: 'Coder',
      role: 'developer',
      engineKind: 'mock',
      model: 'mock-model',
      workspacePolicy: 'workspace-write',
      approvalMode: 'autonomous',
      engineHome: '/tmp/home',
    })
    const session = store.createChatSession({ projectId: proj.id, shipId: ship.id, title: 'Test' })

    const mockAdapter = new MockEngineAdapter({ cannedResponses: ['Response 1', 'Response 2'] })
    const runner = new SessionRunner({
      store,
      broadcaster,
      adapterResolver: () => mockAdapter,
      workspaceResolver: () => '/tmp/p',
      approvalTimeoutMinutes: 10,
    })

    // Enqueue two items
    runner.enqueue(session.id, 'Prompt 1', 'chat')
    runner.enqueue(session.id, 'Prompt 2', 'chat')

    // Wait until queue is drained
    while (runner.isBusy(session.id) || runner.getQueueLength(session.id) > 0) {
      await new Promise((r) => setTimeout(r, 20))
    }

    const messages = store.listChatMessages(session.id, 10)
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2)

    await runner.close()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-runner.test.ts`
Expected: FAIL with module `src/server/session-runner.ts` not found.

- [x] **Step 3: Implement `SessionRunner` in `src/server/session-runner.ts`**

Implement sequential drain loop:
- `enqueue()` inserts into `session_inbox` and calls `void this.wake(sessionId)`.
- `wake()` starts the async worker loop if not already running for `sessionId`.
- While pending items exist:
  - Fetches next item in FIFO order.
  - Updates item state to `'processing'`.
  - Appends user message to `chat_messages` (if not already appended).
  - Broadcasts `turn_start`.
  - Streams response tokens and tool calls from engine adapter.
  - Appends assistant response to `chat_messages`.
  - Updates item state to `'delivered'`.
  - Broadcasts `turn_end`.
- Handles cancellation by aborting running adapter turn, updating current item to `'cancelled'`, and marking subsequent queued items as `'cancelled'`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/session-runner.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/server/session-runner.ts tests/unit/session-runner.test.ts
git commit -m "feat(server): implement SessionRunner execution coordinator"
```

---

### Task 3: Wire SessionRunner into HTTP API Routes

**Files:**
- Modify: `src/server/routes.ts:415-465, 1500-1645`
- Modify: `src/server/server.ts:60-95`
- Test: `tests/integration/session-inbox-routes.test.ts`

**Interfaces:**
- Consumes: `SessionRunner` from `src/server/session-runner.ts`
- Modifies endpoints:
  - `POST /api/sessions/:id/prompt`: Returns `202 Accepted` with `{ ok: true, status: 'enqueued', queueLength, inboxId }` regardless of whether engine is busy.
  - `POST /api/sessions/:id/cancel`: Cancels running execution and queued items via `runner.cancel(sessionId)`.
  - `GET /api/sessions/:id`: Includes `busy: boolean` and `queueLength: number`.

- [x] **Step 1: Write the failing integration test**

Create `tests/integration/session-inbox-routes.test.ts`:
```typescript
import { describe, expect, it } from 'vitest'
import { setupTestProject } from './helpers.ts'

describe('Session Inbox HTTP Routes', () => {
  it('accepts subsequent prompts with HTTP 202 instead of 409 when busy', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      // Create session
      const createRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shipId: 'supervisor', title: 'Inbox Route Test' }),
      })
      const { session } = await createRes.json()

      // First prompt
      const p1 = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Count to 5' }),
      })
      expect(p1.status).toBe(202)

      // Second prompt immediately while first is running
      const p2 = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Count to 10' }),
      })
      // MUST NOT return 409
      expect(p2.status).toBe(202)
      const data2 = await p2.json()
      expect(data2.ok).toBe(true)
      expect(data2.status).toBe('enqueued')
    } finally {
      await server.close()
    }
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/session-inbox-routes.test.ts`
Expected: FAIL with HTTP status 409 on second prompt.

- [x] **Step 3: Integrate `SessionRunner` in `src/server/server.ts` and `src/server/routes.ts`**

- Instantiate `SessionRunner` in `Server` context.
- Replace manual `entry.busy` checks in `routes.ts` with `runner.enqueue(sessionId, text, mode)`.
- Update `/api/sessions/:id/prompt` to return `202 Accepted` with queue status.
- Update `/api/sessions/:id/cancel` to delegate to `runner.cancel(sessionId)`.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/session-inbox-routes.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/server/routes.ts src/server/server.ts tests/integration/session-inbox-routes.test.ts
git commit -m "feat(server): wire SessionRunner into prompt routes to eliminate 409 busy locks"
```

---

### Task 4: Client SPA UI Queue Rendering and Non-Blocking Composer

**Files:**
- Modify: `src/server/static-assets.ts`
- Test: `tests/integration/spa-inbox-ui.test.ts`

**Interfaces:**
- Consumes: SSE `queue_updated` or `turn_start`/`turn_end` events, `queueLength` from session detail.
- Produces:
  - Non-blocking composer: user can type and submit next message while turn is running.
  - Queued message cards displayed with `.is-queued` chip until turn begins.
  - Thinking bar shows queue count indicator when `queueLength > 0`.

- [x] **Step 1: Write the failing integration test**

Create `tests/integration/spa-inbox-ui.test.ts`:
```typescript
import { describe, expect, it } from 'vitest'
import { setupTestProject } from './helpers.ts'

describe('SPA Inbox UI', () => {
  it('supports sending prompts while busy and presents queued badge', async () => {
    const { appServer } = await setupTestProject()
    const server = await appServer
    try {
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()

      // Checks for queue badge and non-blocking composer handling
      expect(js).toContain('queueLength')
      expect(js).toContain('status === "enqueued"')
      expect(html).toContain('queue-badge')
    } finally {
      await server.close()
    }
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/spa-inbox-ui.test.ts`
Expected: FAIL.

- [x] **Step 3: Update `src/server/static-assets.ts`**

- Allow composer submission while busy (enqueueing the message instead of disabling the input).
- Add visual `.queue-badge` to header/thinking indicator.
- Render queued messages in the transcript immediately with a subtle `Queued` chip.
- When `turn_start` arrives for that turn, remove the queued chip and begin active streaming.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/spa-inbox-ui.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/server/static-assets.ts tests/integration/spa-inbox-ui.test.ts
git commit -m "feat(ui): support non-blocking prompt queuing and queued badges in SPA"
```

---

### Task 5: Full Test Suite Verification & Asset Verification

**Files:**
- Run full checks across all unit, integration, and asset tests.

- [x] **Step 1: Run unit asset verification**

Run: `npx vitest run tests/unit/verify-assets.test.ts`
Expected: PASS

- [x] **Step 2: Run full check**

Run: `npm run check`
Expected: PASS with 0 TypeScript errors and all 131+ test files passing.

- [x] **Step 3: Commit final integration**

```bash
git commit --allow-empty -m "chore: complete decoupled inbox and step runner implementation"
```
