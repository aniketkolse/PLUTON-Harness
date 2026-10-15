# ADR-0005 — Per-Muse vs per-task checkout and terminal lifecycle

- Status: **Proposed** (2026-10-16) — finalized in Phase 5 after reference-repo findings and
  workspace tests on this host

## Context

Independent workers must never share one editable working tree. A Muse container needs a
writable mount of exactly one task's checkout. Git worktrees keep `.git` as a *file* pointing at
the parent repository's `.git` directory — inside a container that shares only the worktree
directory this indirection is either broken or forces mounting more host state than intended.
Terminal sessions (tmux) must survive user attach/detach but must not be confused with the
managed engine process.

## Decision (proposed)

- **Checkout granularity: per task.** Each task gets a self-contained clone under
  `.pluton/workspaces/<project>/<task-id>/` on branch `pluton/<run>/<task-slug>`, created with
  `git clone --local` (hardlinked object store, independent afterwards). The clone is what gets
  bind-mounted into the Muse container — no `.git` indirection across the mount.
- **Container granularity: per Muse** (long-lived; see ADR-0004).
- **tmux granularity:** one tmux session per Muse (`pluton_<project>_<muse>` after strict
  sanitization + uniqueness checks); one window per task (`task-<short-id>`) created at dispatch,
  a default `shell` window always present. Attach/detach and window closure never affect task
  lifecycle; the managed engine process is supervised separately (never inside the user's tmux
  pane).
- **Cleanup:** only Pluton-owned directories (ownership marker file + registry row) are removed,
  and only after verifying no process/sandbox references them; retention policy configurable;
  cleanup failures recorded, never forced.
- **Fallback:** if `--local` hardlinks are unsupported on the filesystem, fall back to a full
  local clone (correct, just slower) — never to shared worktrees.

## Consequences

- Disk usage grows per task; mitigated by hardlinks and retention policy.
- `pluton task diff <id>` reads from the task clone; integration happens later in a separate
  integration checkout (ADR-0009).

## Alternatives considered

- **Git worktrees mounted into containers** — rejected for the MVP mount-semantics risk stated
  above; may be revisited with a tested volume strategy.
- **One checkout per Muse** — rejected: overlapping tasks would need serialization beyond even
  the MVP's per-Muse serialization rule, and task diffs would interleave.

## Evidence

- Pending: Phase 1 reverse-engineering reports; Phase 5 workspace tests (`git clone --local`
  behavior on this host, container mount visibility tests if Docker available).
