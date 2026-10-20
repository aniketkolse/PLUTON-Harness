# PLUTON — Final release gates and Linux Docker validation

Date: 2026-10-20
Scope: final release-gate rerun, publication/licence audit, and native-Linux
bind-mount capability assessment.
Working tree: branch `main`, HEAD `4d18165f05b034dcf72a2a008041005593793e85`
(unchanged; all work remains uncommitted).

**Verdict: READY WITH DOCUMENTED LIMITATIONS for technical validation.
Publication remains BLOCKED by unresolved owner decisions and missing
infrastructure.** The Linux-host ownership check is **NOT RUN**; it is now
scripted and documented, but no native Linux Docker host was available.

---

## 1. Historical baseline vs this run

The prior report (`docs/PLUTON_RELEASE_READINESS_2026-10-20.md`) claimed 1,063
tests / 114 files, typecheck and build passing, 47 asset checks, 12 technical
release-gate passes, 34/34 headless-browser assertions, and a Docker-backed
supervised Build E2E. Those claims were treated as **reported baseline**, not
as evidence for this run.

Reproduced in this run (current working tree):

| Check | Result |
|---|---|
| Typecheck | **PASS** |
| Test suite | **PASS — 114 files / 1,063 tests, 0 failures** |
| Production build | **PASS** |
| Embedded-asset verifier | **PASS — 47 checks** |
| Release gate | **12 PASS / 0 FAIL / 1 NOT TESTED / 2 owner BLOCKED**; technical validation PASS |
| Docker sandbox/tmux E2E (Docker Desktop) | **PASS — 5/5** |
| Native-Linux bind-mount E2E | **NOT RUN — 4 tests skipped on Windows** |

Not re-executed in this pass: the 34/34 headless-browser suite, the supervised
Docker **Build** success/failure/cancellation evidence, the MCP 0→1 probe, the
API-contract probe, the raw interactive TUI, and the POSIX `0600` check. They
remain historical evidence only.

---

## 2. Reproduced check evidence

All commands were run from `Y:\Pluton` on 2026-10-20.

| Command | Exit | Actual result |
|---|---|---|
| `npm run typecheck` | 0 | no diagnostics |
| `npm test` | 0 | 114 test files passed; 1,063 tests passed; 0 failed (101.65 s) |
| `npm run build` | 0 | `tsc -p tsconfig.build.json` completed |
| `node scripts/verify-assets.mjs` | 0 | `verify-assets: 47 checks passed` |
| `node scripts/release-check.mjs --allow-dirty` | 0 | 15 checks: 12 passed, 0 failed, 1 not tested, 2 owner blockers; `TECHNICAL VALIDATION: PASS`; `PUBLICATION: BLOCKED` |
| `PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/docker-sandbox.e2e.test.ts` | 0 | 1 file / 5 tests passed (16.93 s) |
| `PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/linux-bind-mount.e2e.test.ts` | 0 | 1 file / **4 tests skipped** (Windows; not Linux evidence) |

Release-gate detail:

```
[PASS] working tree clean — dirty tree allowed via --allow-dirty (NOT acceptable for a real release)
[PASS] version consistency — 0.1.0
[PASS] package name and executable mapping
[PASS] engines.node >=24.0.0 (running v24.20.0)
[PASS] lockfile consistency
[PASS] documentation links resolve
[PASS] npm run check — 114 files / 1,063 tests
[PASS] npm run build
[PASS] package contents: required assets — 376 files
[PASS] package contents: no dev/local artifacts
[PASS] package contents: no local paths or credentials — 376 files scanned
[PASS] dependency audit (production) — 0 vulnerabilities
[NOT TESTED] POSIX 0600 enforcement — Windows
[BLOCKED] owner decision: private flag
[BLOCKED] owner decision: license
```

The `--allow-dirty` override is required only because the working tree is
uncommitted; it is recorded as a publication blocker, never as a release pass.

---

## 3. Publication and licence audit

