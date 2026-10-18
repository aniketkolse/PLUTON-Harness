# Releasing Pluton-Harness

Scope: the `pluton-harness` npm package (executable `pluton`, Node.js >= 24).
This document is the staged procedure for a controlled public release. It
separates **technical validation** (what tooling can prove) from **publication
authorization** (an owner decision that tooling never makes).

Nothing in this repository or its tooling has published, tagged, pushed or
released anything. `"private": true` and `"license": "UNLICENSED"` remain in
`package.json` on purpose (see the owner-decisions table below).

## Current owner decisions (blockers for the *first* public publish)

These are deliberately **not** changed by tooling. A public release is
impossible until the owner decides them:

| Item | Current state | Required action |
|---|---|---|
| `private` flag | `"private": true` in `package.json` | Owner removes it in the release commit (keeps accidental `npm publish` impossible until then) |
| Outbound license | `"license": "UNLICENSED"`; **no `LICENSE` file exists and MIT has not been applied** | Owner chooses a license, adds the `LICENSE` file, updates `package.json`, `THIRD_PARTY_NOTICES.md` and ADR-0011 |
| Registry account | Not configured (no `publishConfig`, no `.npmrc`) | Owner holds the npm account + 2FA; provenance recommended if publishing from CI |
| CI execution | Workflow committed at `.github/workflows/ci.yml`; repository has **no git remote**, so GitHub never runs it yet | Owner adds a remote on GitHub; until then the gate runs locally (below) |

`npm run release:check` reports the first two as `[BLOCKED] owner decision`
lines with remediation. They cannot pass silently, and the gate's summary
stays `PUBLICATION: BLOCKED` while they exist.

## Technical validation vs publication authorization

- `npm run release:check` is **technical validation only**. A green run means:
  the code, tests, build and package metadata satisfy the documented
  technical criteria — nothing more.
- It **never** publishes, tags, pushes, deletes repository files, mutates
  package metadata, or prints tokens. It creates exactly one throwaway
  directory under the OS temp dir (permission probe) and removes it again.
- Publication requires, in order: all owner decisions resolved, a clean
  committed tree, a green gate, the staged process below, and **explicit
  human approval** after the tarball smoke. No tooling substitutes for that
  approval.

## The gate

```bash
npm run release:check                     # full gate (requires a clean tree)
npm run release:check -- --allow-dirty    # local pre-commit run only, never for a real release
```

Every check is deterministic given the same checkout, host and network, and
runs without credentials. Checks and their failure classes:

| # | Check | Validates | Depends on | Reports as |
|---|---|---|---|---|
| 1 | `working tree clean` | `git status --porcelain` is empty (`--allow-dirty` downgrades to a warning for local runs) | git, a checkout | FAIL (dirty) / BLOCKED (no git) |
| 2 | `version consistency` | `package.json` version === `src/version.ts` | — | FAIL |
| 3 | `package name and executable mapping` | `pluton-harness` → `bin/pluton.js` contract used by README | — | FAIL |
| 4 | `engine requirement declared` | `engines.node` present and satisfied by the running Node | — | FAIL |
| 5 | `lockfile consistency` | `package-lock.json` v3+, name/version/dependency maps match `package.json` | — | FAIL |
| 6 | `documentation links resolve` | every relative link in `README.md` / `THIRD_PARTY_NOTICES.md` exists in the repo | — | FAIL |
| 7 | `npm run check` | typecheck + full vitest suite | ~2 min | FAIL |
| 8 | `npm run build` | `tsc -p tsconfig.build.json` produces `dist/` | — | FAIL |
| 9 | `package contents: required assets` | the 9 required runtime entries are in `npm pack --dry-run` | `prepack` runs the build | FAIL |
| 10 | `package contents: no dev/local artifacts` | no tests, `node_modules`, `.pluton/`, databases, logs, tarballs or `.env` files | — | FAIL |
| 11 | `package contents: no local paths or credentials` | shipped files contain no host home/checkout paths, OS user-profile paths or credential-shaped strings | — | FAIL |
| 12 | `dependency audit (production)` | `npm audit --omit=dev` reports 0 vulnerabilities | npm registry (network) | PASS / FAIL / **NOT TESTED** (registry unreachable) |
| 13 | `file permission enforcement (POSIX 0600)` | the platform really honors `0600` (token/instance files depend on it) | POSIX filesystem | PASS / FAIL / **NOT TESTED** on Windows |
| 14 | `owner decision: private flag` | `private: true` removed | owner | **BLOCKED** until resolved |
| 15 | `owner decision: license` | an outbound license chosen and applied | owner | **BLOCKED** until resolved |

