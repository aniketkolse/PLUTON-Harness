# Permission and execution-lifecycle hardening — source audit

Date: 2026-10-28
Status: implemented (see §4 for what shipped and §6 for the regression tests that pin it)

## 1. Scope and method

This audit covers the paths that decide whether an engine action is allowed and
whether a task/run may be called complete:

- tool authorization: `src/tools/bridge.ts`, `src/tools/catalog.ts`
- engine permission requests: `src/engines/approval.ts`,
  `src/engines/interactive-approval.ts`, `src/engines/acp/options.ts`,
  `src/engines/opencode/adapter.ts`
- orchestration and restart behavior: `src/orchestrator/supervisor.ts`,
  `src/orchestrator/task-graph.ts`, `src/domain/state.ts`
- verification and integration: `src/verify/runner.ts`,
  `src/verify/independent.ts`, `src/orchestrator/integrate.ts`
- durable schema: `src/store/migrations.ts`, `src/store/store.ts`

The audit compared those paths with the observable behavior asserted by the
existing suite. OpenCode was used only as a design reference for separating a
static engine policy from an operator approval channel; it is not a runtime
dependency of this design.

## 2. What is already enforced

| Concern | Current enforcement | Evidence |
|---|---|---|
| Tool catalog | Only catalogued tools are callable; unknown names are typed denials and audited | `src/tools/bridge.ts` `call()`, `src/tools/catalog.ts` |
| Tool authorization | Every call checks the caller Ship's persisted permission set server-side | `src/tools/bridge.ts`, `tests/unit/tool-bridge.test.ts` |
| Read scope | Task sessions resolve read roots from their own checkout; roots outside the project are discarded | `src/tools/bridge.ts` `resolveSessionReadRoots()` |
| Engine static policy | `autonomous-bounded` maps to `deny`; ask modes map to `interactive`; unknown modes throw | `src/engines/approval.ts` |
| Engine approval channel | Durable row + waiter, TTL expiry, cross-process poll, abort resolves `deny`, cap on concurrent asks | `src/engines/interactive-approval.ts`, `tests/unit/engine-interactive-approval.test.ts` |
| Run ownership | Fenced writes reject stale supervisors; duplicate task claims use compare-and-set | `src/orchestrator/supervisor.ts`, `tests/integration/supervisor-ownership.test.ts` |
| Unknown prompt outcomes | `unknown_outcome` is terminal and never replayed as success | `src/orchestrator/supervisor.ts` ~1090–1148 |
| Verification gate | Configured checks must pass; failed/pending/denied checks cannot produce `completed`; evidence is durable | `src/verify/runner.ts`, `tests/integration/verify.test.ts` |
| Integration gate | Protected-path approvals, overlap detection, conflict preservation, post-merge checks | `src/orchestrator/integrate.ts`, `tests/integration/cli-integrate.test.ts` |

## 3. Gaps found

### 3.1 Engine permission requests had no shared risk/boundary policy

`engineApprovalPolicy()` only chose `deny` or `interactive` from the Ship's
approval mode. Once a request reached the interactive channel, every request
became an operator question. Nothing classified destructive shell commands,
paths outside the task checkout, protected paths, or manager-session writes.
The scope snapshot also copied only tool kind/title/paths, so a command carried
inside the engine's `rawInput` was invisible to both the operator and any future
policy check.

Consequence: under an ask mode, an operator could be asked to approve a request
whose actual command/path was not represented on the approval card, and under
`autonomous-bounded` the adapter denied everything (safe, but without a durable
reason record).

### 3.2 Verification evidence was not scoped to the attempt

`applyTaskVerificationVerdict()` read **all** checks for a task. A passing check
from attempt 0 could satisfy the verdict for attempt 1 after a repair cycle,
because the historical rows stayed in the table. The repair cycle test relied on
this behavior.

### 3.3 Verification evidence had no tested revision or worktree fingerprint

Checks recorded command, cwd, workspace, exit code, duration and artifacts, but
not the git revision or dirty state they ran against. A check could pass, the
worker could then edit the checkout, and `integrate` would commit/merge a state
that no verification ever observed.

### 3.4 Integration had no drift guard

`integrateRun()` committed the current dirty checkout before merging. Nothing
compared that state with the state that produced the passing verification
evidence.

### 3.5 Existing scheduling/recovery coverage

Dependency validation, self-dependencies, cross-run dependencies, cycles,
cancellation and duplicate dispatch already have direct tests
(`tests/unit/task-graph.test.ts`, `tests/integration/supervisor-ownership.test.ts`,
`tests/integration/supervisor.test.ts`). This change adds no second scheduler;
it closes the two evidence gaps above and leaves the existing DAG untouched.

## 4. Chosen design

### 4.1 A pure policy module at the engine boundary

Add `src/policy/engine-permissions.ts`:

- input: approval mode, workspace policy, workdir, project root, optional
  protected-path patterns, manager flag, and the bounded request view;
- output: `allow | ask | deny`, a risk level, a short reason and bounded signals.

Rules, in order:

1. Unknown approval mode or `autonomous-bounded` → `deny`.
2. A coordinator/read-only Ship attempting a mutating action → `deny`.
3. Destructive shell commands (`rm -rf`, `git reset --hard`, `git clean -fdx`,
   `sudo`, disk/format tools, `curl … | sh`, …) → `deny`.
4. A path outside the project root or outside the session workdir → `deny`;
   `.git`/`.pluton` segments → `deny`.
5. A protected path or a sensitive file (`.env`, keys, credentials) → `ask`.
6. A recognized read-only tool kind with no command and only in-bound paths →
   `allow`.
7. Anything else, including an empty/unknown request → `ask`.

