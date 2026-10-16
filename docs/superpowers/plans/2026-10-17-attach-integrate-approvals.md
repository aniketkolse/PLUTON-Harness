# Pluton `attach` / `integrate` / Approvals Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining product gaps named in `docs/delivery-report.md` §6: (1) `pluton attach` — interactive tmux attach into a Muse's container; (2) `pluton integrate` — integrate a run's verified task branches through a Pluton-owned integration checkout (never main); (3) the operator approvals inbox — `pluton approvals list/approve/deny` with expiry (timeout-to-denied) and real application of approved `muse.create` proposals.

**Architecture:** Three independent slices landing in order, each fully tested and committed before the next:
- **attach** adds a thin interactive seam (`src/terminal/attach.ts`) around the existing `TmuxTerminalManager` (always through the SandboxManager; never a host shell) plus a CLI command that resolves project store → muse → container/tmux names and spawns `docker exec -it <container> tmux attach-session`. `--json` resolves + ensures the session but never spawns.
- **integrate** adds two `GitWorkspaceManager` operations (`changedFiles`, `integrateBranch` — fetch + `merge --no-ff`, conflicts stop and are **preserved**, never aborted/reset) and a command that applies each verified task's branch into a reused Pluton-owned integration checkout on `pluton/integration/<run>`, gates protected-path diffs behind pending `integration.apply` approvals, then runs the project verification checks in the integration checkout.
- **approvals** adds expiring approval rows (`runtime.approval_timeout_minutes`, default 60, 0 = never) with a sweep that flips overdue pendings to `expired` (fail-closed: never approved), a project-scoped list, and `approve`/`deny` decisions that record events, un-park a live run only when its supervisor is still driving, and — for approved `muse.create` proposals — actually instantiate the specialist (pluton.yaml + store sync + container provisioning when a docker-mode run is live).

**Tech Stack:** TypeScript strict / ESM / Node ≥ 24; `node:sqlite` (WAL, multi-process safe); existing `Store`, `GitWorkspaceManager`, `TmuxTerminalManager`, `SandboxManager`/`ensureMuseContainer`, CLI `runCommand`/`emitOk` helpers; vitest. **No new runtime dependencies.**