`npm pack --dry-run` runs the `prepack` build but never uploads anything; it
works with `"private": true` in place, which is why package inspection is
possible before the owner removes the flag.

### Reading the result states

| State | Meaning | Action |
|---|---|---|
| `PASS` | ran, acceptance criteria met | none |
| `FAIL` | ran, found a real technical defect | fix it; the gate exits 1 |
| `NOT TESTED` | did not run in this environment (platform/network); **no result exists** | run on the platform/network where it applies (CI covers it); never treat as passing |
| `BLOCKED` | external prerequisite or owner decision prevents the check or the release | owner decision or missing infrastructure; do not publish |

Exit code: `0` only when no check FAILED. `NOT TESTED` and `BLOCKED` never
fail the technical exit code, but they stay printed with remediation and the
`PUBLICATION:` line remains `BLOCKED` until owner decisions are resolved.

## Supported platforms

Verified project configuration: Node.js **>= 24** (`engines.node`), npm with
the committed `package-lock.json` (v3), first-class Windows 11 development
hosts, and a documented Linux daemon/worker story through Docker (ADR-0004,
ADR-0015). macOS support is code-complete (`sameDirPath`, launcher app-mode
paths, tool discovery via explicit platform parameters) but **has not been
executed on a native macOS machine** in this project's history.

| Subsystem | Windows | Linux | macOS |
|---|---|---|---|
| CLI and package entry points | validated locally | CI job (not yet executed) | CI job (not yet executed) |
| Paths and workspace containment | validated locally | CI job | CI job |
| Server start/stop, instance metadata, claims | validated locally | CI job | CI job |
| SQLite persistence (`node:sqlite`) | validated locally | CI job | CI job |
| SSE and auth/host validation | validated locally | CI job | CI job |
| File permissions (0600 token/instance) | NOT TESTED — mode bits unenforced; gate says so | gate check 13 | gate check 13 |
| Docker worker containers + tmux | executed via Docker Desktop (Linux containers on a Windows host — *not* a native Linux host) | CI `e2e-docker` job | not covered (Docker Desktop only; native engines unverified) |
| Browser app-mode launcher | validated locally (Edge/Chrome) | PATH-probing logic unit-tested; native launch NOT TESTED | bundle paths unit-tested; native launch NOT TESTED |
| Signals and process cleanup | validated locally (Node emulation) | CI job | CI job |
| Package install from tarball | validated locally (`npm run smoke:package`, path with a space) | CI job | CI job |

"CI job" means the workflow is committed and will run the check; the results
become real only once a GitHub remote exists and the workflow has actually
executed. Until then those cells are NOT TESTED — do not claim otherwise.

## Local reproduction

```bash
npm ci                       # deterministic install from the lockfile
npm run check                # typecheck + full unit/integration suite
npm run build                # production build into dist/
npm run release:check        # the full gate (clean tree required)
npm run release:check -- --allow-dirty
npm run smoke:package        # pack → clean install (temp path with a space) → --version/--help
npm pack --dry-run --json    # inspect exactly what would be published
npm audit --omit=dev         # production dependency audit (needs registry)

# opt-in suites (excluded from `npm run check`; read their headers first):
npx vitest run --config vitest.e2e.config.ts   # Docker + tmux E2E — set PLUTON_E2E_DOCKER=1,
                                               # requires a worker image: docker build -t pluton-worker:local docker/worker
npx vitest run --config vitest.live.config.ts  # live engine tests — requires an installed engine
```

Docker-dependent tests check Docker explicitly (`probe()`); without the flag
they are skipped as a suite and reported as NOT TESTED, never as passing.
Live-engine tests require a real engine CLI or free models; they are opt-in
and NOT TESTED in CI.

## CI workflow

`.github/workflows/ci.yml` runs on `push` to `main`, pull requests and manual
dispatch, with `permissions: contents: read`, no secrets, and
`persist-credentials: false` on checkout:

- **validate** (matrix: `ubuntu-latest`, `macos-latest`, `windows-latest`,
  Node 24): `npm ci` → `npm run release:check` → `npm run smoke:package`.
  This is where checks 12–13 get their POSIX results and where the
  cross-platform runs above become real.
