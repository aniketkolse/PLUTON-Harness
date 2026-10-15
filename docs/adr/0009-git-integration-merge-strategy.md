# ADR-0009 — Git integration and merge strategy

- Status: Accepted (2026-10-16)

## Context

Workers edit isolated checkouts (ADR-0005). Integration must never reset/clean/force-checkout or
otherwise endanger the user's repository and uncommitted work, and must not silently merge to
the default branch.

## Decision

- **Never touch the user's working tree**: no `reset`, `clean`, `checkout --force`, no branch
  switching in the user's clone, no force operations. Pluton only reads from the user's
  repository (base commit, remote, default branch) and writes inside `.pluton/workspaces/`.
- **Task branches:** `pluton/<run-id>/<task-slug>` in per-task clones; base commit recorded at
  dispatch; all task changes are committed (or captured as a patch if the worker left dirty
  state, with a recorded note).
- **Integration checkout:** a Pluton-owned clone on branch `pluton/integration/<run-id>`; accepted
  task branches are applied with `git merge --no-ff` (fallback `cherry-pick` when histories
  diverge). Conflicts → stop, preserve both branches + conflict files + diagnostics, record a
  `needs_input`/follow-up task — never auto-resolve with force.
- **Protected paths:** configurable patterns (e.g. CI secrets, infra) whose modification in a
  task diff requires approval before that task may integrate.
- **Verification runs in the integration checkout** after integration, so checks execute against
  the code that would ship, not against a lone task branch.
- **Applying to the user's branch is explicitly out of MVP scope**; when added it will require an
  approval record (`require_approval_for_main_branch_integration: true` default).
- Diffs are captured as bounded artifacts (`git diff <base>..<head>`) and are inspectable via
  `pluton task diff <id>`.

## Consequences

- The user's checkout is never a merge target in the MVP; adoption is manual (pull the
  integration branch) with full evidence available.
- Reruns of verification are cheap and repeatable; artifacts are retained per run.

## Evidence

- Prompt §7; isolation rationale from ADR-0005; conflict-preservation policy tested in Phase 7.
