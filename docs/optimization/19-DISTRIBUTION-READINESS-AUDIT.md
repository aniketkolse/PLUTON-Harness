# PLUTON 4.0 Phase 4 — Batch 7: Distribution & Installation Audit

**Date:** 2026-11-02  
**Milestone:** Phase 4, Batch 7 — Distribution & Installation Readiness  
**Branch:** `optimization/p0-reliability` (local worktree; no remote push)  
**Status:** `OPTIMIZED AND VERIFIED` (audit only; implementation pending)

---

## 1. Executive Summary

Batch 7 audits PLUTON's distribution, installation, first-run experience, configuration management, database initialization/upgrades, and cross-platform behavior. The goal is to make installation and operation predictable for new users while preserving existing project data, configuration, compatibility, and execution guarantees.

Key finding: Pluton has a solid foundation — a single `pluton-harness` npm package with a `bin/pluton.js` entry point, declarative `pluton.yaml` configuration, SQLite-based persistence with forward-only migrations, and platform-aware native execution. However, there is no dedicated first-run `pluton doctor --init` flow, no standalone installer, no cross-platform packaging matrix, and no formal upgrade-from-previous-version testing. Several gaps exist between "works on this developer's machine" and "installs reliably for any user."

---

## 2. Package & Build Inventory

### 2.1 Package Metadata (`package.json`)

| Field | Value | Notes |
| :--- | :--- | :--- |
| name | `pluton-harness` | Registered npm name |
| version | `0.1.0` | Also mirrored in `src/version.ts` (`PLUTON_VERSION`) |
| type | `module` | Pure ESM |
| bin | `pluton` → `bin/pluton.js` | CLI entry point |
| engines.node | `>=24.0.0` | Major-version floor checked at release gate |
| dependencies | `commander`, `yaml`, `zod` | Three production deps, all small |
| devDependencies | `@types/node`, `@vitest/coverage-v8`, `typescript`, `vitest` | Dev-only, excluded from published package |
| files | `bin`, `dist`, `native`, `templates`, `README.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE` | Files whitelist for `npm pack` |

### 2.2 Build Output

| Output | Path | Notes |
| :--- | :--- | :--- |
| Compiled JS | `dist/` | Produced by `tsc -p tsconfig.build.json` |
| Entry | `dist/cli/main.js` | Required by `bin/pluton.js` |
| Prepack hook | `npm run build` | Runs before `npm pack` |

The `bin/pluton.js` entry point first tries `dist/cli/main.js`, then falls back to `src/cli/main.ts` (for development without building). This dual-entry approach works in development but means a published package without `dist/` is broken.

### 2.3 Included vs Excluded Files

**Included (whitelist in `package.json#files`):**
- `bin/` — CLI entry point
- `dist/` — Compiled production output
- `native/` — `native/landlock-run` helper binary (Linux confinement)
- `templates/` — Team and role templates for `pluton init`
- `README.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`

