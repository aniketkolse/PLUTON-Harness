# ADR-0010 — Windows / WSL2 support boundary

- Status: Accepted (2026-10-16)

## Context

The first supported developer setup is Windows 11 + WSL2 + Docker Desktop, with workers in Linux
containers. This host has: Windows 11 (build 26300), WSL 2.7.13 with **only** the
`docker-desktop` utility distro (no general Linux distro with a shell), Docker Desktop installed
per-user with the daemon currently stopped, and a native `tmux.exe` that is *not* part of the
supported path.

## Decision

- **Supported (and the tested target of this build):** Pluton CLI/daemon running on Windows
  (Node ≥ 24) driving Docker Desktop's Linux containers; tmux and all worker commands run
  **inside Linux containers only**. Pluton never claims tmux support on native Windows.
- **`pluton doctor`** performs the first-run checks (OS, WSL2 presence when on Windows, Docker
  daemon reachability, Git, config validity, storage writability, engine binary + protocol
  handshake, per-Muse auth presence, worker-image presence) and prints an exact fix per failing
  check.
- **Workspace paths:** Pluton prefers a repository location the Docker engine can bind-mount
  efficiently. When a WSL distro with a home filesystem exists, the documentation recommends
  keeping active repositories under the WSL filesystem; when the repository lives on a Windows
  path (like this build environment), Pluton warns with an actionable note instead of silently
  relocating anything. `/mnt/c`-style paths seen from inside WSL get the same warning.
- **No silent environment mutation:** Pluton never edits Windows/WSL/Docker settings, starts
  Docker Desktop, or provisions distros automatically.
- **Degradation:** without a running Docker daemon, worker dispatch fails closed with the exact
  fix (`start Docker Desktop`); the dev-only `local-process` sandbox (ADR-0004) allows exercising
  orchestration logic in tests with an explicit acknowledgement field.
- **WSL2 is not assumed:** on Windows without WSL2 (or without Docker), `doctor` explains the
  supported setup; no crash paths rely on WSL.

## Consequences

- The E2E Docker suite is opt-in and reports NOT RUN when the daemon is stopped, with a
  reproducible command.
- Evidence captured here: Windows 11 + Node 24 + OpenCode (live, free model) runs natively;
  container paths are unit-tested with fakes and exercised for real only when the daemon runs.

## Evidence

- Recon: `wsl --status` (default distro `docker-desktop`, version 2); `docker info` → daemon not
  running (npipe missing); `Test-Path "C:\Program Files\Docker\..."` → false (per-user install at
  `%LOCALAPPDATA%\Programs\DockerDesktop`).
