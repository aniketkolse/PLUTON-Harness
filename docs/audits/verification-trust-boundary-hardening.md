# Verification trust-boundary hardening — source audit

Date: 2026-10-28
Status: implemented; full Windows suite green; live Linux (WSL2) kernel validation complete (see §6)
Scope: the confirmed C1–C6 and H1–H9 findings from the adversarial review, plus R1–R3 found by live Linux validation

This document records the security remediation that followed the permission and
lifecycle audit in [`permission-lifecycle-hardening.md`](permission-lifecycle-hardening.md).
It is deliberately explicit about what is enforced, what was tested, and what
remains unverified on this host.

## 1. Confirmed findings and controls

| ID | Confirmed defect | Implemented control | Regression evidence |
|---|---|---|---|
| C1 | Verification and post-integration checks ran on the host with inherited environment | Dedicated executor (`src/verify/executor.ts`): disposable snapshot, explicit environment allowlist, `network: none`, Linux Landlock plus namespaces, bounded output/lifetime; non-Linux and unprovable-Linux hosts fail closed with no host fallback | `tests/unit/verification-executor.test.ts` |
| C2 | Evidence/commit/integration trusted worker Git metadata (hooks, filters, fsmonitor, external diff, merge drivers) | Trusted Git layer (`src/workspace/trusted-git.ts`): throwaway `GIT_DIR`, empty config/hooks/attributes, plumbing-only evidence, raw `hash-object --no-filters` staging, `commit-tree`/ref file updates, minimal-config merge, driver refusal | `tests/unit/trusted-git.test.ts` (hostile markers) |
| C3 | A read-only engine kind with no paths auto-allowed | Auto-allow requires a concrete, validated contained path and a recognized operation mapping; missing/empty paths ask or deny | `tests/unit/engine-permissions.test.ts` |
| C4 | `.GIT`, trailing-dot/space, `PLUTON~1` and case variants bypassed reserved/protected checks | Shared path normalizer (`src/util/path-safety.ts`): case folding on Windows/macOS, Win32 trailing dots/spaces stripped, 8.3 aliases rejected, longest existing prefix canonicalized | `tests/unit/path-safety.test.ts`, expanded policy tests |
| C5 | Truncation to 300 chars / 10 paths dropped escaping data before the decision | Oversized/malformed/conflicting scopes are flagged and denied; no decision is made on truncated security input; approval asks that cannot be displayed completely are refused | `tests/unit/engine-permissions.test.ts`, `tests/unit/engine-interactive-approval.test.ts` |
| C6 | All-null, mixed or inconsistent evidence could authorize a verdict; drift had no post revision | Explicit evidence kind, complete Git fields, executor identity, same-attempt current rows; legacy/NULL/mixed/capture-failed evidence is rejected; drift requires and re-checks the verified post-check fingerprint | `tests/unit/verification-evidence-rules.test.ts`, `tests/unit/verify-evidence.test.ts`, `tests/integration/cli-integrate.test.ts` |
| H1 | Worker hooks executed during commit | Trusted empty `core.hooksPath`; commits are built with plumbing and refs are updated without worker hooks | `tests/unit/trusted-git.test.ts` |
| H2 | Worker clean/smudge filters executed during evidence and commit | Raw worktree walker plus `hash-object --no-filters` / `update-index`; `git add` is never used | `tests/unit/trusted-git.test.ts` |
| H3 | Worker roots included the project root, all workspaces and all engine homes | Isolated worker sessions get exactly their canonical checkout and their own engine home; extra roots are ignored for workers; manager/chat capabilities stay separate | `tests/unit/native-config.test.ts`, `tests/unit/builder-workspace-root.test.ts`, `tests/unit/native-policy.test.ts` |
| H4 | `.git` was writable by the worker and could influence host Git | Host Git never trusts worker `.git`; verification snapshots exclude `.git`; residual risk is documented in §5 (the checkout remains writable) | `tests/unit/trusted-git.test.ts`, `tests/unit/verification-executor.test.ts` |
| H5 | Legacy v13 rows with NULL evidence could qualify | Migration v14 adds `evidence_kind`, post kind/dirty, executor and `superseded_at`; NULL is a legacy row that never authorizes a fresh verdict | `tests/unit/store.test.ts`, `tests/unit/verify-evidence.test.ts` |
| H6 | Verification could be run for a task from another run or wrong state | CLI, HTTP, runner and verdict validate `task.runId`, run identity and `verifying` state before writing evidence | `tests/unit/verify-redispatch.test.ts`, `tests/integration/verify.test.ts`, server route tests |
| H7 | Interrupted verification required a manual DB edit or an unsafe attempt bump | A fresh same-attempt run supersedes prior current rows (history retained, attempt unchanged) | `tests/integration/verify.test.ts`, `tests/unit/verify-evidence.test.ts` |
| H8 | Post-integration checks were reported but not gating | `integrate` and `approvals approve --continue` exit nonzero when any check fails; integration commit is bound to the verified fingerprint | `tests/integration/cli-integrate.test.ts` |
| H9 | Tamper detection missed `.only`, assertion removal and package test-script swaps | Conservative rules for focused/disabled tests, commented-out/removed assertions, deleted test files and changed/removed `"test"` scripts; the verified diff is base→live worktree, including uncommitted/untracked edits | `tests/unit/independent-verifier.test.ts`, uncommitted-tamper test in `tests/integration/cli-integrate.test.ts` |