The module is pure so the same decision can be unit-tested without a store and
cannot depend on model-supplied text alone. `permissionScope()` is extended to
copy bounded `command`, `argv`, `path`, `cwd` and `rawInput` command fields, so
the policy and the operator card see the same signals.

The channel evaluates policy **before** minting a durable approval. `deny`
appends `approval.policy_denied` and returns `deny` without a row; `allow`
appends `approval.policy_allowed` and returns `allow` without a row; `ask`
keeps the existing durable approval lifecycle and adds the policy reason/risk to
the card scope.

The supervisor passes the real Ship mode, workspace policy, workdir, project
root, manager flag and protected-path patterns to every task and manager
channel. The tool bridge keeps its existing catalog + persisted-permission
allow/deny checks; shell and filesystem actions requested by the engine are not
tool-bridge calls, so the engine boundary is the correct place for this policy.

`autonomous-bounded` remains fail-closed at the adapter boundary (ADR-0018).
The channel-level check is defense in depth, not a replacement.

### 4.2 Attempt-scoped, revision-aware verification evidence

Migration v13 adds nullable/additive columns to `verification_checks`:

- `attempt INTEGER NOT NULL DEFAULT 0`
- `revision TEXT`
- `worktree_dirty INTEGER`
- `worktree_fingerprint TEXT`
- `post_revision TEXT`
- `post_worktree_fingerprint TEXT`

Old rows read as attempt 0 with null revision/fingerprint, preserving history.

`runVerificationChecks()` captures git evidence before and after **each** check
through `src/verify/evidence.ts`: HEAD, porcelain dirty flag, and a SHA-256 over
HEAD + a tree hash of tracked and untracked content. The tree hash is built with
a throwaway `GIT_INDEX_FILE` (`git add -A` + `git write-tree`), so the real
index and worktree are never modified. Non-git cwds record null evidence rather
than fabricating a revision.

`applyTaskVerificationVerdict()` uses only checks for `task.attempt`. It refuses
when there are none, and refuses inconsistent evidence (different revisions, a
check that changed HEAD, or a missing revision on a row that has one). Failed or
pending checks still fail the task exactly as before. The repair path already
increments `attempt`; each attempt must therefore produce fresh evidence.

`finalizeRunVerdict()` additionally refuses to close a run as `completed` when a
completed task's current-attempt evidence contains a non-passed check.

### 4.3 Integration drift guard

Before `integrateRun()` commits a task checkout, it compares the current
worktree fingerprint with the post-check fingerprint recorded for the task's
current attempt. If evidence exists and differs — or the current attempt has no
evidence while an earlier attempt does — the task is reported under
`blockedDrift`, an `integration.drift_detected` event is appended, and the
checkout is not committed or merged. Tasks with no verification evidence keep
the existing behavior (legacy runs and projects without verification
configured). Integration checkouts committed by an earlier invocation are
allowed to be re-integrated idempotently.

## 5. Migration and compatibility

- Migration v13 is additive; no table is rebuilt or dropped.
- `VerificationCheckRecord` gains optional/nullable fields. Existing constructors
  remain valid because the new store spec fields are optional and default to
  attempt 0 / null.
- Public CLI/HTTP verification responses gain no required fields; the evidence
  is surfaced through the durable store and events.
- `autonomous-bounded` semantics are unchanged: no engine grant is fabricated.

## 6. Test plan

New or extended tests:

- policy unit tests for allow/ask/deny, destructive commands, path escape,
  protected/sensitive paths, manager writes, spoofed read-only tool kinds and
  unknown modes;
- channel tests proving `deny` creates no approval row and `allow` creates no
  row, both with durable policy events, while `ask` keeps the existing row;
- store/migration tests for v13 and round-tripping the new fields;
- verification tests for attempt-scoped evidence, stale attempts, inconsistent
  revisions, post-check revision changes and git-captured fingerprints;
- integration test proving a checkout changed after verification is refused
  before commit/merge;
- updated repair-cycle test that records fresh evidence per attempt.

## 7. Deferred risks

- Fingerprints cover tracked and untracked changes visible to git; files hidden
  by `.gitignore` are intentionally not part of the evidence. A build artifact
  that is ignored can therefore change without invalidating verification.
- The fingerprinting step runs `git add -A` against a throwaway index. A
  repository whose content filters/hooks reject staging can yield no
  fingerprint; verification still records HEAD but integration fails closed on
  the missing post-check fingerprint.
- Non-git cwds cannot provide revision evidence. The gate records null and does
  not pretend otherwise; checkout-backed runs in a real repository do provide
  it.
- The policy is a conservative text/path classifier, not a shell parser. It
  denies known destructive shapes and asks on everything it does not recognize;
  it never upgrades an unknown command to `allow`.
- Protected-path approval remains an integration-time operator decision; the
  engine policy asks rather than silently allowing, and denies path escape.
- Live-engine integration tests require credentials and are not run here.

## 8. Verification commands

```bash
npm run typecheck
npm test -- --reporter=dot
npm run verify:docs   # when documentation claims change
npm run release:check # release-facing checks
```

### Final results (2026-10-28)

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test -- --reporter=dot` | 147 files / 1265 tests passed |
| `npm run build` | pass |
| `npm run verify:docs` | 72 files / 47 links, 0 broken |
| `npm run release:check -- --allow-dirty` | 15 passed, 0 failed, 1 not tested (POSIX 0600 on Windows), 0 owner blockers |

A plain `npm run release:check` fails only the working-tree-clean gate because
the branch intentionally carries uncommitted work (pre-existing user changes
plus this hardening). Nothing was committed, stashed or reverted. No live-agent
tests were run: they require network/model credentials and a configured
workspace.
