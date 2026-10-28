# Permission and lifecycle hardening — implementation plan

Source audit: [docs/audits/permission-lifecycle-hardening.md](../../audits/permission-lifecycle-hardening.md)
Spec: the audit's §4 (chosen design) and §6 (test plan).
Status: implemented; final verification results are in the delivery report
(`docs/audits/permission-lifecycle-hardening.md` §8 and the session report).

## Global constraints

- Do not replace the runtime, TUI, Ships, DAG or OpenCode integration.
- No new dependencies.
- Additive migration only; do not rewrite shipped migrations.
- `autonomous-bounded` stays fail-closed; no blanket engine grant.
- Never claim a test passed without reading its output.
- Existing uncommitted work belongs to the user; do not revert it.

## Task 1 — Engine permission policy — done

- Add `src/policy/engine-permissions.ts` with a pure `evaluateEnginePermission`.
- Extend `src/engines/acp/options.ts` `permissionScope` with bounded command,
  argv, path and cwd signals.
- Tests: `tests/unit/engine-permissions.test.ts`.

## Task 2 — Enforce policy in the approval channel — done

- `src/engines/interactive-approval.ts`: optional policy context; deny/allow
  settle without an approval row; durable policy events; ask keeps the existing
  durable flow and adds policy metadata.
- `src/orchestrator/supervisor.ts`: pass Ship mode, workspace policy, workdir,
  manager flag and protected paths to every channel.
- `src/orchestrator/service.ts`: pass configured protected paths.
- Tests: extend `tests/unit/engine-interactive-approval.test.ts` and update
  manager-ask fixtures to use an ask mode.

## Task 3 — Verification evidence schema — done

- Migration v13 adds attempt/revision/worktree fields and an index.
- `src/domain/models.ts`, `src/store/store.ts`: record fields and
  `listVerificationChecksByTaskAttempt`, `setVerificationCheckPostEvidence`.
- Update the hard-coded migration assertions.

## Task 4 — Revision-aware verification verdict — done

- Add `src/verify/evidence.ts`.
- `src/verify/runner.ts`: capture evidence before/after, store attempt, scope
  verdicts to the current attempt, refuse inconsistent/stale evidence, record
  evidence in the task result.
- `finalizeRunVerdict` refuses a completed run with failed current-attempt
  evidence.
- Tests: `tests/unit/verify-evidence.test.ts`, extended
  `tests/unit/verify-redispatch.test.ts`; updated repair-cycle test to produce
  fresh evidence per attempt.

## Task 5 — Integration drift guard — done

- `src/orchestrator/integrate.ts`: compare current checkout evidence with the
  verified post-check fingerprint before commit/merge; report drift and skip.
- Tests: `tests/integration/cli-integrate.test.ts` (matching, drifted and stale
  attempt cases).

## Task 6 — Docs and full verification — done

- Update `docs/MIGRATION.md` and `docs/SECURITY.md`.
- Run `npm run typecheck`, `npm test -- --reporter=dot`,
  `npm run verify:docs`, `npm run release:check`.
- Final report separates verified behavior from remaining work.

## Review focus

- Approval bypass attempts: spoofed `toolKind`, command hidden in raw input,
  path escape, manager write, autonomous mode.
- Stale/partial verification evidence: old attempt pass, mixed revisions,
  post-check HEAD change, missing fingerprints in non-git cwd.
- Compatibility: old rows, non-git projects, tasks completed without
  verification configured.