### 1a. Defects confirmed by live Linux validation

| ID | Confirmed defect | Implemented control | Regression evidence |
|---|---|---|---|
| R1 | A snapshot under `/tmp` was hidden by the helper's private tmpfs, so real Linux checks failed closed even though isolation was available | `private_tmp: false` for verification requests in `src/verify/executor.ts`; `/tmp` remains outside the Landlock read/write roots, and only the snapshot's own `tmp/` is writable | `runs a real check inside a snapshot created under the system temp directory` in `tests/unit/verification-executor.test.ts`; Phase B1e |
| R2 | `network: none` isolated IP sockets but not AF_UNIX, so a check could reach host SSH agents, Docker, dbus or systemd; `io_uring_setup` could bypass socket mediation | `native/landlock-run/src/main.rs` installs an arch-checked seccomp filter for `restricted`/`none`: `socket(AF_UNIX)` and `io_uring_setup` return `EPERM`; setup failure is a helper startup error; the `restricted` bridge proxy is forked before the filter and still uses loopback TCP | AF_UNIX regression in `tests/unit/verification-executor.test.ts`; Phase B4 and Phase E1 |
| R3 | Trusted Git hashed symlinks with `readFileSync`, following the link. A worker-controlled symlink could make the host read files outside the checkout and commit their bytes as the link target | `src/workspace/trusted-git.ts` uses `readlinkSync`; a `120000` blob is the literal link target, never the target file's content | `hashes symlink targets instead of reading through them` in `tests/unit/trusted-git.test.ts`; Phase C6 |

## 2. Evidence identity and integration

Migration v14 adds explicit evidence identity to `verification_checks`:
`evidence_kind`, `post_evidence_kind`, `post_worktree_dirty`, `executor` and
`superseded_at`, plus an index for current same-attempt rows. Rules enforced by
`src/verify/runner.ts`:

- a verdict binds every row to the task, run and attempt;
- a Git-backed task needs complete Git pre/post evidence and an executor
  identity;
- `capture-failed` is never read as non-Git;
- mixed kinds, mixed revisions or mixed worktree states are refused;
- a post-check that moves HEAD or changes the worktree is refused;
- a run cannot close green while a completed task has a non-passed current-attempt
  check or no current-attempt evidence for a task that was ever verified;
- a fresh verification supersedes an interrupted same-attempt run without
  deleting history or bumping the attempt.

`integrateRun()` always requires Git evidence for a checkout-backed task,
computes the verified post-check fingerprint, and passes it to
`commitAll`/`commitRaw`. A checkout that changed after verification is refused
with `worktree changed after verification; refusing to commit unverified
content`, reported as `blockedDrift`, and audited. Integration never treats
legacy or NULL evidence as permission.

## 3. Verification diff and tamper detection

Verification now renders the diff through `diffWorktreePatch()` in the trusted
view: base commit → live worktree, including uncommitted and untracked files.
This matters because integration commits that exact worktree under the
fingerprint contract; a commit-only diff would hide uncommitted test
weakening. `diff.inspect` uses trusted plumbing (`diffWorktreeStat`,
`logOneline`) and never runs host `git status`/`diff`/`log` against a worker
checkout.

