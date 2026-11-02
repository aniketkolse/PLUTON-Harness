# PLUTON 4.1 Phase 4 Design Specification: Persistent Build Mode & Dynamic Planning Refinement

- **Date:** 2026-11-03
- **Status:** Proposed (operator-authorized for execution)
- **Target:** `PLUTON-Harness` on `main`

---

## 1. Intent & The Why

Phase 3 gave Pluton a registry, project-scoped server contexts, and concurrent multi-project builds. Every Build, however, is still a fresh run: the SPA asks for the same confirmation every time, no durable record anchors successive builds to one workspace, the project name cannot be set by the operator, and a manager plan starts from nothing even when the project already has completed work.

Phase 4 makes Build a **persistent project session**. The first Build establishes the project workspace and identity; every later Build continues that same session without a redundant project-creation prompt. The manager receives the durable lineage of prior builds and is required to **refine the existing plan** — inspect what already exists, reuse completed work, and create tasks only for the remaining delta. Sensitive-operation approvals inside a run are untouched.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Persistent project session:** one durable `project_sessions` row per project, holding the canonical workspace root, build count (plan revision), last goal, and the newest build anchor. It survives application restarts.
- **Repeated Build reuse:** a second and subsequent Build in a known project reuses the session workspace and dispatches without the project-creation confirmation dialog.
- **Operator-defined project name:** the first Build dialog accepts a display name. A dedicated rename operation updates `pluton.yaml`, SQLite `projects.name`, and `~/.pluton/projects.json` while preserving the filesystem path.
- **Dynamic planning refinement:** each new run in a session records its lineage. The manager prompt receives a bounded summary of prior builds (goal, state, outcome, task histogram, unfinished task titles) and an explicit instruction to refine rather than duplicate.
- **CLI parity:** `pluton project rename <project> <new-name>` performs the same rename, and CLI-created runs also join the persistent session.
- **Auditability:** a `run.project_session_attached` event records the session, build number, and prior run ids.

### Non-Goals
- No new plan-authoring authority: durable `runs`/`tasks` remain the plan record; Phase 4 does not introduce a parallel plan database.
- No change to task-checkout isolation or the supervisor fencing model.
- No change to the model/provider layer.
- No Bypass of approval gates: removing the repeat Build dialog does not auto-approve tools, shell commands, or file writes.
- No deletion or migration of existing runs; historical runs stay unanchored (`project_session_id` NULL) and remain readable.

### Anti-Goals
- **No name-only identity:** the session and all APIs key on the canonical project ID; the display name is metadata.
- **No path mutation on rename:** renaming never moves, copies, or recreates the project directory.
- **No silent workspace drift:** subsequent builds must not silently move to a new workspace because a caller omitted a parameter.
- **No unbounded prompt growth:** lineage context is capped and truncated with an explicit marker.

---

## 3. Architecture & Key Systems

### 3.1 Project Session Record (`project_sessions`)

A new schema version adds:

```sql
CREATE TABLE project_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  workspace_root TEXT NOT NULL,
  active_run_id TEXT,
  build_count INTEGER NOT NULL DEFAULT 0,
  last_goal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE runs ADD COLUMN project_session_id TEXT;
CREATE INDEX idx_runs_project_session ON runs(project_session_id, created_at);
```

- `id` is generated with the existing `newId('psess')` helper.
- `project_id` is `UNIQUE`: one persistent Build session per project.
- `workspace_root` is the canonical first-build workspace; later builds reuse it.
- `build_count` is the revision number shown to the operator and fed to the manager.
- `active_run_id` is an informational anchor for the newest build; the authoritative active run remains the newest non-terminal run.
- `runs.project_session_id` links every new run to the session; legacy runs remain NULL.

### 3.2 Store API

```ts
ensureProjectSession(projectId: string, workspaceRoot: string): ProjectSessionRecord
getProjectSession(projectId: string): ProjectSessionRecord | null
getProjectSessionById(id: string): ProjectSessionRecord | null
recordProjectBuild(projectId: string, spec: { runId: string; goal: string }): ProjectSessionRecord
setProjectSessionActiveRun(projectId: string, runId: string | null): void
clearProjectSessionActiveRunForRun(runId: string): void
listProjectSessionRuns(sessionId: string, limit: number, excludeRunId?: string): RunRecord[]
renameProject(projectId: string, name: string): ProjectRecord
```

`createRun` accepts an optional `projectSessionId`.

### 3.3 Build Creation (API and CLI)

Both `POST /api/runs` and `startRunInBackground`/`runRun` follow the same sequence:

1. Resolve the target project and workspace.
2. `ensureProjectSession(projectId, workspaceRoot)` — returns the existing session and its workspace when present; the existing workspace wins over an omitted parameter.
3. Create the run with `projectSessionId`.
4. When the run is not a duplicate receipt, `recordProjectBuild(...)` increments `build_count`, stores `last_goal`, and sets `active_run_id`.
5. Append `run.project_session_attached` with `{ projectSessionId, buildCount, priorRunIds }`.

The API additionally accepts an optional `projectName`; when present the rename operation runs before the run is created.

### 3.4 Dynamic Planning Refinement

`buildManagerPrompt` gains an optional refinement section. The supervisor builds it only when `run.projectSessionId` is set:

```
Persistent Build session (build 3, workspace <path>).
Previous builds in this project:
- run_x [completed] goal: ... | tasks: 4 completed, 0 failed, 0 unsettled
  outcome: <final summary, bounded>
  unfinished: <titles of non-terminal tasks from that run, bounded>
Instruction: This Build continues an existing project. Inspect the workspace and the durable
task records first; reuse completed work and create tasks only for the remaining or new delta.
Do not recreate or re-run work that is already completed.
```

The section is produced by an exported pure function `buildBuildLineageSection(...)` so it can be unit-tested without an engine. The full section is capped (default 2,500 chars) and ends with an explicit truncation marker when clipped.

### 3.5 Rename

`renameProject` composes three writes:

1. `pluton.yaml`: `project.name` is set via the YAML document API and the full config is validated before writing (comments preserved).
2. SQLite: `UPDATE projects SET name = ?, updated_at = ?`.
3. Registry: the `projects.json` entry name and slug are updated; the root path is untouched.

The HTTP endpoint is `PATCH /api/projects/:id` with `{ "name": "..." }`. The pool refreshes its cached `name` and `loaded.config.project.name`. Failure at any step leaves the previous name intact because config validation happens before any write.

---

## 4. User Interface Specifications

### 4.1 First Build Confirmation (SPA)

The existing `#buildConfirm` panel becomes the **first-build** panel only:

- Adds an editable **Project name** input (`#buildConfirmProjectName`).
- Copy states that later builds continue this workspace without asking again.
- `Start build` sends `projectName` with `POST /api/runs`.
- When `state.workspace.projectSession.buildCount > 0`, `submitPrompt()` dispatches `startBuild()` directly with no panel.

### 4.2 Settings Project Identity

A new card above the workspace root card:

- `#projectNameInput` (text) and `#btnSaveProjectName` ("Rename").
- `#projectIdentityMeta` shows `Build #N · <session workspace>`.
- Saving calls `PATCH /api/projects/:id`, then refreshes the workspace summary and the header selector.

### 4.3 CLI

```bash
pluton project rename <id|name|prefix> "New display name" [--json]
```

---

## 5. Persistence, Failure, and Security Invariants

- The session row and run column are additive; existing databases migrate forward only.
- Rename never changes `projects.root_path` or any workspace path.
- A failed `pluton.yaml` validation aborts before SQLite/registry mutation.
- Lineage prompts contain only durable state already visible to the operator; secrets pass through the existing redaction gate at render time and are not added to prompts.
- Removing the repeat Build panel does **not** remove tool approvals; the supervisor approval channel is unchanged.
- Intra-project workspace busy protection from Phase 3 still applies; a second concurrent start on the same workspace returns `409 Conflict`.

---

## 6. Test Strategy

1. **Store unit tests** (`tests/unit/project-session-store.test.ts`): session idempotence, build counter, active-run bookkeeping, rename preserving root, run linkage, persistence across a database reopen.
2. **Lineage unit tests** (`tests/unit/build-lineage.test.ts`): section content, ordering, bounded length/truncation marker, and inclusion in `buildManagerPrompt`.
3. **Server integration** (`tests/integration/persistent-build.test.ts`): first Build sets name + session; second Build reuses session/workspace and increments; restart preserves it; rename endpoint; CLI-created run linkage is covered by store tests.
4. **SPA integration** (`tests/integration/spa-build-session.test.ts`): required DOM ids, client logic (`shouldConfirmBuild`, `projectName`, `projectSession`), and asset verification.
5. **CLI integration** (`tests/integration/project-cli.test.ts`): `project rename` updates config, SQLite, and registry without changing the path.

---

## 7. Decisions Left to the Builder

- Exact visual placement of the first-build name input (reuse `build-confirm-row` styles).
- Whether the registry slug follows the new name (it does; `slugify(newName)` with ID fallback).
- Whether the session workspace can be overridden per run (explicit `workspaceRoot` is honored for that run but does not mutate the persistent session).