- **e2e-docker** (`ubuntu-latest`): builds `pluton-worker:local` from
  `docker/worker/Dockerfile`, then runs the opt-in Docker/tmux E2E with
  `PLUTON_E2E_DOCKER=1`.

No failure artifacts are uploaded (test and gate output already lands in the
job log; nothing in the build contains secrets — check 11 enforces that).

## Staged publishing process

Every step is a stop point. Do not skip step 4.

1. **Prepare** — resolve the owner decisions, commit all release work, bump
   the version in `package.json` **and** `src/version.ts` (a gate check
   asserts they match), ensure the tree is clean.
2. **Gate** — `npm run release:check`. Required: `TECHNICAL VALIDATION: PASS`,
   zero `[FAIL]`, zero `[BLOCKED]` owner decisions, and every `[NOT TESTED]`
   either resolved or consciously owned (it will say which platform/network
   it needs). The `PUBLICATION:` line must read `ELIGIBLE`.
3. **Dry run** — `npm publish --dry-run --access public`. Confirm the package
   name, version, and file list; nothing is uploaded in this mode.
4. **Tarball smoke (human approval gate)** — `npm run smoke:package`
   (mechanical: pack → clean install in a temp path with a space → `--version`
   / `--help`), then by hand against a scratch project: `pluton init`,
   `pluton --status`, `pluton --detach --headless` + `pluton --stop`. All must
   behave as documented in `README.md`. **The owner explicitly approves the
   publish only after this evidence is on the table.**
5. **Publish** — `npm publish --access public` from the release commit, with
   2FA. Prefer `--provenance` when publishing from CI.
6. **Verify publication** — `npm view pluton-harness version` shows the new
   version; in a fresh shell `npm install -g pluton-harness@<version>` and
   `pluton --version` return the same version. Only then is the release
   "published" — never claim it earlier.

Versioning: the package is `0.x`; per semver convention for initial
development, breaking changes may land in minor releases. State that in the
release notes.

## Rollback and deprecation

A published version cannot be edited; recovery is deprecation or, in a narrow
window, unpublishing.

1. **Prefer deprecation + fix**: publish the corrected patch first, then
   `npm deprecate pluton-harness@<bad-version> "reason; upgrade to <fixed>"`.
   Consumers keep working; installs warn.
2. **Dist-tag rollback** (when `latest` must point back):
   `npm dist-tag add pluton-harness@<previous-good> latest` and re-check with
   `npm view pluton-harness dist-tags`.
3. **Unpublish** (last resort, within npm's 72-hour window, if the release
   leaks secrets or is malicious): `npm unpublish pluton-harness@<bad-version>`
   — record that this breaks every consumer that already depends on it.
4. **Local-install rollback** (user side): `npm install -g pluton-harness@<previous-good>`.
5. After any rollback, add a regression test or gate check that would have
   caught the defect, and note it in `docs/ROADMAP.md`.

## Package contract this procedure assumes

- Executable `pluton` → `bin/pluton.js` (prefers `dist/`, falls back to `src/`
  for Node >= 24 source runs in the repo only).
- Shipped files (whitelist in `package.json#files`): `bin/`, `dist/`,
  `docker/worker/Dockerfile` (containerized worker image), `templates/`
  (`pluton init` team/role files), `README.md`, `THIRD_PARTY_NOTICES.md`,
  `package.json`. Gate checks 9–11 verify presence, exclusions and content.
- Runtime dependencies: commander, yaml, zod. Gate check 12 audits the
  production tree; re-run `npm audit --omit=dev` as part of any release review.
- Runtime state lives per-project under `.pluton/` in the *user's* workspace —
  nothing in the package writes state at install time (no postinstall script).

## Known limitations (accepted, recorded)

- Native Linux and native macOS runs have not happened in this repository's
  history; the CI jobs above are the mechanism, and they are NOT TESTED until
  a remote exists and the jobs execute.
- Docker-based validation on this project so far used Docker Desktop (Linux
  containers on a Windows host): useful for the container/tmux layer, **not**
  evidence of native Linux host behavior.
- `--browser` mode exposes the session token in the address bar; mitigated by
  `Referrer-Policy: no-referrer` and loopback binding — see `docs/SECURITY.md`.
- Cancellation of an actively streaming turn via the HTTP API is not fully
  proven (documented race, see `docs/ROADMAP.md`).
