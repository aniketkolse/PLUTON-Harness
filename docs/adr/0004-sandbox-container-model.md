# ADR-0004 — Sandbox / container model

- Status: Accepted (2026-10-16); image pinning details finalized in Phase 5

## Context

Worker Muses execute model-driven shell commands and edit code. tmux is explicitly *not* a
security boundary. The host is Windows 11 + Docker Desktop (WSL2 backend). Worker execution must
have consistent Linux semantics (paths, signals, tmux). The Docker daemon is *not guaranteed* to
be running (observed: Docker Desktop installed, daemon stopped at recon time).

## Decision

- **Primary containment:** Docker CLI-managed Linux containers, **one long-lived container per
  Muse** (recreated on policy change or corruption), with task work mounted per task.
- **Baseline hardening** applied by one code path (`src/sandbox/docker.ts`) using argument arrays:
  non-root user, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`,
  `--memory`, `--cpus`, bounded tmpfs `/tmp`, no Docker socket, no host network by default.
- **Mounts are an allowlist:** exactly (1) the task's Pluton-owned checkout (rw), (2) the Muse's
  private engine home (rw), (3) explicitly granted data. Runtime DB, control-plane token, host
  secrets, and other projects' workspaces are never mounted.
- **Environment:** explicit allowlist only (e.g. `TERM`, `LANG`, tool-specific non-secret vars).
  Daemon tokens, cloud credentials, SSH agent sockets, host `HOME` are never inherited.
- **Identity & cleanup:** every resource carries labels `io.pluton.managed=true`,
  `io.pluton.project=<id>`, `io.pluton.muse=<id>`; stop/kill revalidates label + container ID
  before acting; graceful stop with bounded timeout, then terminate; cleanup failures are
  recorded and block unsafe replacement.
- **Network policy:** `open` is the runtime default (explicit opt-in to egress); `restricted`
  attaches the container to a dedicated `--internal` Docker network
  (`runtime.internal_network_name`, else `pluton-restricted-<projectId>`) with no default route,
  no masquerading and Docker's cross-network drops, and is proven at run start by an in-container
  TCP probe; `none` uses `--network none`. A restricted container never falls back to `bridge`,
  and managers that cannot enforce a policy (`local-process`, `native`) refuse it. The internal
  gateway stays reachable by design (the tool bridge), so `restricted` denies the internet, not
  the host — see `docs/SECURITY.md` §8.5 and `src/sandbox/network.ts`.
- **Failure posture:** if Docker is unavailable, worker dispatch **fails closed** with an exact
  fix message in `pluton doctor` / run errors. There is one explicitly dev-only degraded
  sandbox, `local-process`, gated behind a config flag and labeled non-isolated; it exists to
  test orchestration logic and CANNOT be selected for team runs without an explicit
  acknowledgement field (`sandbox.local_process_acknowledged: true`).
- **tmux** runs inside the worker container (`apt`-installed in the worker image), never as a
  Windows-native dependency of the control plane.

## Consequences

- Docker Desktop must be running; the E2E suite reports NOT RUN when it is not, with a
  reproducible command for the operator.
- Container-per-Muse (not per-task) keeps startup latency and tmux persistence; task isolation
  comes from separate checkouts and process supervision, container isolation bounds blast radius
  per Muse.

## Alternatives considered

- **Host execution with deny-lists** — rejected: deny-lists are secondary defense; OS isolation
  is required.
- **Podman/rootless** — plausible future; Docker Desktop is the installed engine here.
- **Devcontainers per task** — rejected for MVP: heavier, task-per-checkout mounting already
  isolates files.

## Evidence

- Recon: `docker --version` → 29.7.2; daemon probe failed (`npipe ... daemon is not running`);
  WSL2 present (`docker-desktop` distro stopped).
- Threat model: docs/SECURITY.md.
- Phase 5 (2026-10-16, daemon started on this host; Docker Desktop install is per-user under
  `%LOCALAPPDATA%\Programs\DockerDesktop`):
  - `pluton sandbox build-image` → `pluton-worker:local` = `sha256:a6c8367674f0d794d00e6985138ebc3650cfb3c320a9a93824d67ef5983a8c36`;
    `tmux 3.3a` and `node v24.22.0` verified by running them inside the image before the record was written.
  - Gated E2E (`PLUTON_E2E_DOCKER=1 npm run test:e2e`): 5/5 green — container create/start with the
    hardening argv (non-root `10001:10001`, cap-drop, limits, `--network none`, noexec tmpfs), bounded
    argv execs, tmux session/window idempotency, `send-keys` → `capture-pane` marker roundtrip, kill
    lifecycle. File: `tests/e2e/docker-sandbox.e2e.test.ts`.
  - `pluton doctor` on the provisioned project: docker-daemon pass (server 29.7.2), sandbox pass,
    worker-image pass (recorded-ID match), tmux pass verified inside the image — not a claim.
  - Unit conformance: `tests/unit/sandbox.test.ts` (12) asserts the exact `docker create` argv and the
    label-guarded stop/remove; `tests/unit/sandbox-image.test.ts` (10) covers build/probe/drift.
