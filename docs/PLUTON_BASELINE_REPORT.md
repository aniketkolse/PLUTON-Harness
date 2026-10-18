# PLUTON Baseline Test/Build Report — Phase 1 audit

**Date:** 2026-10-18 · **Branch:** `main` · **HEAD:** `506fa72` ("feat(tui): align chat layout to single-column card design and remediate visual defects")
**Nature of this audit:** read-only. **No source code was changed.** The only repository additions are the four audit documents (`docs/PLUTON_ARCHITECTURE.md`, `docs/PLUTON_FEATURE_PARITY.md`, `docs/PLUTON_IMPLEMENTATION_ROADMAP.md`, this report). Untracked items present before the audit: `.pluton/`, `pluton.yaml`, `PLUTON_TUI_REFINEMENT_PROMPT.md`.

## 1. Environment

| Component | Finding |
|---|---|
| OS / shell | Windows host; harness shell is PowerShell (Git Bash available and used for POSIX snippets) |
| Node.js / npm | v24.20.0 / 10.9.9 (repo requires Node ≥ 24, `package.json`) |
| Git | 2.56.0.windows.2; working tree clean except the untracked items above |
| Docker | CLI 29.8.2; **daemon running** (server 29.8.2) |
| Worker image / tmux | `pluton-worker:local` present and matching recorded build; tmux 3.3a in-image (`pluton doctor`) |
| Engine auth | **not configured for any of the 6 Muses** (`pluton doctor` warns per Muse) — per-Muse login model (ADR-0008) |
| Disk | 158.5 GB free |

## 2. Executed commands and actual results

| # | Command | Result | Exit |
|---|---|---|---|
| 1 | `npm run typecheck` (`tsc -p tsconfig.json`) | 0 errors | 0 |
| 2 | `npm test` (`vitest run`) | **89 test files / 762 tests passed**; 51.22 s (started 02:49:47) | 0 |
| 3 | `npm run build` (`tsc -p tsconfig.build.json`) | 0 errors | 0 |
| 4 | `$env:PLUTON_E2E_DOCKER='1'; npm run test:e2e` | **1 file / 5 tests passed**; 18.76 s (started 02:53:41) | 0 |
| 5 | `node bin/pluton.js doctor --json` | checks: **12 pass, 6 warn, 0 fail** (warnings = per-Muse engine auth not configured; node/wsl2/docker/git/config/image/tmux/disk pass) | 0 |

Raw logs retained at `C:\Users\Asus\AppData\Local\Temp\opencode\pluton-baseline\` (`typecheck.txt`, `test.txt`, `e2e.txt`, `doctor.json`) — outside the repo; the key totals are reproduced above.

### Test-suite composition (context)

- `tests/unit/` 70 files · `tests/integration/` 19 files · `tests/e2e/` 1 gated file · `tests/live/` 2 opt-in files · ACP frame fixtures in `tests/fixtures/`.

## 3. NOT RUN (explicit, with reproducible commands)

| Suite | Command | Reason |
|---|---|---|
| Live engine suites | `$env:PLUTON_LIVE_OPENCODE='1'; npm run test:live` and `$env:PLUTON_LIVE_QWEN='1'; npm run test:live` | Opt-in, env-gated (`tests/live/*.live.test.ts`); per-Muse engine auth not configured on this host (`pluton doctor` warnings). Historical results on this host: OpenCode 3/3, Qwen 4/4 green (`docs/ROADMAP.md` live-status paragraph). |
| Interactive attach TTY leg | `node bin/pluton.js attach <muse>` (without `--json`) | Requires a real interactive TTY; not available in this harness. The argv-resolution leg is covered by tests; the `-it` leg is recorded NOT RUN in `docs/ROADMAP.md`. |
| Full goal via real engines in this audit | `node bin/pluton.js run ...` | Not attempted: engine auth not configured (see above). Historical host-mode and container-mode live smokes are recorded as PASS in `docs/smoke-live-run.md` (2026-10-16/17). |

## 4. Pre-existing vs newly introduced failures

- **Newly introduced failures: none.** The audit changed no source code.
- **Pre-existing failures: none observed** in every suite that was executed (typecheck, build, unit/integration, gated E2E, doctor). No quarantine list exists in the repo; the suites are green at `506fa72`.
- Warnings (not failures): 6 × engine auth not configured — an environment condition, expected on a fresh host.

## 5. Baseline conclusions

1. The repository is in a healthy, verifiable state at `506fa72`: a clean baseline for PLUTON 2.0 work.
2. The gated Docker E2E path is fully exercisable on this host (daemon up, image present): 5/5 green in 18.76 s.
3. The only blocked verification tier is the opt-in live-engine tier, blocked exclusively by per-Muse engine auth — a setup action (fresh login per Muse), not a code defect.
4. All five highest-priority gaps in `docs/PLUTON_FEATURE_PARITY.md` §D were established by static evidence (file/line references), not by failing tests — i.e. they are latent, not regressions.
