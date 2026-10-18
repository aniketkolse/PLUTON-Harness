# Releasing Pluton-Harness

Scope: the `pluton-harness` npm package (executable `pluton`, Node.js >= 24).
This document is the staged procedure for a controlled public release; the
automated half of it is `npm run release:check`.

## Current owner decisions (blockers for the *first* public publish)

These are deliberately **not** changed by tooling. A public release is
impossible until the owner decides them:

| Item | Current state | Required action |
|---|---|---|
| `private` flag | `"private": true` in `package.json` | Owner removes it in the release commit (keeps accidental `npm publish` impossible until then) |
| Outbound license | `"license": "UNLICENSED"` | Owner chooses a license, adds the `LICENSE` file, updates `package.json`, `THIRD_PARTY_NOTICES.md` and ADR-0011 |
| Registry account | Not configured (no `publishConfig`, no `.npmrc`) | Owner holds the npm account + 2FA; provenance recommended if publishing from CI |
| CI | No workflow, no git remote | Add CI when a remote exists; until then the gate runs locally (below) |

`npm run release:check` reports the first two as `BLOCKER` lines and fails
nothing else for them — the point is that they cannot pass silently.

## The gate

```bash
npm run release:check            # full automated gate (requires a clean tree)
npm run release:check -- --allow-dirty   # local pre-commit run only, never for a real release
```

It verifies: clean working tree, version consistency
(`package.json` === `src/version.ts`), package name/bin mapping, `npm run check`
(typecheck + all tests), `npm run build`, and `npm pack --dry-run` contents
(required runtime assets present; tests, databases, logs, `.pluton/`, and
`node_modules` absent).

## Staged publishing process

Every step is a stop point. Do not skip step 4.

1. **Prepare** — ensure all release work is committed (owner-authorized commit),
   the tree is clean, and the owner decisions above are resolved. Bump the
   version in `package.json` **and** `src/version.ts` (a test also asserts they
   match).
2. **Gate** — run `npm run release:check`. It must print `Automated gate: PASS`
   with zero `BLOCKER` lines.
3. **Dry run** — `npm publish --dry-run --access public`. Confirm the package
   name, version, and file list; nothing is uploaded in this mode.
4. **Tarball smoke (human approval gate)** — `npm pack`, then install the
   tarball into a clean temporary directory *containing a space* and run:
   `pluton --help`, `pluton --version` (must equal the release version),
   `pluton init`, `pluton --status`, `pluton --detach --headless` +
   `pluton --stop` against a scratch project. All must behave as documented in
   `README.md`. **The owner explicitly approves the publish only after this
   evidence is on the table.**
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
- Runtime assets shipped: `dist/`, `docker/worker/Dockerfile` (containerized
  worker image), `templates/` (`pluton init` team/role files).
- Runtime dependencies: commander, yaml, zod (production audit is clean;
  re-run `npm audit --omit=dev` as part of a release review).
- Runtime state lives per-project under `.pluton/` in the *user's* workspace —
  nothing in the package writes state at install time (no postinstall script).