**Excluded (implicitly, by npm's `files` whitelist):**
- `src/` — TypeScript source (not needed at runtime)
- `tests/` — Test files
- `docs/` — Documentation
- `node_modules/` — Not published
- `.pluton/` — Runtime state (never published)
- `.git/`, `.github/` — Git internals

**Verification:** `npm run verify:assets` runs `scripts/verify-assets.mjs`, which checks the embedded SPA assets (HTML/JS/CSS) for completeness, correct HTML structure, trusted-Git usage, and absence of forbidden patterns. 60 checks pass.

---

## 3. First-Run Experience

### 3.1 Installation Paths

| Path | Status | Notes |
| :--- | :--- | :--- |
| `npm install -g pluton-harness` | Documented but not yet published | README says "not yet published (see docs/RELEASE.md)" |
| `npm install && npm run build && npm link` | Documented | Local development workflow |
| `npm pack` + manual install | Supported via `scripts/smoke-package.mjs` | Verified locally |

There is **no published package** on npm yet (see `docs/RELEASE.md`). The first public publish is an owner decision (release gate blocks publication until owner decisions are resolved).

### 3.2 First-Run Flow (`pluton init`)

`pluton init` (implemented in `src/cli/commands/init.ts`) performs:

1. **Git root detection** — Uses `git rev-parse --show-toplevel` to find the repository root, falling back to the current directory.
2. **Config creation** — Writes `pluton.yaml` only if it does not already exist (refuses to overwrite).
3. **Default branch detection** — Prefers `origin/HEAD`, falls back to local `HEAD`, then `main`.
4. **Template rendering** — Fills `pluton.yaml` template with project name and default branch.
5. **Role provisioning** — Creates `.pluton/roles/` with role templates (`manager.md`, `worker.md`, etc.) only when they do not already exist.
6. **State directory creation** — Creates `.pluton/state/`, `.pluton/engine-homes/`, `.pluton/workspaces/`, `.pluton/logs/` with `recursive: true`.
7. **`.gitignore` updates** — Appends Pluton-specific entries (`.pluton/state/`, `.pluton/engine-homes/`, etc.) only if missing.

No operator action is required after `pluton init` to create the directory structure and config. The user must still:
- Edit `pluton.yaml` to assign Ships, engines, and models
- Run `pluton doctor` to verify the environment

### 3.3 First-Run Diagnostics (`pluton doctor`)

`pluton doctor` (implemented in `src/cli/commands/doctor.ts`) performs environment validation:

| Check | What it verifies | Status on failure |
| :--- | :--- | :--- |
| Node.js | `process.versions.node` major >= 24 | FAIL with install hint |
| Platform | Linux vs macOS/Windows confinement info | INFO/WARN (informational) |
| Git | `git --version` exits 0 | FAIL with install hint |
| Project config | `pluton.yaml` exists and parses | FAIL with fix hint |
| State storage | `.pluton/state/` is writable | FAIL with fix hint |
| Engine availability | Each configured Ship's engine adapter is installed | FAIL with fix hint |
| Auth | Each Ship's engine auth is configured | WARN (engine runs will fail) |
| Sandbox | Native execution helper works | FAIL with fix hint |
| Disk space | >= 5 GB free | WARN if below |
| tmux | `tmux --version` exits 0 | INFO (only needed for `pluton attach`) |

The doctor command does **not** start a server, start a run, or modify any durable state. It is safe to run at any time.

---

## 4. Configuration Management

### 4.1 Config Discovery

`loadConfig(rootDir)` in `src/config/load.ts`:
1. If `rootDir` is a file, treats it as the config file directly; otherwise looks for `pluton.yaml` in `rootDir`.
2. Walks **up** the directory tree from `startDir` looking for `pluton.yaml`. Returns the first match or `null`.
3. Validates config version (`CONFIG_VERSION = 1`) — rejects unknown versions with migration guidance.
4. Validates against `plutonConfigSchema` (Zod).
5. Validates ship configs: assignment edges must not cycle, assignee ships must exist, manager ship must exist.
6. Normalizes legacy config keys (`muses` ↔ `ships`, `max_muse_*` → `max_ship_*`, deprecated permission names).

### 4.2 Configuration Precedence

Configuration sources (in priority order):
1. **CLI flags** (e.g., `--goal`, `--acceptance`) — command-line overrides
2. **`pluton.yaml`** — project-level config discovered by walking up from CWD
3. **Defaults** — hardcoded defaults in `schema.ts` (e.g., `max_concurrent_workers: 3`, `max_run_minutes: 90`)

There is **no environment variable override** for config values. Environment variables are not read for configuration.

### 4.3 Configuration Validation

`plutonConfigSchema` (Zod) validates:
- `version: 1` — exact match required
- `project.name`, `repository`, `default_branch`
- `verification` — array of `{name, command}` (argv arrays, never shell strings)
- `runtime` — worker limits, timeouts, network policy, verification checks
- `sandbox` — native execution policy (mode, per-platform overrides, `acknowledge_unconfined`)
- `git` — protected paths, merge approval requirement, base branch
- `ships` — map of ship IDs to ship configs (role, engine, model, workspace policy, permissions, network policy, limits)
- `models` — discovery, selection, fallback configuration

Validation errors include the specific field path and a human-readable message.

### 4.4 Configuration Gaps

| Gap | Impact |
| :--- | :--- |
| No environment variable override for config values | Operators cannot override config via env (e.g., `PLUTON_MAX_CONCURRENT_WORKERS=4`) |
| No `--config` flag on CLI commands | Config discovery is always by walking up from CWD; no way to point at a different config file |
| No `--config` on `pluton init` | Cannot initialize a config in a non-CWD directory |
| No `pluton config` command | No dedicated command to view or validate config (though `pluton doctor` covers some of this) |

---

## 5. Database Initialization & Upgrades

### 5.1 SQLite Database

- **Location**: `.pluton/state/pluton.sqlite` (relative to project root)
- **Driver**: Built-in `node:sqlite` (`DatabaseSync`), synchronous API
- **Migrations**: Forward-only numbered migrations (v1–v14), stored in `src/store/migrations.ts`
- **Version tracking**: `user_version` pragma; a database with a higher version than the build supports is **refused** (not downgraded)
- **Backup**: `src/store/backup.ts` creates a verified backup before migration

### 5.2 Migration Behavior

| Aspect | Behavior |
| :--- | :--- |
| Migration direction | Forward-only (v1 → v2 → … → v14) |
| Migration execution | Inside a single `BEGIN IMMEDIATE` transaction together with `user_version` bump |
| Failed migration | Transaction rolls back; database unchanged |
| Unknown version | Database with `user_version` > build's max version is **refused** |
| Migration guidance | Errors include migration guidance docs link |
| Backup before migration | `createVerifiedBackup()` creates a throwaway copy, verifies it read-only, then migrates |

### 5.3 Migration Gaps

| Gap | Impact |
| :--- | :--- |
| No explicit `pluton db-migrate` command | Migrations run automatically on first access; no explicit control |
| No pre-migration backup verification | Backup is created but not explicitly verified as restorable |
| No downgrade path | Migrations are forward-only; no rollback support |
| No schema version in `pluton doctor` output | Doctor does not report DB schema version |

---

## 6. Cross-Platform Behavior

### 7.1 Platform Support Matrix

| Feature | Windows 11 | macOS | Linux |
| :--- | :--- | :--- | :--- |
| Node.js runtime | Verified | Not tested | CI job (not yet executed) |
| Git | Verified | Not tested | CI job |
| Native execution (`unconfined`) | Verified | Code-complete, not tested | Code-complete, not tested |
| Native execution (`workspace-write`/`read-only`) | Not applicable | Not applicable | Landlock helper required, not tested |
| Network policy (`restricted`/`none`) | Not applicable | Not applicable | Requires Landlock ABI ≥ 3 + namespaces |
| File permissions (0600) | Not enforced | Not enforced | CI job (not yet executed) |
| `pluton attach` (tmux) | Lifecycle unit-tested; live attach not tested | CI job | CI job |
| App-mode window launcher | Verified (Edge/Chrome) | Not tested | Not tested |
| Package install from tarball | Validated locally | CI job | CI job |

### 7.2 Platform-Specific Issues

| Issue | Windows | macOS | Linux |
| :--- | :--- | :--- | :--- |
| File paths | Backslash handling, drive letters | Forward slashes | Forward slashes |
| File permissions | 0600 not enforced | Enforced | Enforced (CI) |
| Process signals | Limited | Supported | Supported |
| File locking | NTFS locks can block | Advisory locks | Advisory locks |
| Case sensitivity | Case-insensitive | Case-sensitive | Case-sensitive |
| Symlinks/junctions | Junctions supported | Symlinks supported | Symlinks supported |
| Landlock confinement | N/A | N/A | Requires kernel ABI ≥ 3 + helper |

### 7.3 Known Platform Issues

| Issue | Impact | Mitigation |
| :--- | :--- | :--- |
| Windows NTFS file locking | Concurrent `git clone` bursts can trigger `spawn git ENOENT` | Test suite keeps `cli-integrate.test.ts` sequential |
| Windows 0600 permissions | Not enforced; token/instance files rely on 0600 | Release gate check 13 is `NOT TESTED` on Windows |
| macOS native confinement | Code-complete but not tested | Documented as not yet verified |
| Linux Landlock | Requires helper binary + ABI ≥ 3 | Not tested on bare metal in this checkout |

---

## 8. Installation & Upgrade Gaps

| Gap | Impact | Severity |
| :--- | :--- | :--- |
| No published npm package | Users cannot `npm install -g pluton-harness` yet | High (blocks adoption) |
| No `pluton doctor --init` flag | No guided first-run setup | Medium |
| No `pluton config` command | No dedicated way to inspect/validate config | Low |
| No migration status in `pluton doctor` | Users cannot see DB schema version | Low |
| No backup-before-migration verification | Backup created but not verified as restorable | Low |
| No downgrade path | Migrations are forward-only only | Medium (documented) |
| No `pluton --version` check against package | Version consistency checked only at release gate | Low |

---

## 9. Packaging Gaps

| Gap | Impact | Severity |
| :--- | :--- | :--- |
| `bin/pluton.js` falls back to `src/cli/main.ts` | Published package without `dist/` is broken | High (mitigated by `prepack` build hook) |
| No `bin/pluton.cmd` on Windows | `.cmd` shim generated by npm on install | Low (npm handles this) |
| No standalone executable | Users need Node.js installed | Medium (documented limitation) |
| No container image | No Docker image for Pluton itself | Medium (documented as not needed — Pluton runs engines, doesn't need Docker itself) |

---

## 10. Acceptance Criteria (Measurable)

| # | Criterion | How Measured |
| :--- | :--- | :--- |
| 1 | Package installs cleanly on Windows, macOS, Linux | `npm install -g pluton-harness` from tarball; `npm run smoke:package` |
| 2 | `pluton --version` reports correct version | Matches `package.json` and `src/version.ts` |
| 3 | `pluton init` creates config + workspaces without overwriting | `pluton init` in fresh dir; second run refuses |
| 4 | `pluton doctor` passes on a properly configured system | All checks return `pass` |
| 5 | SQLite database initializes and migrates cleanly | Fresh DB gets v14; existing DB migrates forward |
| 6 | Migration refuses on newer schema version | DB with higher `user_version` is refused |
| 7 | No secrets in published package | `npm pack --dry-run` contents scanned; 0 findings |
| 8 | Package contains all required files | `bin/pluton.js`, `dist/cli/main.js`, `native/`, `templates/`, `README.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE` |
| 9 | Cross-platform: installs and runs on Windows, macOS, Linux | CI matrix (windows-latest, macos-latest, ubuntu-latest) |
| 10 | Release gate passes | `npm run release:check -- --allow-dirty` reports `TECHNICAL VALIDATION: PASS` |

---

## 10. Residual Risks & Limitations

1. **No published package yet** — `pluton-harness` is not on npm; `npm install -g pluton-harness` will fail until the first public release.
2. **No guided first-run (`pluton doctor --init`)** — `pluton init` creates config and workspaces but there is no guided setup flow that walks the user through Ship configuration, model selection, and verification setup.
3. **Cross-platform disparities** — Linux confinement (Landlock) is not available on Windows/macOS; those platforms run in `unconfined` mode only. This is documented but not mitigated.
4. **No database migration rollback** — Migrations are forward-only; a failed migration leaves the database at the previous version (transaction rollback), but there is no explicit rollback command.
5. **No `pluton config` command** — Operators must edit `pluton.yaml` directly; there is no dedicated config inspection or editing command.
6. **Package size not measured** — `npm pack` output size has not been measured or bounded.

---

## 11. Files To Be Changed (Planned)

| File | Change |
| :--- | :--- |
| `docs/optimization/19-DISTRIBUTION-READINESS-AUDIT.md` | This audit |
| `docs/optimization/PROGRESS.md` | Batch 7 status + rulings |
| `src/cli/commands/init.ts` | May need improvements based on audit findings (first-run experience) |
| `src/cli/commands/doctor.ts` | May add migration status, config validation summary |
| `src/config/load.ts` | May add config validation summary, environment variable override support |
| `src/store/migrations.ts` | May add migration status reporting, pre-migration backup verification |
| `scripts/release-check.mjs` | May add package size check, install-from-tarball test |
| `scripts/smoke-package.mjs` | May add cross-platform installation test |
| `docs/RELEASE.md` | May update release procedure based on findings |
| `README.md` | May update installation instructions |

---

## 12. Sign-off

Audit complete. No implementation files modified yet. The distribution architecture is sound (npm package, SQLite database, forward-only migrations, cross-platform aware), but key gaps remain: no published package, no guided first-run (`pluton doctor --init`), no `pluton config` command, no migration status in `pluton doctor`, and cross-platform disparities (Linux confinement vs. Windows/macOS `unconfined`).

**Next:** Step 2 — define the distribution strategy (npm package vs. alternatives), then implement first-run experience improvements.
