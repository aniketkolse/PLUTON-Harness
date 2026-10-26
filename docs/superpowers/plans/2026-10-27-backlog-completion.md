# Backlog Completion & Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four prioritized tasks: commit the current working tree, add JSONL Session Export/Import, refactor module boundaries to eliminate CLI import debt, and add SQLite FTS5 Full-Text Search.

**Architecture:**
- Task 1: Review and commit the 5 working tree files (folder picker, ACP tool normalization, sandbox config, and tests).
- Task 2: Implement streaming JSONL serialization and deserialization for runs and chat sessions in `src/store/` with validation, and wire CLI commands `pluton session export/import`.
- Task 3: Extract shared orchestration, approval, and run services from `src/cli/` into `src/orchestrator/service.ts` so `src/server/routes.ts` and `src/tools/operator-catalog.ts` do not depend on `src/cli/`, removing the module boundary allowlist.
- Task 4: Add SQLite Migration 12 with FTS5 virtual tables (`events_fts` and `chat_messages_fts`) with automatic sync triggers or store indexing, and expose full-text search methods on `Store` and `pluton search` CLI command.

**Tech Stack:** Node.js 24 (`node:sqlite`), TypeScript 5.9, Commander.js, Vitest.

**Spec:** `docs/PLUTON_IMPLEMENTATION_ROADMAP.md` (P2 items, P6 gates, CG-8) and `docs/PLUTON_FEATURE_PARITY.md`.

## Global Constraints
- Node.js >= 24 with built-in `node:sqlite`.
- Forward-only SQLite migrations: never alter migrations 1–11; Migration 12 adds FTS5 tables and triggers.
- Strictly adhere to Pluton architecture rules: clean module boundaries without circular dependencies or presentation/CLI layer leaks.
- 100% pass rate across all Vitest suites and 0 TypeScript compilation errors (`npm run check`).

## Review Focus
1. Working tree cleanliness: Commit 1 must leave working tree clean with 0 unstaged files and all 135 test files passing.
2. JSONL Malformed Input: Importing invalid JSONL (corrupt JSON lines, mismatched session schema, ID collisions) must fail cleanly with descriptive validation errors without leaving partial corrupted records.
3. Module Boundary Invariants: `tests/unit/module-boundaries.test.ts` must pass with an empty or removed `CLI_IMPORT_ALLOWLIST`.
4. FTS5 Index Synchronization: Adding, updating, or deleting chat messages or events must maintain exact parity in the FTS5 virtual tables via SQLite triggers.
5. FTS5 Query Escaping: Special characters in search queries (e.g., quotes, colons, wildcards) must be sanitized so unescaped input does not crash SQLite FTS5 parser.

---

### Task 1: Commit Current Working Tree Changes

**Files:**
- Commit: `pluton.yaml`
- Commit: `src/engines/acp/normalize.ts`
- Commit: `src/server/folder-picker.ts`
- Commit: `tests/integration/spa-ui.test.ts`
- Commit: `tests/unit/acp-normalize-tool.test.ts`

- [x] **Step 1: Verify current test pass rate**

Run: `npx vitest run tests/unit/acp-normalize-tool.test.ts tests/integration/spa-ui.test.ts`
Expected: PASS

- [x] **Step 2: Stage and commit the 5 files**

```bash
git add pluton.yaml src/engines/acp/normalize.ts src/server/folder-picker.ts tests/integration/spa-ui.test.ts tests/unit/acp-normalize-tool.test.ts
git commit -m "feat(server): modernize Windows folder picker and refine ACP tool normalization"
```

- [x] **Step 3: Verify working tree is clean**

Run: `git status -s`
Expected: Empty output (clean working tree).

---

### Task 2: Session and Run JSONL Export & Import

**Files:**
- Create: `src/store/jsonl.ts`
- Modify: `src/store/store.ts`
- Create: `src/cli/commands/session.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/unit/jsonl-export-import.test.ts`
- Test: `tests/integration/cli-session-export-import.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ExportSessionResult {
    session: ChatSessionRecord
    messages: ChatMessageRecord[]
  }

  export interface ExportRunResult {
    run: RunRecord
    tasks: TaskRecord[]
    events: EventRecord[]
  }

  export function exportSessionToJsonl(store: Store, sessionId: string): string
  export function importSessionFromJsonl(store: Store, jsonl: string, opts?: { targetProjectId?: string }): { session: ChatSessionRecord; messageCount: number }
  export function exportRunToJsonl(store: Store, runId: string): string
  export function importRunFromJsonl(store: Store, jsonl: string, opts?: { targetProjectId?: string }): { run: RunRecord; taskCount: number; eventCount: number }
  ```

- [x] **Step 1: Write failing unit tests in `tests/unit/jsonl-export-import.test.ts`**

Cover export/import of chat sessions and orchestration runs, ID collision handling, and malformed JSONL rejection.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/jsonl-export-import.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Implement JSONL export and import in `src/store/jsonl.ts`**

Export records sequentially with type tag header `{ type: 'session' | 'message' | 'run' | 'task' | 'event', data: ... }`.
Validate on import using safe parsing, reject corrupted lines, and insert into SQLite transactionally.

- [x] **Step 4: Wire CLI commands in `src/cli/commands/session.ts` and `src/cli/main.ts`**