Tamper rules in `src/verify/independent.ts` reject:

- deleted test files;
- added `skip`/`xit`/`xtest`/`xdescribe` / `.only` / `fit` / `fdescribe`;
- newly commented-out assertions and removed `expect(...)`/`assert(...)` lines
  in test files;
- a changed or removed exact `"test"` script in `package.json`.

The rules are conservative text classifiers, not a semantic proof; they fail the
task on suspicion and never upgrade suspicion to a pass.

## 4. Platform behavior

- **Linux:** checks require the verified `landlock-run` helper, Landlock ABI ≥ 3,
  and mount/PID/network namespaces. They run in `workspace-write` mode against
  the disposable snapshot with `network: none`. For `restricted`/`none` the
  helper also installs a seccomp filter that denies `socket(AF_UNIX)` and
  `io_uring_setup`; the network namespace alone only isolates IP sockets.
- **Windows and macOS:** no supported confinement is implemented for verification
  or post-integration checks. The executor reports unavailable and the gate
  records failed checks; nothing is executed on the host. Engines in these
  environments remain on the separately acknowledged `unconfined` mode.
- **Live Linux evidence (WSL2):** Ubuntu 24.04.5 on kernel
  `6.18.33.2-microsoft-standard-WSL2`, Node `v24.20.0`, Landlock ABI 7, running
  unprivileged as `nobody`. The runtime, trusted-Git, evidence/integration and
  restricted-bridge suites below were executed against this kernel. This is
  real Landlock/namespace/seccomp evidence, but it is not a bare-metal distro
  matrix; see §5.9.

## 5. Residual risks

1. The worker checkout remains writable by the worker, including `.git`. Pluton
   never trusts that metadata, but a worker can still corrupt its own checkout;
   recovery is a fresh workspace, not a trust decision.
2. Snapshotting is a content copy, not a kernel filesystem view. A check that
   escapes the helper process tree can outlive graceful termination; CPU,
   memory and PID limits remain advisory rather than cgroup-enforced.
3. The trusted Git merge preserves effective non-executable `core.*` settings
   needed for worktree interpretation (notably `core.autocrlf`). Executable
   configuration (hooks, filters, diff/merge drivers, fsmonitor) is excluded.
4. Tamper detection covers the diff shapes listed in §3. A worker rewriting tests
   in a novel way outside those shapes may not be caught.
5. Failed verification on Windows/macOS is the intended fail-closed result, not
   a supported success path. Operators who need green verification must run on a
   Linux host with the helper and namespaces available.
6. **Verification inherits the host `PATH`.** The executor deliberately skips
   PATH entries inside the snapshot, but it does not require the remaining
   entries to be root-owned. A writable directory earlier on the operator's
   `PATH` could shadow a runtime (`node`, `python`, …) with a different binary.
   The worker cannot normally write such a directory, but operators must keep
   `PATH` clean; the audit's synthetic `node` probe confirmed inheritance.
7. **The executor does not drop to a dedicated uid.** It relies on the invoking
   user's DAC plus Landlock. Run Pluton as an unprivileged user: as root,
   root-readable host files under the allowed `/etc` read root (for example
   `/etc/shadow`) become readable inside the check even though the snapshot's
   worktree is isolated.
8. **`private_tmp: false` trades a hidden `/tmp` for a working snapshot.** The
   helper no longer mounts a fresh tmpfs over `/tmp`, so the host path namespace
   is visible. Landlock still grants no read/write access to `/tmp` outside the
   snapshot and its own `tmp/`, but metadata such as `stat` is not a
   confidentiality boundary.
9. **The seccomp filter is a two-family denylist, not a syscall allowlist.**
   AF_UNIX and `io_uring_setup` are denied; other IPC or kernel interfaces are
   not enumerated, and `open` sessions are intentionally unfiltered. The
   `restricted` bridge proxy runs outside the filter by design and is trusted
   helper code; a helper compromise is outside this boundary.
10. **Live Linux evidence is WSL2-specific.** It proves the helper against
    kernel `6.18.33.2-microsoft-standard-WSL2` with Landlock ABI 7. It is not a
    bare-metal, multi-distro or CI matrix result. The full Linux Vitest suite
    was not run because the Linux rolldown binding is absent offline; the
    audit used direct Node harnesses importing `src/**/*.ts`.