**Spec:**
- `docs/adr/0005-checkout-terminal-lifecycle.md` (terminals = tmux sessions inside the Muse container; attach/detach never affects tasks), `docs/adr/0009-git-integration-merge-strategy.md` (integration checkout on `pluton/integration/<run>`; `merge --no-ff`, cherry-pick fallback documented; conflicts → stop, preserve, record; never touch the user's tree; main apply out of MVP), `docs/adr/0004-sandbox-container-model.md`, `docs/adr/0008-model-auth-secret-storage.md`
- `docs/delivery-report.md` §6 gaps 1–3 (this plan closes them) and §7 (NOT RUN honesty rules)
- Session directive 2026-10-17 (user calls already made): attach = interactive tmux attach; integrate = reviewable branch only, never main; approvals = list + apply/deny CLI + timeout-to-denied expiry (default 60 min)

**Design calls made in this plan (review these):**
1. `pluton attach --json` resolves the target and idempotently ensures the tmux session (so scripts and live verification can exercise everything except the interactive TTY), but never spawns. The real interactive attach leg cannot be proven in this harness (no TTY) → recorded NOT RUN with the argv-level evidence next to it.
2. Integrate targets only the run's `pluton/integration/<run>` branch. The main-branch flag (`git.require_approval_for_main_branch_integration`) is inert here by design (ADR-0009 MVP) and stays a documented follow-up.
3. Integration-check results are recorded in the command envelope, per-check events, and a JSON artifact; the `verification_checks` table stays task/run-gated (no schema churn for a post-run flow).
4. Expiry semantics: `expires_at` is computed at creation from `runtime.approval_timeout_minutes` (default 60, 0 = never). A sweep runs on every `pluton approvals` invocation (and before decisions) and flips overdue pendings to `expired` with `decided_by: 'pluton:timeout'`. `expired` is fail-closed exactly like `denied` — nothing may treat it as approved; deciding an expired approval is a `ConflictError`.
5. Approving a `muse.create` proposal instantiates it: `pluton.yaml` (via `createMuse`) + store sync + (when the approval belongs to a live docker-mode run) container provisioning through the shared per-Muse provisioning helper. Denying never instantiates anything.
6. Run un-parking rule: after the last pending approval of a run parked in `awaiting_approval` is decided, the run is resumed to `active` **only when no `run.finished` event was recorded for it** (the supervisor is still driving; `awaiting_approval → active` is state-machine-legal). When `run.finished` exists (supervisor already exited), the run stays parked and the recorded outcome is surfaced in the report and human output.

## Global Constraints

- TypeScript strict, ESM, Node ≥ 24; no new runtime dependencies; argv arrays only (no shell strings anywhere, including tmux/docker/git).
- Never touch the user's repository tree; checkouts live under `.pluton/workspaces/`. No `reset`, `clean`, `checkout --force`, `merge --abort`, or any force operation in Pluton-run git commands.
- Secrets never in argv, DB rows, events, logs, or artifacts (ADR-0008).
- `--json` (or `PLUTON_JSON=1`) → stdout is exactly one envelope (`{ok,data}` | `{ok,error}` via `runCommand`/`emitOk`); diagnostics on stderr; typed `PlutonError` subclasses with stable codes.
- Tests deterministic; live/Docker checks opt-in and either executed with recorded evidence or reported NOT RUN with exact commands.
- `npm run check` (typecheck + full suite) green before every commit; incremental conventional commits.

## Review Focus

Failure modes the tests must pin (each gets a test in the owning task):
1. `attach` on a `local-process` config → typed refusal naming `sandbox.kind: docker`; no tmux/docker call attempted.
2. `attach` when the container is missing → `TerminalUnavailableError` (`reason: 'container_missing'`) with a fix naming how containers come to exist; never a silent no-op.
3. Integrate conflict → the integration checkout keeps the mid-merge state (`MERGE_HEAD` present), both branches and the conflict list are recorded, the task loop stops, and a rerun refuses to merge over the unresolved merge — nothing is auto-resolved or reset.
4. Integrate protected paths → the task is not merged until an `approved` `integration.apply` approval exists for that task; rerunning after approval merges it.
5. Approvals: an overdue pending row is swept to `expired` (never approved), deciding it after expiry fails with `ConflictError`, and `expires_at` rides the config TTL (0 = never).
6. Approved `muse.create` instantiates the specialist exactly once: config + store + container (docker-mode live run); repeated decide on the same approval fails loudly, a `--request-id` retry never double-applies.

## File Structure

- Create: `src/terminal/attach.ts` — attach target argv builder + ensure/spawn orchestration + default stdio-inherit spawn.
- Create: `src/cli/commands/attach.ts` — `attachMuse` command flow (store resolution, defaults, terminal bookkeeping).
- Create: `src/workspace/protected-paths.ts` — protected-path pattern matcher.
- Create: `src/cli/commands/integrate.ts` — `integrateRun` flow (candidates, gate, merges, checks).
- Create: `src/cli/commands/muse-provision.ts` — per-Muse container provisioning helper + container path constants, shared by `run` and `approvals`.
- Create: `src/cli/commands/approvals.ts` — `listApprovals` + `decideApproval` (sweep, apply, un-park).
- Modify: `src/workspace/manager.ts` — `changedFiles`, `integrateBranch`.
- Modify: `src/store/store.ts` — approval `expiresAt` + `listApprovalsByProject` + `expirePendingApprovals` + `listEvents(runId)`.
- Modify: `src/domain/models.ts` — `ApprovalRecord.expiresAt` is already present; only check `NewApprovalSpec` (store) and no model change expected.
- Modify: `src/config/schema.ts` — `runtime.approval_timeout_minutes`.
- Modify: `src/tools/bridge.ts` — `ToolBridgeLimits.approvalTtlMinutes` + default + runtime mapping.
- Modify: `src/tools/handlers.ts` — `expires_at` on both `createApproval` call sites.
- Modify: `src/cli/commands/run.ts` — use `muse-provision.ts` (constants + provisioning body); no behavior change.
- Modify: `src/cli/main.ts` — real `attach`, `integrate`, and `approvals` commands; delete the planned-command stubs.
- Tests: `tests/unit/attach.test.ts` (new), `tests/unit/protected-paths.test.ts` (new), extend `tests/unit/workspace.test.ts`, `tests/unit/store.test.ts`, `tests/unit/config.test.ts`, `tests/unit/tool-bridge.test.ts`; `tests/integration/cli-attach.test.ts` (new), `tests/integration/cli-integrate.test.ts` (new), `tests/integration/cli-approvals.test.ts` (new).
- Docs: `docs/smoke-live-run.md` (live evidence section), `README.md`, `docs/ROADMAP.md`, `docs/delivery-report.md`, `docs/SECURITY.md` (only if it still lists approval expiry as missing).

---

## Phase 1 — `pluton attach` (interactive tmux into the Muse container)

### Task 1: Terminal attach core

**Files:**
- Create: `src/terminal/attach.ts`
- Test: `tests/unit/attach.test.ts` (new)

**Interfaces:**
- Consumes: `TerminalManager` (`src/terminal/types.ts:40-57` — `ensureSession`, `ensureWindow`), `assertSafeTmuxName` (`src/terminal/names.ts:25`), `TerminalUnavailableError` (`src/domain/errors.ts`).
- Produces:
  ```ts
  export interface AttachTarget { containerName: string; sessionName: string; windowName?: string }
  /** Exact-match tmux targets (`=name`, `=name:=window`), validated names. */
  export function buildAttachArgv(target: AttachTarget): string[]
  export type AttachSpawnFn = (argv: string[]) => Promise<number> // resolves the child exit code; throws when it cannot spawn
  /** Default spawn: node:child_process spawn with stdio 'inherit'. */
  export function inheritStdioSpawn(argv: string[]): Promise<number>
  export interface AttachOutcome {
    containerName: string
    sessionName: string
    windowName: string | null
    sessionCreated: boolean
    exitCode: number | null // null in plan mode (no spawn)
  }
  export async function attachToMuseTerminal(deps: {
    sandboxKind: 'docker' | 'local-process'
    manager: TerminalManager
    target: AttachTarget
    /** Absent = plan mode: ensure the session, build the argv, do not spawn. */
    spawnAttach?: AttachSpawnFn
  }): Promise<AttachOutcome>
  ```
- Behavior:
  - `buildAttachArgv` validates `sessionName`/`windowName` with `assertSafeTmuxName` and the container name against `/^[a-z0-9][a-z0-9_-]*$/`; returns `['docker','exec','-it', containerName, 'tmux', 'attach-session', '-t', target]` with `target = '=' + session` or `'=' + session + ':=' + window`.
  - `attachToMuseTerminal`: `sandboxKind === 'local-process'` → `ValidationError('pluton attach requires container-mode Muses (sandbox.kind: docker): tmux sessions live inside the Muse container, not on the host')`. Else `manager.ensureSession(...)`; when a `windowName` is given also `manager.ensureWindow(...)`. Then (plan mode) return with `exitCode: null`; otherwise `await spawnAttach(buildAttachArgv(target))` and return the code. A spawn rejection → `TerminalUnavailableError('could not start docker exec for attach: <cause>', { details: { reason: 'exec_failed' }, fix: 'is Docker Desktop running and `docker` on PATH? (`docker version`)' })`.
  - `inheritStdioSpawn`: `spawn(argv[0], argv.slice(1), { stdio: 'inherit' })`; `'error'` rejects; `'close'` resolves `code ?? 1`.

- [ ] **Step 1: Write the failing tests** — `tests/unit/attach.test.ts`:
  - `buildAttachArgv` exact argv for session-only and session+window; invalid session/window/container names throw `ValidationError`.
  - `attachToMuseTerminal` local-process → `ValidationError`, manager never touched.
  - fake `TerminalManager` (record calls; `ensureSession` → `{created: true}`): session-only ensures session, no window call, spawn receives exact argv, resolves 7 → `exitCode: 7`.
  - window mode calls `ensureWindow` after `ensureSession`; argv target `=s:=w`.
  - plan mode (no `spawnAttach`): `exitCode: null`, spawn never called, session still ensured.
  - spawn throwing → `TerminalUnavailableError` with `details.reason === 'exec_failed'` and a fix.
- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run tests/unit/attach.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `src/terminal/attach.ts`** exactly as specified above.
- [ ] **Step 4: Run tests to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `feat: add tmux attach core with an interactive spawn seam`

### Task 2: `pluton attach` command

**Files:**
- Create: `src/cli/commands/attach.ts`
- Modify: `src/cli/main.ts` (replace the `attach` half of the planned-commands loop, lines ~744-762)
- Test: `tests/integration/cli-attach.test.ts` (new)

**Interfaces:**
- Consumes: `bootstrapStore(ctx.loaded)` (`src/bootstrap.ts`), `resolveMuseByRef(store, ref)` (`src/cli/commands/mcp.ts`), `sandboxContainerName(projectId, museId)` (`src/sandbox/types.ts`), `tmuxSessionName(projectName, museId)` (`src/terminal/names.ts:46`), `createSandboxManager(config)` (`src/sandbox/factory.ts`), `TmuxTerminalManager` (`src/terminal/manager.ts:78`), Task 1's `attachToMuseTerminal`/`inheritStdioSpawn`.
- Produces:
  ```ts
  export interface AttachCommandOptions { museRef: string; windowName?: string }
  export interface AttachDeps {
    sandboxManager?: SandboxManager
    terminalManager?: TerminalManager
    spawnAttach?: AttachSpawnFn
  }
  export interface AttachCommandResult {
    museId: string
    containerName: string
    sessionName: string
    windowName: string | null
    sessionCreated: boolean
    argv: string[]
    attached: boolean
    exitCode: number | null
  }
  export async function attachMuse(ctx: ProjectContext, opts: AttachCommandOptions, deps: AttachDeps = {}): Promise<AttachCommandResult>
  ```
- Behavior (`attachMuse`): `bootstrapStore` → `resolveMuseByRef` (`NotFoundError` if unknown; `ValidationError` when the muse is disabled) → `target = { containerName: sandboxContainerName(projectId, muse.id), sessionName: tmuxSessionName(ctx.loaded.config.project.name, muse.id), ...(windowName ? { windowName } : {}) }` → `manager = deps.terminalManager ?? new TmuxTerminalManager(deps.sandboxManager ?? createSandboxManager(ctx.loaded.config))` → `attachToMuseTerminal({ sandboxKind: ctx.loaded.config.sandbox.kind, manager, target, ...(deps.spawnAttach ? { spawnAttach: deps.spawnAttach } : {}) })`. Catch `TerminalUnavailableError` with `details.reason === 'container_missing'` and rethrow with an attach-appropriate fix (`start a run first — per-Muse containers are created by `pluton run`; attach never creates containers`). On success upsert the terminal record: `store.upsertTerminal({ projectId, museId: muse.id, sandboxId: store.getSandboxForMuse(projectId, muse.id)?.id ?? null, tmuxSessionName: target.sessionName, state: 'present' })`. `store.close()` in `finally`.
- main.ts: remove `'attach'` from the planned-commands loop and register:
  ```ts
  program
    .command('attach')
    .description("attach this terminal to a Muse's tmux session inside its container (interactive; --json resolves the target without attaching)")
    .argument('<muse>', 'muse id, slug or unique id suffix')
    .option('--window <name>', 'attach to (or create) a named tmux window')
    .action(async (museArg: string, opts: { window?: string }, cmd: Command) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const result = await attachMuse(
          ctx,
          { museRef: museArg, ...(opts.window !== undefined ? { windowName: opts.window } : {}) },
          json ? {} : { spawnAttach: inheritStdioSpawn },
        )
        if (!json && result.exitCode !== null) process.exitCode = result.exitCode
        emitOk(io, json, humanLines, resultData)
      })
    })
  ```
  Human lines: `attached to <muse> → <container>:<session>` (+ `window <name>`), or in JSON/plan mode: `target <container>:<session>` + `argv: <joined>`. `resultData` = the result object with a `--json` note field `attached: false` in plan mode.

- [ ] **Step 1: Write the failing integration test** — `tests/integration/cli-attach.test.ts`, mirroring the project-fixture setup of `tests/integration/cli-run.test.ts` (tmp project via `pluton init`-equivalent seeds + `bootstrapStore`); a fake `SandboxManager` whose `exec` answers tmux argv (has-session → `{exitCode: 1, stderr: 'no server running on /tmp/tmux-…'}`, `new-session`/`set-option*`/`new-window` → `{exitCode: 0}`) so the real `TmuxTerminalManager` runs; pass it as `deps.sandboxManager`. Cases:
  - plan mode: `assert` exact `argv` (`docker exec -it pluton-…-dev tmux attach-session -t =pluton_…`), `attached: false`, session ensured (fake saw `new-session`), terminal row upserted (`store.listTerminals`-equivalent read or `getTerminalForMuse` if present).
  - spawn mode with a capturing fake `spawnAttach` resolving `7` → `exitCode: 7`, argv captured verbatim.
  - `--window ui` → `ensureWindow` invoked; argv target `=…:=ui`.
  - local-process config → `ValidationError` naming `sandbox.kind: docker`.
  - disabled muse → `ValidationError`; unknown ref → `NotFoundError`.
  - container missing (fake exec answering `no such container` for has-session) → `TerminalUnavailableError`, `details.reason === 'container_missing'`.
- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/integration/cli-attach.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/cli/commands/attach.ts` + main.ts registration** as specified.
- [ ] **Step 4: Run to verify it passes** — + `npm run check` → green.
- [ ] **Step 5: Commit** — `feat: wire pluton attach to Muse container tmux sessions`

---

## Phase 2 — `pluton integrate`

### Task 3: `GitWorkspaceManager.changedFiles` + `integrateBranch`

**Files:**
- Modify: `src/workspace/manager.ts`
- Test: extend `tests/unit/workspace.test.ts` (real-git harness already in that file — mirror its tmp-repo setup)

**Interfaces:**
- Produces:
  ```ts
  /** `git diff --name-only <from>..<to>` inside a Pluton-managed checkout. */
  async changedFiles(checkoutPath: string, from: string, to = 'HEAD'): Promise<string[]>

  export interface IntegrateBranchOptions {
    checkoutPath: string   // the integration checkout (Pluton-managed marker required)
    sourcePath: string     // the task checkout to fetch from
    sourceBranch: string   // e.g. pluton/<run>/<slug>
    message: string        // required non-empty merge message
  }
  export interface IntegrateBranchResult {
    status: 'merged' | 'already_integrated' | 'conflict' | 'failed'
    commit: string | null       // merged: merge commit; already_integrated: source head
    conflicts: string[]         // conflicted file list (unmerged paths)
    detail: string | null       // failure explanation (first stderr line, bounded)
  }
  async integrateBranch(opts: IntegrateBranchOptions): Promise<IntegrateBranchResult>
  ```
- Behavior:
  - Both paths: `assertInsideRoot` + marker check (`not a Pluton-managed checkout` `WorkspaceError` otherwise).
  - If `checkoutPath/.git/MERGE_HEAD` exists → `{ status: 'failed', detail: 'unresolved merge in progress ...' }` — Pluton never resets or aborts; the operator resolves or recreates.
  - `git fetch <sourcePath> <sourceBranch>` (exit ≠ 0 → `failed` with first stderr line).
  - `git merge-base --is-ancestor FETCH_HEAD HEAD` (exit 0) → `already_integrated`, `commit` = `rev-parse FETCH_HEAD`.
  - `git merge --no-ff -m <message> FETCH_HEAD`; exit 0 → `merged`, `commit` = `rev-parse HEAD`; exit ≠ 0 → conflicted paths via `git diff --name-only --diff-filter=U`; non-empty → `conflict` (state left in place); empty → `failed` with first stderr line. Never `merge --abort`, never `reset`.
- [ ] **Step 1: Write the failing tests** — extend `tests/unit/workspace.test.ts`: `changedFiles` lists committed files between two commits (and `[]` when identical); `integrateBranch` merges a diverged branch with `--no-ff` (merge commit has two parents); second call on the same branch → `already_integrated`; both-touch-same-line fixture → `conflict` with the file listed, `MERGE_HEAD` present afterwards, working tree untouched by any abort; running again over a conflicted checkout → `failed` with the unresolved-merge detail; unknown source branch → `failed`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/workspace.test.ts` → FAIL.
- [ ] **Step 3: Implement both methods** in `src/workspace/manager.ts` (reuse `this.git`, `readMarker`, `assertInsideRoot`).
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Commit** — `feat: add workspace merge primitives for integration`

### Task 4: Protected-path matcher

**Files:**
- Create: `src/workspace/protected-paths.ts`
- Test: `tests/unit/protected-paths.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  /** True when `file` (repo-relative, forward slashes) matches a protected-path pattern. */
  export function matchProtectedPath(pattern: string, file: string): boolean
  ```
- Semantics (documented in the module header): normalize `\` → `/` and strip leading `./`; empty pattern → false; trailing `/` → directory prefix; patterns with `*`/`**`/`?` → anchored glob regex (`**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`); otherwise exact match or directory prefix (`file.startsWith(pattern + '/')`).
- [ ] **Step 1: Write the failing tests** — exact file, directory prefix (`src/store` matches `src/store/store.ts` but not `src/storefront/x`), trailing slash, `**/*.env` matches `config/prod.env` but not `config/prod.env.local` (anchor), `secrets/**`, case sensitivity (patterns match verbatim), empty pattern.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/protected-paths.test.ts` → FAIL.
- [ ] **Step 3: Implement the matcher.**
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** — `feat: add protected-path pattern matching`

### Task 5: `pluton integrate` command

**Files:**
- Create: `src/cli/commands/integrate.ts`
- Modify: `src/cli/main.ts` (replace the remaining `integrate` stub; the planned-commands loop disappears entirely)
- Test: `tests/integration/cli-integrate.test.ts` (new)

**Interfaces:**
- Consumes: `bootstrapStore`, `runByRef`/`taskById` (`src/cli/commands/status.ts`), `GitWorkspaceManager.createCheckout/changedFiles/integrateBranch` (Task 3), `matchProtectedPath` (Task 4), `store.listTasks/listWorkspaces/getWorkspaceByTask/createWorkspace/updateWorkspace/createApproval/appendEvent/listApprovals`, `run` (`src/util/exec.ts`), `stateDir` (`src/config/load.ts`), `emitOk`.
- Produces:
  ```ts
  export interface IntegrateCommandOptions { runRef: string; taskRefs?: string[] }
  export interface IntegrateDeps { workspaceManager?: GitWorkspaceManager }
  export interface IntegrateReport {
    runId: string
    checkout: { id: string; path: string; branch: string }
    integrated: { taskId: string; title: string; status: 'merged' | 'already_integrated'; commit: string | null }[]
    conflicts: { taskId: string; files: string[] }[]
    blockedProtected: { taskId: string; files: string[]; approvalId: string }[]
    failed: { taskId: string; detail: string }[]
    stoppedAfterConflict: boolean
    checks: { name: string; status: 'passed' | 'failed'; exitCode: number | null; outputTail: string | null }[]
    artifactPath: string | null
  }
  export async function integrateRun(ctx: ProjectContext, opts: IntegrateCommandOptions, deps: IntegrateDeps = {}): Promise<IntegrateReport>
  ```
- Behavior:
  1. `bootstrapStore`; `run = runByRef(store, opts.runRef)`; `store.close()` in `finally`.
  2. Candidates: `opts.taskRefs` → `taskById` each (must be `completed`, else `ValidationError`); else all `completed` tasks ordered by `createdAt, id`. Zero candidates → `ValidationError('run <id> has no completed (verified) tasks; nothing to integrate')`.
  3. Integration checkout: reuse an `active` workspace row with `kind === 'integration-checkout'` and `runId`; else `GitWorkspaceManager.createCheckout({ repoPath: ctx.rootDir, kind: 'integration-checkout', runId: run.id, destName: 'integration-' + run.id })` + `store.createWorkspace({ projectId, runId, taskId: null, museId: null, kind: 'integration-checkout', path, branch, baseCommit })`.
  4. Per task: `ws = getWorkspaceByTask(task.id)` (null → `failed` entry, continue); `files = manager.changedFiles(ws.path, ws.baseCommit)`; protected gate: `matches = files.filter(f => config.git.protected_paths.some(p => matchProtectedPath(p, f)))`; when `matches.length > 0` and no `store.listApprovals(run.id)` row with `action === 'integration.apply'`, `status === 'approved'`, `scope.taskId === task.id` → `createApproval({ projectId, runId, taskId, requestedByMuseId: null, action: 'integration.apply', reason, scope: { taskId, runId, files: matches } })` + event `integration.blocked` + push `blockedProtected` + continue.
  5. `manager.integrateBranch({ checkoutPath: checkout.path, sourcePath: ws.path, sourceBranch: ws.branch, message: \`pluton: merge ${task.id} — ${task.title}\` })` → push to `integrated`/`conflicts`/`failed`; events `integration.task_merged` / `integration.already_integrated` / `integration.conflict` / `integration.failed` (payload carries `taskId`, `commit`, `files`, `detail` as applicable). On `conflict` → set `stoppedAfterConflict: true` and break the loop (subsequent tasks are NOT attempted; the report names them via `failed`-less omission — add them to a `notAttempted` list… **decision: add `notAttempted: { taskId: string }[]` to the report**).
  6. After the loop: when any `merged` and no `conflicts` → `store.updateWorkspace(checkout.id, { headCommit: 'rev-parse HEAD' of the checkout })`… compute via `manager` status if available; fallback: skip when no status method is exposed (do NOT add a new method for this). Then run `config.project.verification` checks in `checkout.path` with `run(check.command, { cwd: checkout.path, timeoutMs: 600_000, maxOutputBytes: 200_000 })`, `status = exitCode === 0 ? 'passed' : 'failed'`, `outputTail` = last ~2k chars. Emit event `integration.checks` with per-check statuses. Write the whole report JSON to `join(stateDir(ctx.rootDir), 'artifacts', \`integration-${run.id}.json\`)` → `artifactPath`.
  7. Return the report; `ok: true` even with conflicts/failed checks (verdict data, mirroring `verify`); only pre-flight problems throw.
- main.ts registration:
  ```ts
  program
    .command('integrate')
    .description('merge verified task branches into pluton/integration/<run> and run the project checks there (never main)')
    .requiredOption('--run <id>', 'run id (full id or unique suffix)')
    .option('--task <id...>', 'integrate only these tasks (must be completed)')
    .action(...) // runCommand(io, json, ...) → integrateRun → emitOk
  ```
  Human output: per task lines (+`, conflicts: file…`, `blocked: approval <id> created`, `not attempted after conflict`), checkout path/branch, check results, and a closing note: `review the branch at <path>; main is never touched (git log pluton/integration/<run>)`.
- [ ] **Step 1: Write the failing tests** — `tests/integration/cli-integrate.test.ts` (fixture: tmp project + real git repo seeded like the workspace/supervisor harness; seed a run + two `completed` tasks with Pluton-managed task checkouts created via `GitWorkspaceManager`, and per-task commits touching different files). Cases:
  - happy path: two tasks merged (merge commits present in the integration checkout, `git log` shows both files), checks from `project.verification` executed in the integration checkout (use `node -e "…"` checks), report statuses, artifact file written, events recorded.
  - conflict: both tasks touch the same line → second conflicts; `MERGE_HEAD` present afterwards; `stoppedAfterConflict: true`; a third task reported in `notAttempted`; rerun → refusal detail on the conflicted task (no merge attempted).
  - protected path: task touches a file matched by `git.protected_paths` → `blockedProtected` + pending approval row + event; no merge. Then `store.setApprovalStatus(id, 'approved', …)` + rerun → merged.
  - idempotent rerun: all `already_integrated`, no new commits.
  - `--task` filter: unnamed completed task not integrated; a `verifying` task ref → `ValidationError`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/cli-integrate.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/cli/commands/integrate.ts` + main.ts registration.**
- [ ] **Step 4: Run to verify they pass** — + `npm run check` → green.
- [ ] **Step 5: Commit** — `feat: add pluton integrate through the integration checkout`

---

## Phase 3 — Approvals inbox

### Task 6: Store — approval expiry, project listing, run events reader

**Files:**
- Modify: `src/store/store.ts`
- Test: extend `tests/unit/store.test.ts`

**Interfaces:**
- Modify: `NewApprovalSpec` — add `expiresAt?: string | null`; `createApproval` inserts `spec.expiresAt ?? null` (currently hardcoded `NULL`).
- Produces:
  ```ts
  listApprovalsByProject(projectId: string, opts?: { status?: ApprovalStatus; limit?: number }): ApprovalRecord[]
  // ORDER BY created_at DESC, id DESC; default limit 100
  expirePendingApprovals(nowIso: string, projectId?: string): ApprovalRecord[]
  // pending + expires_at <= nowIso → status 'expired', decided_by 'pluton:timeout', decided_at nowIso; returns the updated rows
  listEvents(runId: string, opts?: { type?: string; limit?: number }): EventRecord[]
  // WHERE run_id = ? [AND type = ?] ORDER BY seq DESC LIMIT (default 50); reuse rowToEvent
  ```
- [ ] **Step 1: Write the failing tests** — extend `tests/unit/store.test.ts`: createApproval stores the given `expiresAt` and defaults to null; `listApprovalsByProject` filters by status + limit + newest-first; `expirePendingApprovals` flips only overdue pendings (future `expires_at` and nulls stay pending), scopes by project when given, records `pluton:timeout`, is idempotent (second call returns `[]`); `listEvents` filters by type and orders newest-first.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/store.test.ts` → FAIL.
- [ ] **Step 3: Implement the store changes.**
- [ ] **Step 4: Run to verify they pass** → PASS.
- [ ] **Step 5: Commit** — `feat: add approval expiry and listing to the store`

### Task 7: Config TTL + bridge limits + handler wiring

**Files:**
- Modify: `src/config/schema.ts` (runtime section, ~line 43-62)
- Modify: `src/tools/bridge.ts` (`ToolBridgeLimits`, `DEFAULT_*`, `toolBridgeLimitsFromRuntime`)
- Modify: `src/tools/handlers.ts` (both `createApproval` call sites: `muse.propose_create` ~line 376 and `approval.request` ~line 428)
- Test: extend `tests/unit/config.test.ts`, `tests/unit/tool-bridge.test.ts`

**Interfaces:**
- `runtimeConfigSchema` += `approval_timeout_minutes: z.number().int().min(0).max(10_080).default(60)` — comment: `0 = approvals never expire`.
- `ToolBridgeLimits` += `approvalTtlMinutes: number`; `DEFAULT_APPROVAL_TTL_MINUTES = 60`; `toolBridgeLimitsFromRuntime` maps `runtime.approval_timeout_minutes`.
- `handlers.ts` helper:
  ```ts
  function approvalExpiresAt(now: string, ttlMinutes: number): string | null // ttl <= 0 → null, else now + ttl*60_000 ISO
  ```
  both `createApproval` calls gain `expiresAt: approvalExpiresAt(env.now(), env.limits.approvalTtlMinutes)`.
- [ ] **Step 1: Write the failing tests** — `tests/unit/config.test.ts`: default 60; explicit `0` and `10_080` accepted; `-1`/`10_081` rejected. `tests/unit/tool-bridge.test.ts`: limits include `approvalTtlMinutes` from runtime (60 default, passthrough of custom); the existing handler harness asserts a created `approval.request` row carries `expires_at ≈ now + 60m` and, with `approvalTtlMinutes: 0`, `null`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/config.test.ts tests/unit/tool-bridge.test.ts` → FAIL.
- [ ] **Step 3: Implement the three edits.**
- [ ] **Step 4: Run to verify they pass** — + `npm run check` (limits touch the run path) → green.
- [ ] **Step 5: Commit** — `feat: give approvals an operator-configurable expiry`

### Task 8: Shared per-Muse container provisioning helper

**Files:**
- Create: `src/cli/commands/muse-provision.ts`
- Modify: `src/cli/commands/run.ts` (constants + `prepareContainerMode` body, lines ~86-95/157-230)
- Proof: existing container-mode tests in `tests/integration/cli-run.test.ts` must stay green with zero edits.

**Interfaces:**
- Produces (moved verbatim from run.ts where possible):
  ```ts
  export const CONTAINER_WORKSPACES_PATH = '/pluton/workspaces'
  export const CONTAINER_ENGINE_HOME_PATH = '/pluton/engine-home'
  export const CONTAINER_PROJECT_PATH = '/pluton/project'
  export interface ProvisionMuseContainerOptions {
    manager: SandboxManager
    store: Store
    projectId: string
    muse: MuseRecord
    image: string
    imageId?: string
    limits: SandboxLimits
    network: 'restricted' | 'none' | 'open'
    rootDir: string
    workspacesRoot: string
  }
  export async function provisionMuseContainer(opts: ProvisionMuseContainerOptions): Promise<{ containerName: string; created: boolean }>
  ```
- `provisionMuseContainer` builds the mounts exactly as `prepareContainerMode` does today (workspaces root → `CONTAINER_WORKSPACES_PATH`; `muse.engineHome` → `CONTAINER_ENGINE_HOME_PATH`; project root → `CONTAINER_PROJECT_PATH` read-only for every policy except `isolated-task-checkout`) and calls `ensureMuseContainer(manager, store, { projectId, museId: muse.id, image, imageId, limits, network, mounts })`.
- `run.ts` imports the constants + helper, deletes the local copies, and its per-muse loop calls `provisionMuseContainer` per muse (probe/readiness stays once per run in `prepareContainerMode`). No behavioral change.
- [ ] **Step 1:** Run the existing green proof first — `npx vitest run tests/integration/cli-run.test.ts` → PASS (baseline).
- [ ] **Step 2:** Extract the constants + the provisioning body into `muse-provision.ts`; refactor `prepareContainerMode` to call it.
- [ ] **Step 3:** Run `npx vitest run tests/integration/cli-run.test.ts tests/unit/muse-containers.test.ts` + `npm run check` → green with no test changes.
- [ ] **Step 4: Commit** — `refactor: share per-Muse container provisioning between run and approvals`

### Task 9: `pluton approvals` — list, decide, apply

**Files:**
- Create: `src/cli/commands/approvals.ts`
- Modify: `src/cli/main.ts` (register the command group; remove the planned-commands loop if Task 5 left remnants — it should not)
- Test: `tests/integration/cli-approvals.test.ts` (new)

**Interfaces:**
- Consumes: Task 6 store methods, Task 7 `approvalTtlMinutes`, Task 8 `provisionMuseContainer`, `createMuse` (`src/cli/commands/muse.ts:127`), `loadConfig` (`src/config/load.ts`), `museSpecs` (`src/bootstrap.ts:43`), `WorkerImageManager`/`dispatchReadiness`/`DEFAULT_WORKER_IMAGE_TAG` (`src/sandbox/image.ts`), `ensureMuseContainer` spec rules (`src/sandbox/muse-containers.ts`), `store.admitRequest` (`src/store/store.ts:973`, kind `'approval.decide'`).
- Produces:
  ```ts
  export interface ApprovalListOptions { all?: boolean; runRef?: string }
  export interface ApprovalListView {
    approvals: { id: string; action: string; status: ApprovalStatus; runId: string | null; taskId: string | null
      requestedByMuseId: string | null; reason: string; scope: JsonValue; createdAt: string; expiresAt: string | null
      decidedAt: string | null; decidedBy: string | null; ageMinutes: number; expiresInMinutes: number | null }[]
    counts: Record<ApprovalStatus, number>
  }
  export async function listApprovals(ctx: ProjectContext, opts: ApprovalListOptions): Promise<ApprovalListView>

  export interface ApprovalDecideOptions { approvalRef: string; decision: 'approve' | 'deny'; requestId?: string }
  export interface ApprovalDecideDeps { sandboxManager?: SandboxManager; workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe> }
  export interface ApprovalDecideReport {
    approval: { id: string; action: string; status: 'approved' | 'denied'; decidedBy: string; decidedAt: string }
    applied: { museId: string; configPath: string; container: { containerName: string; created: boolean } | null
      containerWarning: string | null } | null
    run: { id: string; stateBefore: RunState; stateAfter: RunState; resumed: boolean; parked: boolean; recordedOutcome: string | null } | null
    expiredSwept: string[]
  }
  export async function decideApproval(ctx: ProjectContext, opts: ApprovalDecideOptions, deps: ApprovalDecideDeps = {}): Promise<ApprovalDecideReport>
  ```
- `listApprovals` behavior: `bootstrapStore` → sweep (`expirePendingApprovals(now, projectId)`; append `approval.expired` event per swept row) → optional `runRef` filter via `runByRef` → rows = `listApprovalsByProject(projectId, opts.all ? {} : { status: 'pending' })` → counts across the project (single query with `{}` limit 1000) → compute `ageMinutes`/`expiresInMinutes` from `now`. `store.close()` in `finally`. Human lines: `<id>  <status>  <action>  by <muse|operator>  age <n>m  [expires in <n>m | never]  — <reason>`.
- `decideApproval` behavior:
  1. `bootstrapStore`; `expiredSwept` from the project sweep (events appended).
  2. Resolve `approvalRef`: exact id, else unique suffix among `listApprovalsByProject(projectId, {})` → `NotFoundError` / ambiguous `ConflictError`.
  3. Status must be `pending` → else `ConflictError('approval <id> is already <status>')` (expired included).
  4. `opts.requestId` → `store.admitRequest({ requestId, targetKind: 'approval.decide', payload: { approvalId, decision } })`; duplicate with identical payload → return the report rebuilt from current rows (no mutation); conflict → `ConflictError` (existing `admitRequest` semantics).
  5. `setApprovalStatus(id, decision === 'approve' ? 'approved' : 'denied', { decidedBy: 'operator' })` (verify exact signature at implementation; `decidedBy` is the existing param name in the store API) + `appendEvent('approval.decided', { approvalId, action, status })`.
  6. Approved + `action === 'muse.create'` → apply: validate `scope = { museId, displayName, role, engine, model }` (malformed → `ValidationError`; note: the approval is already decided — apply failures must still be loud); `createMuse(ctx, { id, displayName, role, engine, model })`; `const reloaded = loadConfig(ctx.rootDir)`; `store.syncMuses(projectId, museSpecs(reloaded))`; `mkdirSync(engineHomesDir(ctx.rootDir) + …muse id, { recursive: true })` only if `museSpecs` does not already mkdir (check at implementation; skip otherwise); event `muse.applied_from_proposal`. Container: when `approval.runId !== null` and `config.sandbox.kind === 'docker'` and the run state ∈ `{active, awaiting_approval, awaiting_input}` → resolve image tag (`config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG`), probe readiness (`WorkerImageManager` + `dispatchReadiness` as `prepareContainerMode` does; hook `deps.workerImageProbe`), `provisionMuseContainer(...)` with limits/network from config as run.ts does. `SandboxUnavailableError` during provisioning → `container: null` + `containerWarning` (never fail the decision; the next `pluton run` provisions enabled config muses anyway).
  7. Un-park: when `approval.runId !== null` → `run = store.getRun(...)`; if `run.state === 'awaiting_approval'` and no pending approvals remain for the run: `store.listEvents(run.id, { type: 'run.finished', limit: 1 })` — empty → `setRunState(run.id, 'active')` + event `run.resumed_after_approval`; non-empty → `parked: true`, `recordedOutcome` = that event's `payload.outcome` (string-coerced, may be null).
  8. Report + `store.close()` in `finally`.
- main.ts: `const approvals = program.command('approvals').description('operator approval inbox: list, approve, deny (expiring approvals are fail-closed)')`; subcommands: `list` (`--all`, `--run <id>`), `approve <approval>` / `deny <approval>` (each `--request-id <id>`); all through `runCommand(io, json, …)` + `emitOk`.
- [ ] **Step 1: Write the failing integration tests** — `tests/integration/cli-approvals.test.ts` (fixture: tmp project + bootstrapped store; seed approvals/run rows directly through `Store`):
  - list: pending-only by default, `--all` includes decided, counts correct; sweep turns an overdue seeded pending into `expired` + `approval.expired` event and it disappears from the default list.
  - approve/deny: status + `decidedBy: 'operator'` + `approval.decided` event; second decide → `ConflictError`; deciding an expired row → `ConflictError`.
  - approval on an `approval.request`-style action (no apply logic) decides without instantiating anything.
  - `muse.create` approve (host mode, no live run): pluton.yaml gains the muse (assert via `loadConfig`), store row enabled, event recorded, `applied.container === null`, no warning; deny path leaves config untouched.
  - `muse.create` approve in docker mode with a seeded live run (`active`) → `provisionMuseContainer` called (fake sandbox manager + fake `workerImageProbe` via deps; assert `ensureMuseContainer`'s containerName/created in the report and the sandboxes row).
  - un-park: run `awaiting_approval` + two pendings → deciding one keeps `awaiting_approval` after… (assert `parked: false`, `resumed: false`), deciding the last → `active` + `run.resumed_after_approval`; with a seeded `run.finished` event → stays `awaiting_approval`, `parked: true`, `recordedOutcome` surfaced.
  - `--request-id` retry: identical duplicate returns the same report state without a second event; different decision under the same id → `ConflictError`.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/integration/cli-approvals.test.ts` → FAIL.
- [ ] **Step 3: Implement `src/cli/commands/approvals.ts` + main.ts registration.**
- [ ] **Step 4: Run to verify they pass** — + `npm run check` → green (full suite).
- [ ] **Step 5: Commit** — `feat: add the approvals inbox with apply, deny and expiry`

---

## Phase 4 — Live evidence, docs, cleanup

### Task 10: Live verification on the running Docker setup + docs

**Files:**
- Modify: `docs/smoke-live-run.md` (new section: attach/integrate/approvals live results), `README.md`, `docs/ROADMAP.md`, `docs/delivery-report.md` (§2 counts, §5 rows, §6 gaps 1–3 + 5, §7 attach note), `docs/SECURITY.md` (only if approval expiry is still listed as missing)
- Scratch helpers stay under `.pluton-tmp/` (never committed).

- [ ] **Step 1: Attach live (argv-level; interactive leg NOT RUN).** With the smoke containers still up (`pluton-project-mvbcakle23bcab26-{manager,worker}`) run in `.pluton-tmp/smoke-docker`: `node bin/pluton.js attach manager --json` → capture the envelope (container/session/argv/session ensured); prove the session inside the container with `docker exec pluton-project-mvbcakle23bcab26-manager tmux has-session -t =<sessionName>`. Record: interactive `docker exec -it … attach-session` NOT RUN (no real TTY in this harness) — argv + session-ensure proven live.
- [ ] **Step 2: Integrate live.** In `.pluton-tmp/smoke-docker`: `node bin/pluton.js integrate --run run_mvbdxegw64ba23de --json` → the verified worker task merges into `pluton/integration/run_mvbdxegw64ba23de`; confirm with `git log --oneline` inside the integration checkout and `git branch`; record the envelope (status `merged`, checks run in the integration checkout). Re-run once to show `already_integrated`.
- [ ] **Step 3: Approvals live.** Seed one pending `approval.request`-style approval (with `expires_at` +30 min) via a scratch `.mjs` using `Store` against the smoke project DB → `node bin/pluton.js approvals list --json` (visible, pending) → `node bin/pluton.js approvals approve <id> --json` (status approved, event recorded) → list again (gone from pending). Then a second seed with `expires_at` in the past → `list` shows it swept to `expired`; `approve` on it → `ConflictError` envelope. Never print the engine key.
- [ ] **Step 4: Docs.** Update all four/five docs with the delivered features + the live evidence above + fresh test counts (`npm run check` output). Rewrite delivery-report §6 gaps 1–3 (attach/integrate/approvals now delivered — with the honest interactive-attach caveat and the Linux-host container caveat), §5 table rows, §7 (attach interactive leg as the only NOT RUN item this slice).
- [ ] **Step 5: Cleanup.** Stop the 9router gateway job (`sh_1463daef4001sSEJGbc6XnLf3j`), kill the leftover pre-fix manager ACP PIDs (10664, 7316 — verify identity before killing), `docker rm -f pluton-project-mvbcakle23bcab26-manager pluton-project-mvbcakle23bcab26-worker`; leave the user's `distracted_lewin` container alone.
- [ ] **Step 6: Commit** — `docs: record the attach, integrate and approvals slices`

---

## Self-Review Notes

- **Spec coverage:** attach (Tasks 1–2), integrate + protected gate + conflict preservation (Tasks 3–5), approvals list/apply/deny/expiry + specialist instantiation (Tasks 6–9), live evidence + honest NOT RUN bookkeeping (Task 10). ADR-0005 attach/detach-never-fails-a-task holds: attach touches only terminals rows. ADR-0009: merge `--no-ff`, conflicts stop/preserve/record, user tree untouched, main apply out of scope.
- **Type consistency:** `AttachSpawnFn` (Task 1) is reused verbatim in `AttachDeps` (Task 2); `IntegrateBranchResult` (Task 3) is the only merge-outcome vocabulary in `IntegrateReport` (Task 5); `ApprovalStatus` comes from `domain/models.ts`; `ToolBridgeLimits.approvalTtlMinutes` (Task 7) is the only TTL source for handlers, while the sweep (Task 6) consumes only stored `expires_at`.
- **Known risks / follow-ups:** interactive attach cannot be proven in this harness (recorded); `integration.apply` approvals are created by `integrate` but nothing auto-continues the integrate command after approval (rerun is the documented flow); Linux-host mount ownership stays open (`SECURITY.md` §8.9); the un-park rule deliberately never re-drives an exited supervisor (`parked` + recorded outcome surfaced instead).