| Decision | Evidence | Current state | Owner action |
|---|---|---|---|
| Repository visibility | `git remote -v` is empty; `git config --get-regexp '^remote\.'` has no entries; `gh` is not installed; `docs/RELEASE.md` states the repository has no git remote. No authenticated GitHub metadata source exists. | **Unknown — cannot be verified.** Not inferred from the absence of a public page. | Owner must add or identify the GitHub remote and confirm visibility. Tooling must not change it. |
| Licence | No `LICENSE`, `COPYING`, or `NOTICE` file exists at the root; `git ls-files` finds none. `package.json` has `"license": "UNLICENSED"` and `"private": true`. `docs/adr/0011-independence-licensing-reuse.md` explicitly leaves the outbound licence undecided; `THIRD_PARTY_NOTICES.md` covers third-party dependencies only. | **Missing / ambiguous.** No outbound licence is granted. | Owner chooses a licence, adds `LICENSE`, updates `package.json`, `THIRD_PARTY_NOTICES.md`, and ADR-0011. |
| Publication readiness | The release gate reports `TECHNICAL VALIDATION: PASS` but `PUBLICATION: BLOCKED` (dirty override in effect, plus the two owner blockers). `npm whoami` exits 1 with `ENEEDAUTH`; there is no `.npmrc` or `publishConfig`. The CI workflow exists but has never run because no remote exists. | **Blocked.** | Resolve `private` + licence; authenticate an npm account with 2FA; add a remote so CI can run; commit the release tree; rerun the gate **without** `--allow-dirty`; then dry-run, tarball smoke, and explicit human approval. |

`docs/RELEASE.md` assumes a **public** release (`npm publish --access public`)
and already lists these owner decisions and the missing remote. No visibility
change, publication, or licence selection was made in this task.

---

## 4. Linux Docker capability check

| Item | Actual evidence |
|---|---|
| Host OS | Windows 11 Home Single Language, 10.0.26300, x64 |
| Node host | `win32 x64` |
| Docker client/server | 29.8.2 / 29.8.2 |
| Docker Desktop | 4.95.0 (242831) |
| Context | `desktop-linux`; endpoint `npipe:////./pipe/dockerDesktopLinuxEngine`; only `default` and `desktop-linux` exist; `DOCKER_HOST`/`DOCKER_CONTEXT` empty |
| Daemon OS/kernel | `OSType=linux`, `OperatingSystem=Docker Desktop`, `KernelVersion=6.18.33.2-microsoft-standard-WSL2`, `Name=docker-desktop` |
| Native Linux host? | **No.** The Linux daemon is Docker Desktop's WSL2 VM on a Windows host, not a kernel/filesystem shared with the checkout. Docker Desktop's permissive mounts cannot prove native-Linux uid/gid behaviour. |
| Worker image | `pluton-worker:local`, id `sha256:107f7ac0f670…`, profile `engines`, created 2026-10-16 |
| Image preflight | `uid=10001(pluton) gid=10001(pluton)`; node v24.22.0; git 2.39.5; tmux 3.3a; opencode v2.0.31; exit 0 |
| Workspace image record | `.pluton/state/worker-image.json` points at `sha256:8110c52b…`, which does not exist locally. `pluton sandbox probe --json` therefore reports `dispatchReady: false` and the documented drift warning. This was **not** bypassed or hand-edited. The `.pluton-tmp/smoke-docker` project records the present `107f…` image. |
| Native-Linux test | **NOT RUN.** No suitable host/context was available. |

Consequence: a supervised Build launched from the `Y:\Pluton` workspace would
be refused by the honest image preflight until the documented
`pluton sandbox build-image --engines` is run in that workspace. This is local
runtime state, not a package defect, and it was not bypassed.

---

## 5. Reproducible Linux validation procedure added

| Path | Purpose |
|---|---|
| `tests/e2e/linux-bind-mount.e2e.test.ts` | Opt-in, Linux-only assertion suite using the real `DockerSandboxManager` and `resolveContainerUser()`. It covers host-uid identity, host-side ownership preservation across two lifecycles, read-only mount rejection, restrictive-permission errors, cleanup, and an unrelated-file sentinel. It skips elsewhere. |
| `docs/LINUX_BIND_MOUNT_VALIDATION.md` | Full procedure: required native-Linux/non-root environment, image preflight and drift handling, disposable workspace, exact assertions, failure interpretation, cleanup/safety, evidence template, and today's blocked-attempt log. |
| `docs/SECURITY.md` §8.9 | Still **NOT RUN**, now links to the executable check and procedure. |
| `docs/RELEASE.md` | Adds the native-Linux command to local reproduction and points the known-limitation bullet at the procedure. |
| `tests/e2e/docker-sandbox.e2e.test.ts` | Replaces the hardcoded `10001:10001` with the production resolver. The old value only worked because Docker Desktop's mounts are permissive; on native Linux it would fail against a host-owned `0700` temp checkout. Windows behaviour is unchanged and the suite was rerun 5/5. |