## 6. Live Linux validation

Environment: WSL2 Ubuntu 24.04.5 LTS, kernel
`6.18.33.2-microsoft-standard-WSL2`, Node `v24.20.0`, Landlock ABI 7. All
harnesses ran unprivileged as `nobody` (uid 65534) with synthetic repositories
and state under `/var/tmp`; no operator repository, home directory, credential
or production service was touched. Helper identity:
`landlock:0.1.0:1488a4243c36`, binary SHA-256
`1488a4243c360ed4d9cc5081ca4952027262c689d9377f4dc0098b7f63ee0748`.

| Phase | Result | What it proved |
| --- | --- | --- |
| B — runtime confinement | 10/10 PASS | Unavailable platform/helper and refused snapshots fail closed with no execution; outside reads/writes, sibling workspaces, engine homes, state, `.git`, `/proc/self/root` and symlink escapes are denied while snapshot/tmp writes succeed; environment canaries are stripped; `HOME`/`TMPDIR` are inside the snapshot; timeout kills descendants and output is truncated at the cap. AF_UNIX host IPC was reachable before R2 and is `EPERM` after the fix, with zero host connections. |
| C — trusted Git | 10/10 PASS | Hostile hooks, filters, fsmonitor, external diff, textconv and merge drivers execute on control copies but never through the trusted layer; raw identity covers newline/CR/space/quote/unicode paths, `100755`/`120000`, ignored content, raw bytes and symlink targets; stale fingerprints and pre-existing ref locks fail closed; packed refs and merges behave correctly. R3 (symlink read-through) was found and fixed here. |
| D — evidence and integration | 10/10 PASS | Missing, mixed-kind, mixed-revision, stale-attempt and cross-run evidence cannot authorize a verdict; an interrupted same-attempt run is superseded without bumping the attempt; post-verification worktree mutation, HEAD movement and missing evidence block integration with no merge, no commit and no artifact; a failing post-integration check makes the CLI exit 1 and a passing check exits 0. Checks ran under `landlock:0.1.0:1488a4243c36`. |
| E — restricted bridge | 1/1 PASS | With `network: restricted`, the engine's loopback TCP request was forwarded by the helper proxy to the host AF_UNIX bridge and received the reply; a direct AF_UNIX connect from the same engine returned `EPERM`; the reported bridge port matched. This proves the seccomp filter did not break the intended bridge path. |

Not tested / blocked:

- the full Linux Vitest suite — the Linux rolldown binding is absent and
  network installs were excluded, so the audit used plain Node harnesses that
  import the TypeScript source;
- bare-metal Linux, other distributions and other kernels (WSL2 only);
- Docker as an alternate disposable runtime — the Docker engine pipe was absent.

## 7. Verification commands and results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | pass |
| `npm test -- --reporter=dot` | 151 files, 1319 passed, 5 skipped (the new Linux-only regressions skip on Windows; the earlier baseline had 2 skips) |
| `npm run build` | pass |
| `npm run verify:docs` | 73 files, 48 links checked, 0 broken |
| `npm run verify:assets` | 60 checks passed |
| `npm run release:check -- --allow-dirty` | 16 checks: 15 passed, 0 failed, 1 not tested (POSIX 0600 on Windows), 0 owner blockers; `npm run check` and `npm run build` inside it passed |
| `git diff --check` | pass (no whitespace errors) |

## 8. Working-tree preservation

The working tree intentionally remains dirty and uncommitted. Exactly nine
tracked files changed; nothing else in the tree was modified:

- `src/verify/executor.ts`
- `src/workspace/trusted-git.ts`
- `native/landlock-run/src/main.rs`
- `native/landlock-run/landlock-run-linux-x64`
- `native/landlock-run/manifest.json`
- `tests/unit/verification-executor.test.ts`
- `tests/unit/trusted-git.test.ts`
- `docs/audits/verification-trust-boundary-hardening.md` (this record)
- `docs/SECURITY.md` (Linux evidence + residual risks)

The code changes are limited to the three remediation defects (R1–R3) and their
regression tests; the remaining two files document the audit. Nothing was reset,
stashed, cleaned, reverted, committed, tagged or published. No live malicious
engine or exploit was executed against the host; the hostile fixtures were local
synthetic repositories in `/var/tmp`.