Expose `pluton session export <id> [--out <file>]` and `pluton session import <file>`.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/jsonl-export-import.test.ts tests/integration/cli-session-export-import.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/store/jsonl.ts src/cli/commands/session.ts src/cli/main.ts tests/unit/jsonl-export-import.test.ts tests/integration/cli-session-export-import.test.ts
git commit -m "feat(store): implement JSONL session and run export/import with CLI commands"
```

---

### Task 3: Refactor Module Boundaries: Decouple Server & Tools from CLI

**Files:**
- Create: `src/orchestrator/service.ts`
- Modify: `src/cli/commands/run.ts`
- Modify: `src/cli/commands/approvals.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/tools/operator-catalog.ts`
- Modify: `tests/unit/module-boundaries.test.ts`
- Test: `tests/unit/module-boundaries.test.ts`

**Interfaces:**
- Move from `src/cli/commands/run.ts`, `src/cli/commands/approvals.ts`, and `src/cli/commands/status.ts` to `src/orchestrator/service.ts`:
  - `startRunInBackground`, `requestRunCancel`, `resumeRun`, `settleRunCrashed`, `RunDeps`
  - `decideApproval`, `sweepExpiredApprovals`
  - `runByRef`
- Both `src/cli/commands/*` and `src/server/routes.ts` / `src/tools/operator-catalog.ts` import from `src/orchestrator/service.ts`.
- In `tests/unit/module-boundaries.test.ts`, remove `CLI_IMPORT_ALLOWLIST` or assert it is empty.

- [x] **Step 1: Check existing boundary test**

Run: `npx vitest run tests/unit/module-boundaries.test.ts`
Expected: PASS

- [x] **Step 2: Create `src/orchestrator/service.ts` and move shared service functions**

Move execution, cancellation, approval decision, and run-by-ref resolution functions into `src/orchestrator/service.ts`. Re-export them from `src/cli/commands/run.ts`, `src/cli/commands/approvals.ts`, and `src/cli/commands/status.ts` for backward compatibility with CLI callers.

- [x] **Step 3: Update `src/server/routes.ts` and `src/tools/operator-catalog.ts` imports**

Change imports in `src/server/routes.ts` and `src/tools/operator-catalog.ts` to import from `../orchestrator/service.ts` instead of `../cli/`.

- [x] **Step 4: Update `tests/unit/module-boundaries.test.ts`**

Update `CLI_IMPORT_ALLOWLIST` to be an empty set (`new Set()`), asserting zero files outside `cli/` import from `cli/`.

- [x] **Step 5: Run tests to verify boundary enforcement**

Run: `npx vitest run tests/unit/module-boundaries.test.ts`
Expected: PASS with 0 allowlisted violations.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/service.ts src/cli/commands/run.ts src/cli/commands/approvals.ts src/cli/commands/status.ts src/server/routes.ts src/tools/operator-catalog.ts tests/unit/module-boundaries.test.ts
git commit -m "refactor(architecture): decouple server and tools from cli via orchestrator service"
```

---

### Task 4: Implement SQLite FTS5 Full-Text Search for Messages and Events

**Files:**
- Modify: `src/store/migrations.ts` (Add Migration 12)
- Modify: `src/store/store.ts`
- Create: `src/cli/commands/search.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/unit/fts-search.test.ts`
- Test: `tests/integration/cli-search.test.ts`

**Interfaces:**
- Migration 12 creates:
  - `chat_messages_fts` virtual table using `fts5(message_id UNINDEXED, session_id UNINDEXED, text, role UNINDEXED)`
  - Triggers on `chat_messages`: `ai_chat_messages_fts`, `ad_chat_messages_fts`, `au_chat_messages_fts`
  - `events_fts` virtual table using `fts5(event_id UNINDEXED, run_id UNINDEXED, event_type UNINDEXED, text)`
  - Triggers on `events`: `ai_events_fts`
- Store methods:
  ```typescript
  export interface SearchMessageResult {
    messageId: string
    sessionId: string
    role: string
    text: string
    snippet?: string
    createdAt: string
  }

  export interface SearchEventResult {
    eventId: string
    runId: string
    type: string
    seq: number
    snippet?: string
    createdAt: string
  }

  searchChatMessages(query: string, opts?: { limit?: number; sessionId?: string }): SearchMessageResult[]
  searchEvents(query: string, opts?: { limit?: number; runId?: string }): SearchEventResult[]
  ```
- CLI command:
  - `pluton search <query> [--session <id>] [--run <id>] [--limit <n>] [--json]`

- [x] **Step 1: Write failing unit test in `tests/unit/fts-search.test.ts`**

Test Migration 12 application, automatic index synchronization via triggers, sanitization of special FTS5 operators, and result ranking/snippets.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/fts-search.test.ts`
Expected: FAIL

- [x] **Step 3: Implement Migration 12 in `src/store/migrations.ts` and store search methods in `src/store/store.ts`**

Safely quote search terms or wrap in phrase query to prevent syntax errors on punctuation. Populate existing rows into FTS tables during migration.

- [x] **Step 4: Implement `pluton search` command in `src/cli/commands/search.ts` and register in `src/cli/main.ts`**

Support text formatting and `--json` output.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/fts-search.test.ts tests/integration/cli-search.test.ts`
Expected: PASS

- [x] **Step 6: Run full project verification**

Run: `npm run check && npm run build`
Expected: PASS with 0 errors across all test suites.

- [x] **Step 7: Commit**

```bash
git add src/store/migrations.ts src/store/store.ts src/cli/commands/search.ts src/cli/main.ts tests/unit/fts-search.test.ts tests/integration/cli-search.test.ts
git commit -m "feat(store): implement SQLite FTS5 search for chat messages and event log"
```
Expected: PASS with 0 TypeScript errors and all test files passing.

- [ ] **Step 7: Commit**

```bash
git add src/store/migrations.ts src/store/store.ts src/cli/commands/search.ts src/cli/main.ts tests/unit/fts-search.test.ts tests/integration/cli-search.test.ts
git commit -m "feat(store): implement SQLite FTS5 search for chat messages and event log"
```