Exact command once a genuine native Linux host is available:

```bash
PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts \
  tests/e2e/linux-bind-mount.e2e.test.ts
```

A skipped run is **NOT TESTED**. The test has not executed on Linux; it was only
typechecked and confirmed to skip on Windows.

---

## 6. Remaining blockers and next actions

| # | Blocker | Kind | Concrete next action |
|---|---|---|---|
| 1 | Outbound licence undecided; no `LICENSE`; `"UNLICENSED"` | Owner decision | Choose a licence, add `LICENSE`, update `package.json`, `THIRD_PARTY_NOTICES.md`, ADR-0011. |
| 2 | Repository visibility unknown; no git remote; CI never executed | Owner/infrastructure | Add/confirm the GitHub remote and visibility; run the committed CI workflow. |
| 3 | `"private": true` blocks npm publication | Owner decision | Remove it in the release commit after decision 1 is applied. |
| 4 | No authenticated npm registry session (`ENEEDAUTH`); no `publishConfig` | Owner/infrastructure | Authenticate an npm account with 2FA; keep credentials out of the repo. |
| 5 | Working tree is dirty; gate used `--allow-dirty` | Release process | Review and commit the intended changes; rerun `npm run release:check` without the override. |
| 6 | Native-Linux bind-mount ownership **NOT RUN** | Technical limitation | Run the new test on a genuine Linux host, or let the `ubuntu-latest` `e2e-docker` job run it once a remote exists; record the evidence table and update SECURITY.md §8.9. |
| 7 | POSIX `0600` enforcement **NOT TESTED** on Windows | Platform limitation | The Linux/macOS CI jobs cover it; record their real results. |
| 8 | `Y:\Pluton` image record is stale (`8110…` vs tag `107f…`) | Local environment | Run `pluton sandbox build-image --engines` in that workspace before supervised builds; do not edit the record. |

Known but not release-blocking: the raw interactive TUI leg has no TTY in this
harness; the cancel/admit race logs a benign transition error; the SPA token
travels in the browser launch URL (mitigated by loopback + `no-referrer`).

---

## 7. Working-tree preservation

Baseline captured before any edit (`git status --porcelain -uall`):

- **96 entries: 71 modified tracked + 25 untracked + 0 deleted**

After this task:

- **96/96 baseline paths still present; 0 removed**
- **71/71 baseline-modified files still modified**
- **25/25 baseline-untracked files still present**

No reset, clean, stash, revert, stage, delete, or publication operation was
run. `docs/RELEASE.md` was already dirty; this task only added targeted lines
and did not revert unrelated hunks.

---

## 8. Files changed by this task

| File | Change |
|---|---|
| `tests/e2e/linux-bind-mount.e2e.test.ts` | **New** — opt-in native-Linux ownership/permission assertions. |
| `docs/LINUX_BIND_MOUNT_VALIDATION.md` | **New** — reproducible procedure and evidence template. |
| `docs/SECURITY.md` | §8.9 updated: still NOT RUN, links to the test/procedure; clarifies host-detected uid vs Windows default. |
| `docs/RELEASE.md` | Adds the native-Linux command and procedure link (file was already modified in the baseline). |
| `tests/e2e/docker-sandbox.e2e.test.ts` | Uses `resolveContainerUser()` instead of hardcoded `10001:10001`; Windows rerun 5/5. |
| `docs/PLUTON_FINAL_RELEASE_GATES_2026-10-20.md` | **New** — this report. |

No production source, configuration, Dockerfile, CI workflow, package metadata,
or licence file was changed. Scratch logs and probe output live under the
gitignored `.pluton-tmp/` and are not part of the tree.

---

## 9. Recommended next action

**Owner: resolve the outbound licence and repository visibility/remote first.**
They are the only remaining decisions that tooling cannot make, and they block
both npm publication and the first real CI run. Once a remote exists, the
`ubuntu-latest` `e2e-docker` job will execute the new native-Linux ownership
test and can close blocker 6 with real evidence.
