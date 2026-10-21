# Native execution migration design

**Docker dependency map, execution-provider seam, and phased path to OS-confined native execution**

| Field | Value |
|---|---|
| Document type | Design report (read-only audit + target design). **Not an implementation.** |
| Status | Proposed. No native provider exists at the recorded commit. |
| Repository | `aniketkolse/PLUTON-Harness` (working tree `Y:\Pluton`) |
| Recorded commit | `595e8b6588e6deae6962c7efa40a6e09eada3ef5` (`595e8b6`) |
| Working tree at audit | No source modifications. Pre-existing untracked files: five `docs/audit-*.png` plus `docs/audits/` (contains the prior source-parity report). This report adds only `docs/design/native-execution-migration-design.md`. |
| Date / platform | 2026-10-21 / win32; Node `v24.20.0` |
| Reference corpus | DeepSeek Harness (`dsh`) volumes `01`-`04` under `Y:\Setup\REA deepseek\`. `REA.txt` was searched for on `Y:\` and does not exist; all four companion volumes do. |
| Primary sources | Repository files at the recorded commit. Every finding below carries a path and line citation. |

> **Honesty constraint.** This document does **not** claim that native execution works, is secure, or is tested. At HEAD, Docker is the only isolation path with live evidence; `local-process` is an acknowledged, unconfined development mode; no native provider, no OS-confinement backend, and no native tests exist. Everything in the target design is a proposal until it is implemented and verified.

### Evidence labels

| Label | Meaning |
|---|---|
| **[F]** | Confirmed fact: read directly from the cited repository file (or from the cited dsh volume). |
| **[I]** | Inference from code structure or from the absence of a call path; falsifiable by a later check. |
| **[A]** | Design assumption that must be validated during implementation. |
| **[G]** | Confirmed gap or unverified claim; must not be reported as working. |

**Citation convention.** Compact tables sometimes use a basename after the full path was established in section 2.1. The shorthand mapping is: `docker.ts` = `src/sandbox/docker.ts`; `docker-exec.ts` = `src/engines/docker-exec.ts`; `run.ts` = `src/cli/commands/run.ts`; `chat.ts` = `src/cli/commands/chat.ts`; `muse-provision.ts` = `src/cli/commands/muse-provision.ts`; `doctor.ts` = `src/cli/commands/doctor.ts`; `verify/runner.ts` = `src/verify/runner.ts`; `terminal/...` = `src/terminal/...`; `routes.ts` = `src/server/routes.ts`; `SECURITY.md` = `docs/SECURITY.md`; `Dockerfile` = `docker/worker/Dockerfile`. Full paths are used for primary claims and every section-level finding.

---

## 1. Executive summary

1. **Docker is the only tested isolation substrate, but it is not the only execution path today. [F]** Docker supplies the container, `docker exec` engine spawn, and tmux transport. `local-process` supplies an acknowledged host-execution mode (`src/sandbox/local-process.ts:21-66`). Separately, the SPA/server chat path calls `engineAdapterForMuse(muse)` directly and never creates or enters a sandbox (`src/server/routes.ts:1292`, `:1320`), so it runs engines on the host even when `sandbox.kind: docker`. That is a real bypass, not a theoretical one.
2. **Verification is host-native in every mode. [F]** `pluton verify` and the server verify route call `runVerificationChecks`, which executes each check with `util/exec.run` at a host `cwd` (`src/verify/runner.ts:141`; callers at `src/cli/main.ts:797` and `src/server/routes.ts:559`). Container mode does not containerize verification, and the host runner inherits the full process environment by default (`src/util/exec.ts:43-46`).
3. **The Docker-dependent surface is concentrated, not spread uniformly. [F]** 37 TypeScript files contain a literal `docker`/`container` reference, but the execution-critical core is `src/sandbox/*`, `src/engines/docker-exec.ts`, `src/cli/commands/{run,chat,attach,sandbox,doctor,approvals,muse-provision}.ts`, `src/terminal/*`, and the store/config records. The orchestrator itself is substrate-agnostic: `RunSupervisor` takes `adapterFor`, `engineEnv`, and `mcpServerFor` as seams (`src/orchestrator/supervisor.ts:109-121`, `:460-464`).
4. **A native provider can reuse most of the engine layer. [F]** `EngineAdapter` creation already accepts `spawnFn`, `platform`, `binaryPath`, `mapWorkdir`, and `isolatedCheckout` (`src/engines/approval.ts:113-134`; used at `src/cli/commands/run.ts:299-324`). The ACP client already spawns through an injected `AcpSpawnFn` and falls back to `defaultSpawn` (`src/engines/acp/client.ts:39-48`, `:158-163`). The workspace manager, tool bridge, approval channel, and supervisor do not require Docker.
5. **The hard parts are OS confinement, process lifetime, and terminals - not ACP. [I]** Node's default spawn does not create a process tree/job; `AcpClient.close` only ends stdin and calls `child.kill()` (`src/engines/acp/client.ts:280-303`). Windows needs Job Objects and a restricted-token/ACL runner; Linux needs bwrap/Landlock plus process-group teardown. Terminals currently depend on tmux *inside* the container (`src/terminal/types.ts:1-8`; `src/terminal/manager.ts:87-90`), so native terminal parity needs a PTY/ConPTY broker or an explicitly reduced scope.
6. **The right seam is a split, not a renamed sandbox. [I]** PLUTON's `SandboxManager` combines container lifecycle, exec, inspect, stop/remove, and terminal transport. dsh separates a single subprocess service from a policy-only sandbox that returns a confined argv (`Y:\Setup\REA deepseek\03-model-tools-capabilities.md:223-231`, `:266-281`). The design below introduces `ExecutionProvider` (session lifecycle + spawn/exec/terminal) and `ConfinementProvider` (argv confinement), with Docker implemented as an adapter over today's `SandboxManager`.
7. **Native execution must be fail-closed and honestly labeled. [A]** Windows' restricted-token ACL backend is expected to report `enforcement: partial`; Linux bwrap/Landlock can report `full` for filesystem effects where the backend is present. If the required backend is missing, the provider must raise `SandboxUnavailableError` (`src/domain/errors.ts:170-176`) rather than silently fall back to `local-process`.
8. **Recommended default posture. [A]** Keep Docker as the default through the migration. Ship native behind `sandbox.kind: native`, first as an acknowledged `danger-full-access` development mode, then with OS confinement. Switch the default per platform only after the acceptance gates in section 9 pass. Docker remains the reference oracle and the fallback for macOS and for any unsupported native policy.

---

## 2. Complete Docker dependency inventory

Counts below are literal `docker|container` matches in the cited file at `595e8b6`; a file can match both terms. Counts are an inventory aid, not a measure of coupling. Semantic modules with no literal match are listed separately.

### 2.1 Source modules with a literal Docker/container reference (37 files)

| # | File | Matches | Docker role / why it is coupled |
|---|---|---:|---|
| 1 | `src/sandbox/docker.ts` | 75 | Concrete `DockerSandboxManager`: probe, hardened `docker create` argv, create/start/exec/status/inspect/stop/remove. Core. |
| 2 | `src/cli/commands/run.ts` | 66 | `prepareContainerMode`, `containerAdapterFor`, container bridge binding, run dispatch. Core. |
| 3 | `src/sandbox/muse-containers.ts` | 59 | Per-Muse container ensure/reuse/stale-replace, host gateway, `upsertSandbox`. Core. |
| 4 | `src/terminal/manager.ts` | 55 | tmux commands executed through `SandboxManager.exec` (inside the container). Core terminal transport. |
| 5 | `src/engines/docker-exec.ts` | 49 | `docker exec -i` ACP spawn, env name-only pass-through, host-to-container path mapping, `XDG_*` rewrites. Core engine transport. |
| 6 | `src/sandbox/image.ts` | 32 | Worker image build/probe/record, `base` vs `engines` profile readiness. Core provisioning. |
| 7 | `src/sandbox/types.ts` | 30 | `SandboxManager`/`SandboxSpec`, mount/env/network contract, deterministic container names, labels, unavailable fix. Core contract. |
| 8 | `src/cli/commands/muse-provision.ts` | 27 | Container mount construction (`/pluton/...`) and shared provision helper. Core. |
| 9 | `src/cli/commands/approvals.ts` | 27 | Provisions a newly approved specialist Muse's container during a live docker-mode run. Conditional core. |
| 10 | `src/cli/commands/doctor.ts` | 26 | Docker CLI/daemon checks, sandbox probe, worker-image checks, in-image tmux check. Diagnostic surface. |
| 11 | `src/server/static-assets.ts` | 26 | SPA UI copy/status that describes worker containers. UI surface, not execution. |
| 12 | `src/cli/commands/chat.ts` | 16 | CLI chat container preparation, container adapter, bridge host binding. Core. |
| 13 | `src/terminal/attach.ts` | 16 | `docker exec -it ... tmux attach-session`; attach spawn and error mapping. Core terminal transport. |
| 14 | `src/store/store.ts` | 15 | `sandboxes`/`terminals` persistence and strict `rowToSandbox` kind validation. Core data. |
| 15 | `src/sandbox/user-mapping.ts` | 14 | Container uid/gid selection (`PLUTON_CONTAINER_USER`, host detection, non-root guard). Core identity. |
| 16 | `src/cli/commands/attach.ts` | 14 | Resolves the Muse container and terminal session; refuses `local-process`. Core command. |
| 17 | `src/cli/main.ts` | 13 | `sandbox`, `run`, `chat`, `attach` command surface and descriptions. Core interface. |
| 18 | `src/sandbox/local-process.ts` | 11 | The unconfined host alternative; not Docker, but defines the current degraded mode. Contrast. |
| 19 | `src/terminal/types.ts` | 11 | Terminal contract explicitly defined as tmux-in-container. Core contract. |
| 20 | `src/orchestrator/supervisor.ts` | 4 | Only comments mention containers; the supervisor uses `adapterFor` and is otherwise substrate-agnostic. Shared seam. |
| 21 | `src/engines/registry.ts` | 4 | `EngineCreateOptions` carries the injectable spawn/binary/platform seams used by container mode. Shared. |
| 22 | `src/sandbox/factory.ts` | 3 | Config-driven selection between Docker and acknowledged local-process. Core selection. |
| 23 | `src/engines/opencode/adapter.ts` | 3 | Host/container adapter options and binary resolution boundary. Shared. |
| 24 | `src/config/schema.ts` | 3 | `sandbox.kind`, `sandbox.image`, `local_process_acknowledged`, runtime limits/network. Core config. |
| 25 | `src/domain/models.ts` | 3 | `SandboxRecord.kind` is a closed union of `'docker'` and `'local-process'`. Core data contract. |
| 26 | `src/tools/http-transport.ts` | 2 | Tool bridge bind address; loopback default, deliberately changed to `0.0.0.0` by container callers. Conditional security surface. |
| 27 | `src/store/migrations.ts` | 2 | Schema v2 tables `sandboxes`/`terminals`; current schema version 7. Core data. |
| 28 | `src/engines/qwen/adapter.ts` | 2 | Same injectable adapter options as OpenCode. Shared. |
| 29 | `src/domain/errors.ts` | 2 | `SandboxUnavailableError` and terminal errors used by the Docker path. Shared error contract. |
| 30 | `src/cli/commands/sandbox.ts` | 2 | `sandbox probe` / `sandbox build-image` command implementations. Core command. |
| 31 | `src/chat/session.ts` | 2 | Chat session mode/status labels; no direct container lifecycle. UI/chat surface. |
| 32 | `src/domain/ids.ts` | 1 | Slug generation feeds deterministic container names. Shared utility. |
| 33 | `src/util/exec.ts` | 1 | Host subprocess runner used by tests and by Docker CLI invocation; the native provider must not inherit its default env behavior. Shared. |
| 34 | `src/engines/approval.ts` | 1 | `engineAdapterForMuse` accepts the container-mode pins. Shared seam. |
| 35 | `src/server/routes.ts` | 1 | Server comments mention containers, but SPA chat uses host adapters and server runs use the container run path. Mixed; see GAP-01. |
| 36 | `src/engines/acp/client.ts` | 1 | `defaultSpawn` comment cites `docker exec` wrapping; actual transport is substrate-neutral. Shared seam. |
| 37 | `src/engines/mock/adapter.ts` | 1 | Test/dev adapter comment. Test surface. |

### 2.2 Semantically Docker-dependent modules with no literal match

| File | Why it matters |
|---|---|
| `src/verify/runner.ts` | Executes verification checks on the host via `util/exec.run` (`:141`); no sandbox provider is involved. This is an execution path that a native migration must absorb, and a Docker-mode parity gap today. |
| `src/workspace/manager.ts` | Creates host-side per-task `git clone --local` checkouts (`:12-17`, `:158-166`); the Docker path then bind-mounts the workspaces root. Native uses the same checkouts with identity path mapping. |
| `src/config/load.ts` | Defines `.pluton/engine-homes` and `.pluton/workspaces` roots (`:105-111`) that both providers must preserve. |
| `docker/worker/Dockerfile` | The only pinned engine/toolchain image: tmux, git, node, OpenCode 2.0.31, Qwen 0.25.2, user `10001` (`:20-60`). Native has no equivalent pinning artifact yet. |
| `templates/teams/{full-stack,bugfix,repository-analysis}.yaml` | All three templates set `sandbox.kind: docker` (`:27`, `:20`, `:19` respectively); template compatibility must survive a new enum value. |
| `.github/workflows/ci.yml` | `e2e-docker` job builds `pluton-worker:local` and runs the opt-in E2E suite (`.github/workflows/ci.yml:52-76`). |
| `package.json` | Publishes the `docker/` directory (`package.json:13-16`); removing or moving it is a packaging change. |
| `scripts/lib/release-gate.mjs` | Requires `docker/worker/Dockerfile` in the `npm pack` output (`:15`); the release gate must be extended, not bypassed, for native. |

### 2.3 Commands and API surfaces

| Surface | Path | Execution substrate | Evidence / notes |
|---|---|---|---|
| `pluton run` | `src/cli/commands/run.ts:593-686` | Docker when `sandbox.kind: docker`; host when acknowledged `local-process` | `prepareContainerMode` at `:226-290`; `containerContexts` selection at `:615-630`; supervisor adapter at `:343-347`. |
| `pluton chat` (CLI) | `src/cli/commands/chat.ts:174-189` | Docker when configured; host when acknowledged local-process | Container adapter is chosen before the TUI starts; bridge binds `0.0.0.0` for Docker (`:281-293`). |
| `pluton attach` | `src/cli/commands/attach.ts:63-110` | Docker only | `attachToMuseTerminal` refuses `local-process` with the exact message (`src/terminal/attach.ts:81-87`); uses `docker exec -it` (`:30-42`). |
| `pluton sandbox probe` | `src/cli/commands/sandbox.ts:30-89` | Docker (or local-process report) | Probes Docker and worker image; local-process emits the unconfined warning. |
| `pluton sandbox build-image` | `src/cli/main.ts:548-578`; `src/sandbox/image.ts:254-289` | Docker | Builds the worker image and records profile/image ID in `.pluton/state/worker-image.json`. |
| `pluton doctor` | `src/cli/commands/doctor.ts:72-99`, `:208-289` | Docker checks; host engine checks | Checks Docker CLI/daemon, sandbox probe, worker image, and in-image tmux; engine discovery remains host-side (`:148-196`). |
| `pluton approvals approve/deny` | `src/cli/commands/approvals.ts:254-305`, `:307-320` | Docker for an approved `muse.create` during a live docker run | `applyMuseCreate` explicitly provisions the specialist's container only for live docker mode. |
| `pluton app` / server `run.start` | `src/server/routes.ts:1115-1121`; `src/cli/commands/run.ts:593` | Docker via the run path | The operator tool starts a background run through `startRunInBackground`, which reuses `runRun`. |
| SPA/server chat | `src/server/routes.ts:1292-1333`, `:1202-1235` | **Host, unconditionally** | `engineAdapterForMuse(muse)` and `startSession({ workdir: rootDir, env: {} })`; no `prepareContainerMode` or `containerAdapterFor` appears under `src/server/`. **GAP-01.** |
| Server verify | `src/server/routes.ts:559-568` | Host | Calls `runVerificationChecks` with the host workspace path. |
| `pluton verify` | `src/cli/main.ts:797-810`; `src/verify/runner.ts:141` | Host | Check commands run with `util/exec.run` at a host `cwd`; no sandbox. |
| `pluton status/task/graph` | `src/cli/main.ts` | None | Read-only store queries; no execution. |
| `pluton muse create` | `src/cli/main.ts` | Host config/store only | The approved `muse.create` proposal may provision a container via the approvals path. |
| `pluton mcp serve` | `src/cli/main.ts`; `src/tools/mcp-server.ts` | None (external client executes) | Exposes tools over stdio; Pluton does not launch the engine. Out of scope for provider migration. |
| `pluton integrate` | `src/cli/main.ts` | Host git | No engine/container execution. |

**GAP-01, stated plainly.** The SPA is not running engines in the Muse's Docker container. `src/server/routes.ts:1292` constructs `engineAdapterForMuse(muse)` and `:1320` starts a session with the project root as workdir. The server's tool bridge is created with the default loopback bind (`src/server/routes.ts:1043-1056`; default at `src/tools/http-transport.ts:26-28`), which is consistent with a host engine. A native migration that only changes `pluton run` would leave this bypass untouched. Fixing it is part of the target design (section 9, Phase 6), and it is a security finding independent of the native work.

### 2.4 Configuration keys and environment variables

| Key / variable | Default | Where consumed | Native implication |
|---|---|---|---|
| `sandbox.kind` | `docker` | `src/config/schema.ts:91-100`; `src/sandbox/factory.ts:12-23` | Must widen to a three-value enum (`docker`, `native`, `local-process`); no silent fallback. |
| `sandbox.image` | unset (default tag) | `src/cli/commands/run.ts:240`; `src/sandbox/image.ts` | Docker-only. Native should warn if set, not pretend it applies. |
| `sandbox.local_process_acknowledged` | `false` | `src/config/schema.ts:96-97`; `src/sandbox/factory.ts:13-20` | Retain for backward compatibility; deprecate in favor of a native `danger-full-access` acknowledgement. |
| `runtime.network_policy` | `restricted` | `src/config/schema.ts:63-69`; `src/cli/commands/run.ts:261-265` | Docker `restricted` is a bridge, not an egress filter (`docs/PLUTON_ARCHITECTURE.md:107`); `docs/SECURITY.md:143-147` documents the binding behavior. Native must enforce `none` or fail closed; it cannot silently map `restricted` to host networking. |
| `runtime.internal_network_name` | unset | `src/config/schema.ts:66-69`; `src/cli/commands/run.ts:262-265` | Docker-only; ignored/refused under native. |
| `runtime.default_cpu_limit` | `2` | `src/config/schema.ts:58`; `src/cli/commands/run.ts:274` | Native maps to cgroups/Job Object limits; may be `partial`. |
| `runtime.default_memory_mb` | `4096` | `src/config/schema.ts:59`; `src/cli/commands/run.ts:275` | Same. |
| `muses.<id>.network_policy` | inherits runtime | `src/config/schema.ts:34-35`; `src/cli/commands/run.ts:260-261` | Native per-session policy input. |
| `muses.<id>.limits.{cpu,memory_mb,pids}` | unset | Accepted at `src/config/schema.ts:36-43` | **Not consumed by container provisioning.** Provisioning uses runtime defaults and `CONTAINER_PIDS_LIMIT` (`src/cli/commands/run.ts:273-277`; `src/cli/commands/approvals.ts:295-299`). Native should either honor per-Muse limits or reject the key; today it is config drift. |
| `PLUTON_CONTAINER_USER` | unset | `src/sandbox/user-mapping.ts:33-41` | Docker uid/gid only; irrelevant to native (the session runs as the invoking OS user). |
| `sandbox.container_user` | documented, absent | `docs/LINUX_BIND_MOUNT_VALIDATION.md:70-72`; absent from strict `sandboxConfigSchema` (`src/config/schema.ts:91-100`) | Documentation drift. A config using it fails schema validation today. Native should not carry this key forward. |
| `PLUTON_E2E_DOCKER` | unset | `tests/e2e/*`; `.github/workflows/ci.yml:73-76` | Test opt-in; native needs its own opt-in gate. |
| `PLUTON_OPENCODE_BIN` / `PLUTON_QWEN_BIN` | discovery | `src/engines/opencode/discover.ts:12-16`; `src/engines/qwen/discover.ts:14-19` | These are the native binary overrides; the Docker path pins in-image binaries instead. |
| `PLUTON_ENGINES` | `0` | `docker/worker/Dockerfile:30-42` | Build arg for the Docker `engines` profile; no native equivalent. |

### 2.5 Lifecycle: create, reuse, start, stop, remove, persist

**Container lifecycle is per Muse, not per run. [F]** `ensureMuseContainer` computes a deterministic name (`sandboxContainerName`, `src/sandbox/types.ts:113-122`), reads status, and reuses a running/stopped container only when image ID, user, host-gateway entry, and mount set still match (`src/sandbox/muse-containers.ts:69-102`, `:141-151`). A stale Pluton-owned container is removed and recreated, never adopted (`:97-101`). Reuse calls `start`, which revalidates the managed label first (`src/sandbox/docker.ts:180-188`, `:270-287`). Creation passes through the hardened argv builder (`src/sandbox/docker.ts:68-107`) and records `upsertSandbox` (`src/sandbox/muse-containers.ts:128-137`).

**Creation triggers.**
- `pluton run`: `prepareContainerMode` before the run row exists, so daemon/image failure fails closed with no started run (`src/cli/commands/run.ts:219-250`, `:609-630`).
- `pluton chat` (CLI): same helper for the selected Muse (`src/cli/commands/chat.ts:174-189`).
- Approved `muse.create`: `provisionApprovedMuse` during a live docker-mode run (`src/cli/commands/approvals.ts:254-305`, `:307-320`).

**No production stop/cleanup path exists. [F]** `DockerSandboxManager.stop()` is implemented (`src/sandbox/docker.ts:289-295`) but has no production caller. The only production `remove()` call is stale replacement (`src/sandbox/muse-containers.ts:101`). There is no `pluton sandbox stop`, `sandbox rm`, or orphan-reaping command: `src/cli/main.ts:524-578` exposes only `probe` and `build-image`; `doctor` probes but does not enumerate or reap containers (`src/cli/commands/doctor.ts:208-289`). Consequently:
- A container persists after a run or chat exits. This is the intended container-per-Muse reuse model, but it also means an idle container and its mounted engine home remain until manually removed. [I]
- A crashed process or failed run does not stop its container. [I]
- ADR-0004's "Identity & cleanup" bullet (`docs/adr/0004-sandbox-container-model.md:24-27`) is only partially realized: label-guarded stop/remove exist, but there is no run-end or orphan cleanup. [F]
- `sandbox stop` is a documented capability in spirit but not a CLI surface; if an operator needs cleanup today, they must use Docker directly. [F]

**Persistence. [F]** One `sandboxes` row per `(project, muse)` via a NULL-safe unique index; the atomic upsert keeps `id`/`created_by`/`created_at` stable (`src/store/store.ts:835-872`; schema at `src/store/migrations.ts:135-147`). `rowToSandbox` accepts only `docker` and `local-process` (`src/store/store.ts:1937-1959`), and `SandboxRecord.kind` is a closed union (`src/domain/models.ts:172-184`). Any native row therefore requires a code change before it can be written or read. This is a hard gate for Phase 2.

**Terminal persistence. [F]** `terminals` has one row per `(project, muse)` (`src/store/migrations.ts:148-157`; `src/store/store.ts:923-955`), but the row is written **only by `pluton attach`** (`src/cli/commands/attach.ts:104-110`). Run/chat engine sessions do not create terminal rows. `tmux_session_name` is `NOT NULL`; native terminal work would need a schema change or a compatibility value.

**Image lifecycle. [F]** `sandbox build-image` builds `docker/worker/Dockerfile` with optional `PLUTON_ENGINES=1`, proves tmux/git/node and (for `engines`) both CLIs, and writes `.pluton/state/worker-image.json` (`src/sandbox/image.ts:254-289`; Dockerfile at `docker/worker/Dockerfile:30-60`). Container dispatch requires the `engines` profile and a matching build record; an unrecorded image is refused (`src/sandbox/image.ts:140-184`; `src/cli/commands/run.ts:240-250`). Native has no image build/probe equivalent; its readiness gate must instead prove host binary discovery + confinement backend.

### 2.6 Test inventory

The following 27 files under `tests/` reference Docker/containers (26 test files plus one helper); `it(` counts are from the file at HEAD and include tests that exercise more than Docker. This is the current evidence base, not a claim of complete coverage.

| Test file | `it(` count | What it covers / why it is Docker-relevant |
|---|---:|---|
| `tests/e2e/docker-sandbox.e2e.test.ts` | 5 | Real Docker sandbox lifecycle/exec; opt-in via `PLUTON_E2E_DOCKER=1`. |
| `tests/e2e/linux-bind-mount.e2e.test.ts` | 3 | Real Linux bind-mount/uid assertions; collected but skipped unless Linux + `PLUTON_E2E_DOCKER=1`; **NOT RUN** per `docs/LINUX_BIND_MOUNT_VALIDATION.md:1-15`. |
| `tests/helpers/fake-sandbox.ts` | 0 | In-memory `SandboxManager` double used by unit/integration tests; encodes expected call sequences. |
| `tests/integration/cli-approvals.test.ts` | 17 | Approval decisions and specialist container provisioning. |
| `tests/integration/cli-attach.test.ts` | 7 | Attach resolution, refusal for local-process, target argv. |
| `tests/integration/cli-chat-slash-expanded.test.ts` | 2 | Chat slash-command expansion in container-mode setup. |
| `tests/integration/cli-chat.test.ts` | 10 | CLI chat container preparation and adapter selection. |
| `tests/integration/cli-run.test.ts` | 8 | `pluton run` container mode, readiness failure, bridge selection. |
| `tests/integration/server-api.test.ts` | 12 | Server run/API paths; does not currently prove SPA chat confinement. |
| `tests/integration/smoke-docker-plan-live.test.ts` | 1 | Live/plan smoke for Docker. |
| `tests/integration/spa-ui.test.ts` | 27 | SPA behavior/build provisioning copy; not engine confinement. |
| `tests/integration/supervisor.test.ts` | 50 | Supervisor seams with fake adapters/sandboxes; substrate-agnostic by construction. |
| `tests/ui/ship-inspector-sidebar.test.ts` | 3 | UI container/status labels. |
| `tests/unit/attach.test.ts` | 10 | `buildAttachArgv`, exact tmux targets, spawn errors. |
| `tests/unit/ci-workflow.test.ts` | 5 | CI includes the Docker E2E job. |
| `tests/unit/config.test.ts` | 14 | `sandbox.kind`/acknowledgement and runtime config validation. |
| `tests/unit/container-user-mapping.test.ts` | 8 | `PLUTON_CONTAINER_USER`, host uid detection, non-root refusal. |
| `tests/unit/docker-exec.test.ts` | 9 | `docker exec` argv, env names, path mapping, `XDG_*` rewrites. |
| `tests/unit/muse-containers.test.ts` | 10 | Reuse/stale replacement, labels, gateway, upsert. |
| `tests/unit/muse-network-policy.test.ts` | 5 | Per-Muse network policy and custom network selection. |
| `tests/unit/release-gate.test.ts` | 26 | Release-gate behavior including required `docker/worker/Dockerfile`. |
| `tests/unit/sandbox-image.test.ts` | 24 | Image probe/record/profile readiness and drift. |
| `tests/unit/sandbox.test.ts` | 18 | Hardened create argv, validation, probe/status/exec/stop/remove. |
| `tests/unit/store.test.ts` | 44 | Store behavior including sandbox/terminal rows (subset). |
| `tests/unit/terminal.test.ts` | 32 | tmux manager commands, exact targets, failure classification. |
| `tests/unit/tool-http.test.ts` | 7 | HTTP transport auth/binding behavior. |
| `tests/unit/tui-render.test.ts` | 16 | TUI labels/status; includes container-mode copy. |

**Coverage character. [F]** Docker tests are predominantly argv/builder and fake-runner tests; the real lifecycle tests are opt-in E2E. `PLUTON_E2E_DOCKER` is set only in the CI `e2e-docker` job (`.github/workflows/ci.yml:52-76`). The Linux bind-mount E2E is explicitly **NOT RUN** (`docs/LINUX_BIND_MOUNT_VALIDATION.md:1-15`). There are **zero** native-provider tests, zero Windows restricted-token/Job Object tests, zero ConPTY tests, and zero Linux bwrap/Landlock tests. [F]

### 2.7 Documentation references (38 Markdown files in the audit working tree, excluding this report)

Counts are literal `docker|container` matches in files present during the audit (including the prior untracked `docs/audits/source-parity-report.md`); this report is not counted. "Primary" means it states a contract or tested behavior; "historical" means it records a past plan/smoke and must not be read as current proof. The prior `docs/audits/source-parity-report.md` is untouched by this report.

| Count | File | Role |
|---:|---|---|
| 59 | `docs/LINUX_BIND_MOUNT_VALIDATION.md` | Linux bind-mount/uid validation procedure and assertion table; explicitly NOT RUN. |
| 56 | `docs/delivery-report.md` | Historical delivery summary; Docker-mode evidence and caveats. |
| 52 | `docs/superpowers/plans/2026-10-17-attach-integrate-approvals.md` | Historical implementation plan for attach/integrate/approvals. |
| 52 | `docs/smoke-live-run.md` | Live smoke evidence: host-mode run with no Docker, and a container-mode run. |
| 50 | `docs/superpowers/plans/2026-10-16-pluton-run-wiring.md` | Historical run-wiring plan. |
| 31 | `docs/ROADMAP.md` | Historical roadmap; contains container milestones, not a current guarantee. |
| 24 | `docs/PLUTON_RELEASE_READINESS_2026-10-20.md` | Release-readiness snapshot; must be re-read against HEAD. |
| 23 | `docs/adr/0004-sandbox-container-model.md` | Accepted sandbox contract: non-root, cap-drop, env/mount allowlists, fail-closed. |
| 21 | `docs/PLUTON_FINAL_RELEASE_GATES_2026-10-20.md` | Historical release gates; Docker-heavy acceptance claims. |
| 17 | `docs/adr/0010-windows-wsl2-boundary.md` | Accepted Windows/WSL2 boundary; native Windows tmux is not supported. |
| 17 | `docs/SECURITY.md` | Security guarantees and the known-gaps list (bridge bind, no egress filter, Linux ownership NOT RUN). |
| 17 | `docs/superpowers/plans/2026-10-17-tui-chat.md` | Historical TUI chat plan; container adapter/bridge work. |
| 16 | `docs/audits/source-parity-report.md` | Prior untracked parity audit (dsh vs PLUTON); not overwritten. |
| 15 | `docs/reverse-engineering/engine-mcp-integration.md` | Reverse-engineering notes on engine/MCP integration. |
| 13 | `docs/RELEASE.md` | Platform support matrix; Docker Desktop evidence and native-engine caveat (`:100-110`). |
| 11 | `docs/PLUTON_ARCHITECTURE.md` | Architecture map, engine layer, tool bridge, sandbox summary. |
| 7 | `docs/adr/0005-checkout-terminal-lifecycle.md` | Checkout/terminal lifecycle decisions; tmux persistence. |
| 7 | `docs/reverse-engineering/architecture-map.md` | Architecture comparison map. |
| 5 | `docs/reverse-engineering/comparison-matrix.md` | Comparison matrix. |
| 5 | `docs/reverse-engineering/implementation-decisions.md` | Implementation decision notes. |
| 5 | `docs/PLUTON_BASELINE_REPORT.md` | Baseline/reference report. |
| 5 | `docs/reverse-engineering/openmausbot-mcp-workspaces-tests-licensing.md` | Reference notes. |
| 4 | `docs/research-comparison.md` | Research comparison. |
| 4 | `docs/superpowers/specs/2026-10-20-ship-workers-design.md` | Ship-worker design (container context). |
| 4 | `docs/superpowers/plans/2026-10-20-ship-workers-plan.md` | Ship-worker plan. |
| 4 | `docs/PLUTON_TUI_REFINEMENT_PROMPT.md` | TUI refinement prompt. |
| 3 | `docs/superpowers/plans/2026-10-18-parallel-orchestration-conformance.md` | Parallel-orchestration plan. |
| 3 | `docs/superpowers/plans/2026-10-17-multi-agent-reliability.md` | Multi-agent reliability plan. |
| 3 | `docs/adr/0008-model-auth-secret-storage.md` | Secret storage/auth decisions; env allowlist context. |
| 3 | `docs/PLUTON_FEATURE_PARITY.md` | Feature-parity notes. |
| 2 | `docs/adr/0012-interactive-chat-tui.md` | Interactive chat/TUI decisions. |
| 2 | `docs/PLUTON_IMPLEMENTATION_ROADMAP.md` | Historical implementation roadmap. |
| 1 | `docs/tui-refinement.tdd.md` | TUI test-first notes. |
| 1 | `docs/tui-audit.md` | TUI audit. |
| 1 | `docs/adr/0014-shared-desktop-browser-architecture.md` | Server/desktop architecture; container reference incidental. |
| 1 | `docs/adr/0007-dynamic-delegation-policy.md` | Delegation policy; container reference incidental. |
| 1 | `docs/feature-completion-audit.md` | Feature audit; container reference incidental. |
| 1 | `docs/adr/0001-language-runtime-packaging.md` | Runtime/packaging; container reference incidental. |

**Primary-document contradictions to resolve in the migration.**
- `docs/adr/0004-sandbox-container-model.md:46-50` explicitly rejected "host execution with deny-lists" because OS isolation is required. A native provider that merely promotes `local-process` would contradict this ADR. Native must add real OS confinement.
- `docs/SECURITY.md:140-156` documents Docker's residual gaps: no custom seccomp/AppArmor and the bridge on `0.0.0.0`; `docs/PLUTON_ARCHITECTURE.md:107` records that `restricted` is a bridge with DNS, not an egress filter. Native must not claim to fix these by assertion; it needs per-backend evidence.
- `docs/SECURITY.md:157-170` marks Linux bind-mount ownership **NOT RUN**. Native Linux avoids container uid mapping but inherits host file permission semantics; that is not automatically safer, and must be tested.
- `docs/RELEASE.md:100-110` records Docker Desktop on Windows as the tested path and native engines as unverified. The migration must update this matrix with measured results, not with design intent.
- `docs/smoke-live-run.md:5-9` proves a **host-mode** run with no Docker; it is evidence that ACP + supervisor + bridge work on the host, not evidence of confinement.
- `docs/PLUTON_ARCHITECTURE.md:107` calls `network_policy: restricted` a bridge with DNS, not an egress filter. Native policy must use the same honest wording.

### 2.8 Packaging, CI, and image build

| Artifact | Coupling | Evidence |
|---|---|---|
| `docker/worker/Dockerfile` | Pins tmux/git/node and engine CLIs; creates uid/gid 10001; `CMD sleep infinity`. | `docker/worker/Dockerfile:20-62`. |
| `package.json` `files` | Publishes `docker/`. | `package.json:13-16`. |
| Release gate | Requires `docker/worker/Dockerfile` in the packed tarball. | `scripts/lib/release-gate.mjs:9-20`. |
| CI `e2e-docker` | Builds `pluton-worker:local` and runs opt-in E2E on `ubuntu-latest`. | `.github/workflows/ci.yml:52-76`. |
| Team templates | All set `kind: docker`. | `templates/teams/full-stack.yaml:27`; `bugfix.yaml:20`; `repository-analysis.yaml:19`. |
| `sandbox build-image` | Actual image build entry point; there is no `scripts/build-worker-image.*` despite the schema comment at `src/config/schema.ts:94`. | `src/cli/main.ts:548-578`; `src/sandbox/image.ts:254-289`. |

---

## 3. Current execution call graph

### 3.1 `pluton run` (Docker mode)

```
pluton run --goal ...
  -> runRun (src/cli/commands/run.ts:593)
     -> createSandboxManager(config) (src/sandbox/factory.ts:12)
     -> prepareContainerMode (run.ts:226)
        -> manager.probe()                         Docker daemon check
        -> WorkerImageManager.probe(rootDir, tag)  image + build record
        -> dispatchReadiness(requireEngines=true)  refuses base/unrecorded image
        -> for each enabled Muse:
             museContainerMounts (muse-provision.ts:37-45)
             provisionMuseContainer -> ensureMuseContainer (muse-containers.ts:69)
                -> status -> inspect -> start (reuse)
                |  or remove(stale) -> create -> start
                -> store.upsertSandbox(kind='docker', state='running')
             DockerExecContext {containerName, mounts, env:{}}
     -> ToolHttpServer(host: 0.0.0.0) (run.ts:674-681)
        bridgeUrl = http://host.docker.internal:<port>/mcp (run.ts:683-686)
     -> createRunSupervisor (run.ts:326; adapterFor at :343-347)
        -> RunSupervisor.runToCompletion
           -> runManagerSession (supervisor.ts:1350-1393)
              -> adapterFor(manager, {isolatedCheckout:false})
              -> containerAdapterFor (run.ts:299-324)
              -> AcpClient -> dockerExecSpawn -> docker exec -i ... <engine> acp
           -> dispatch loop (supervisor.ts:909-960)
              -> GitWorkspaceManager.ensureTaskCheckout (host clone)
              -> adapterFor(worker, {isolatedCheckout})
              -> startSession(workdir = host checkout, configDir = engine home)
              -> AcpClient -> dockerExecSpawn
                 -> map host cwd to /pluton/workspaces/...
                 -> docker exec -i -w <container-cwd> -e NAME ... <container> <engine> acp
              -> engine calls Pluton tools at host.docker.internal:<bridge>
           -> task -> verifying
     -> verification (separate `pluton verify` or server route)
        -> runVerificationChecks -> util/exec.run(check, cwd=host workspace)
```

**Step citations.**
- Run entry and container-mode branch: `src/cli/commands/run.ts:593-630`.
- Provisioning loop and limits: `:240-289`.
- Container adapter pins: `:299-324`.
- Bridge host and URL: `:672-686`.
- Supervisor adapter selection: `:343-347`; supervisor defaults at `src/orchestrator/supervisor.ts:460-464`.
- Manager session: `src/orchestrator/supervisor.ts:1350-1393`.
- Task checkout and session: `:941-960`.
- ACP default spawn: `src/engines/acp/client.ts:42-48`, `:158-163`.
- `docker exec` argv: `src/engines/docker-exec.ts:143-169`.
- Host clone: `src/workspace/manager.ts:12-17`, `:158-166`.
- Verification: `src/verify/runner.ts:112-154`.

### 3.2 `pluton chat` (CLI)

```
pluton chat <muse>
  -> chatRun / TUI
     -> if sandbox.kind == docker:
          createSandboxManager -> prepareContainerMode(museIds:[muse])
          adapter = containerAdapterFor(muse, contexts, ...)
     -> else (acknowledged local-process):
          adapter = engineAdapterForMuse(muse)          host spawn
     -> ToolHttpServer(host = docker ? 0.0.0.0 : 127.0.0.1)
     -> bridge URL = docker ? host.docker.internal : loopback
     -> ChatSession(adapter).start/run
```

Citations: `src/cli/commands/chat.ts:174-189` (adapter choice), `:281-301` (bridge), `src/engines/approval.ts:113-134` (adapter factory), `src/engines/acp/client.ts:42-48` (host spawn).

### 3.3 Terminal path

```
pluton attach <muse>
  -> attachMuse (cli/commands/attach.ts:63)
     -> resolve Muse -> target {containerName, tmuxSessionName}
     -> TmuxTerminalManager(createSandboxManager(config))
     -> attachToMuseTerminal
        -> if sandbox.kind == local-process: ValidationError (exact refusal)
        -> buildAttachArgv:
             docker exec -it <container> tmux attach-session -t =<session>[:=<window>]
        -> ensureSession / ensureWindow via sandbox.exec(container, ['tmux', ...])
        -> spawnAttach = inheritStdioSpawn (interactive only)
     -> store.upsertTerminal(...)
```

Citations: `src/cli/commands/attach.ts:76-110`; `src/terminal/attach.ts:30-42`, `:81-118`; `src/terminal/manager.ts:87-90`, `:101-125`; `src/terminal/types.ts:1-8`.

**Terminal semantics. [F]** tmux is explicitly terminal persistence, not a security boundary (`README.md:29-30`; `docs/PLUTON_ARCHITECTURE.md:109`). The operator's terminal is trusted (`docs/SECURITY.md:148-149`). Native terminal parity cannot reuse `docker exec -it`; it needs a PTY/ConPTY transport or an explicit reduction in scope.

### 3.4 Server / SPA path (mixed)

```
Server request
  -> /api/... run.start (routes.ts:1115)
     -> startRunInBackground -> runRun -> Docker container path (same as 3.1)
  -> /api/... chat turn (routes.ts:1270)
     -> engineAdapterForMuse(muse) (routes.ts:1292)
     -> adapter.startSession({workdir: rootDir, env: {}}) (routes.ts:1320)
     -> HOST engine process; no container, no sandbox policy
     -> tool bridge from ensureToolHttp (loopback default; routes.ts:1043-1056)
  -> /api/... verify (routes.ts:559)
     -> runVerificationChecks -> util/exec.run on host
```

**Interpretation. [F]** Server-supervised *runs* use the container path; server *chat* does not. The two paths are not unified. This is both a Docker dependency asymmetry and a security gap: a user who configures `sandbox.kind: docker` can still get a host engine via the SPA. Native migration must either (a) route server chat through the same `ExecutionProvider` (preferred), or (b) explicitly label server chat as host-only and refuse to call it confined. Option (b) perpetuates the bypass and should not be the default.

### 3.5 `local-process` path

```
createSandboxManager(config)
  -> if kind == local-process && !local_process_acknowledged: ValidationError
  -> LocalProcessSandbox
       probe: available, warning
       create/start: no-op
       exec: util/exec.run(argv)
       inspect: null
       stop/remove: no-op
```

Citations: `src/sandbox/factory.ts:12-23`; `src/sandbox/local-process.ts:21-66`.

`runRun` still calls `createSandboxManager` (the acknowledgement gate) but then leaves `containerContexts` null, so `RunSupervisor` uses the default host adapter (`src/cli/commands/run.ts:615-630`; `src/orchestrator/supervisor.ts:460-461`). `pluton attach` refuses this mode (`src/terminal/attach.ts:81-87`). The local-process path is therefore the existing native execution precedent, but it has no confinement and no terminal.

### 3.6 Entry-point execution matrix

| Entry point | Engine process runs in | Bridge bind | Verified by tests? |
|---|---|---|---|
| CLI `run`, docker mode | Muse container via `docker exec` | `0.0.0.0` + `host.docker.internal` | Yes: argv/unit + opt-in Docker E2E; Linux host NOT RUN. |
| CLI `run`, local-process | Host | loopback | Host-mode live smoke (`docs/smoke-live-run.md:5-9`); no confinement. |
| CLI `chat`, docker mode | Muse container | `0.0.0.0` + `host.docker.internal` | Integration tests; no live Linux evidence. |
| CLI `chat`, local-process | Host | loopback | Host-mode smoke; no confinement. |
| CLI `attach` | tmux inside container | n/a | Unit + fake terminal tests; Docker E2E opt-in. |
| SPA chat | Host | loopback | **No confinement test; GAP-01.** |
| Server run | Muse container | `0.0.0.0` via run path | Integration tests; same Docker caveats. |
| `pluton verify` / server verify | Host | n/a | Unit/integration; not containerized. |

---

## 4. Preserve vs Docker-specific coupling matrix

The goal is to preserve the substrate-neutral 80% and replace only the container-specific 20%. The table classifies each concern; "Preserve" means the abstraction survives with a native implementation, "Replace" means the Docker mechanism is removed under native, and "Conditional" means the native provider must fail closed when the capability is unavailable.

| Concern | Today (Docker) | Docker-specific? | Native target | Enforcement / notes |
|---|---|---|---|---|
| Engine process spawn | `docker exec -i ... <engine> acp` via `dockerExecSpawn` (`src/engines/docker-exec.ts:143-169`) | Replace | `session.spawn` uses `child_process.spawn` / a confined argv | Full for process creation; kill-tree support is separate. |
| ACP transport | In-repo newline JSON-RPC over stdio (`src/engines/acp/client.ts`) | Preserve | Same client, injected host `spawnFn` | Full; already used by host-mode engine adapters. |
| Environment | Explicit allowlist; Docker passes `-e NAME` only (`src/engines/acp/env.ts:17-40`; `docker-exec.ts:146-164`) | Preserve the policy, replace transport | Sanitized env map + `envMode: 'explicit'`; never inherit full `process.env` | Full if enforced at spawn; `util/exec.run` currently merges full env by default (`src/util/exec.ts:43-46`), so native must not use that default. |
| Working directory | Host path mapped to container path (`mapHostPathToContainer`, `docker-exec.ts:110-119`; `containerAdapterFor`, `run.ts:319-321`) | Replace | Identity mapping (`mapWorkdir` = identity) | Full. |
| File mounts / FS boundary | Bind mounts; project root read-only for non-isolated policies (`muse-provision.ts:37-45`; `docker.ts:100-102`) | Replace | OS ACL (Windows) / bwrap-Landlock (Linux) over host paths | Full for workspace-write/read-only when backend present; partial/no on missing backend. |
| Process identity | Numeric non-root container user; uid/gid mapping (`src/sandbox/user-mapping.ts:33-76`) | Replace | Invoking OS user; refuse root for supervised native mode | Native cannot use `PLUTON_CONTAINER_USER`; no uid mapping. |
| Resource limits | Docker `--cpus`, `--memory`, `--pids-limit` (`docker.ts:86-91`) | Replace | Windows Job Objects; Linux cgroups v2 | `partial` where kernel/helper unavailable; fail closed only for policies that require a hard limit. |
| Network policy | Docker network (`none`/bridge/custom) (`docker.ts:94-99`; `run.ts:261-265`) | Replace | bwrap `--unshare-net`, Windows WFP/AppContainer or refusal | `none` can be full on Linux; `restricted` has no equivalent egress filter, so it must map to `none` or refuse, not to host networking. |
| Terminal | tmux inside the container via `SandboxManager.exec` (`src/terminal/manager.ts:87-90`) | Replace | ConPTY (Windows), PTY + optional tmux (Linux); or defer | Terminal is not a security boundary today (`README.md:29-30`). Native v1 may fail closed for attach. |
| Tool bridge | Per-session bearer token; container binds `0.0.0.0` and uses `host.docker.internal` (`run.ts:674-686`; `chat.ts:281-293`) | Replace transport | Loopback-only listener; native engine uses the same host | Full; removes SECURITY gap 8 for native. No `0.0.0.0` fallback. |
| Container reuse/labels | Deterministic name; managed labels; stale replacement (`muse-containers.ts:69-151`; `docker.ts:270-303`) | Replace | Logical session registry keyed by `(project, muse, policyHash)`; no container to reuse | Native sessions are processes, not persistent containers; provider should not pretend otherwise. |
| Worker image / engine pinning | Dockerfile pins OpenCode/Qwen; image record (`docker/worker/Dockerfile:30-60`; `src/sandbox/image.ts:254-289`) | Replace | Host binary discovery + version checks (`PLUTON_*_BIN`, `discover.ts`); no image | `partial`: host PATH can drift; doctor/version pinning is the only control. |
| Workspace checkout | Host `git clone --local` per task (`src/workspace/manager.ts:12-17`) | Preserve | Same manager; native process operates on the same host path | Full; this is already substrate-neutral. |
| Verification | Host `util/exec.run` at host cwd (`src/verify/runner.ts:141`) | Replace under native; already host under Docker | Run through `ExecutionProvider.exec` inside the task's confinement | Currently a Docker-mode parity gap; native must not repeat it. |
| Persistence | `sandboxes`/`terminals` rows; kind union (`src/domain/models.ts:172-195`) | Replace shape, preserve store | New provider/backend/enforcement fields; `kind='native'` | Schema v7 -> v8; old binaries cannot read v8 (section 10). |
| Diagnostics | `doctor` probes Docker/image/tmux (`src/cli/commands/doctor.ts:208-289`) | Replace probes | Probe native backend, engine binaries, ACL/Landlock, Job Objects/ConPTY | Must report `full`/`partial`/unavailable explicitly. |
| Approvals | Durable approvals + engine interactive channel; container-aware provisioning (`src/cli/commands/approvals.ts:254-305`) | Preserve, adapt | Same approval table/channel; execution policy is part of the approval scope | Fail-closed on unavailable answerer, matching existing behavior (`docs/SECURITY.md:130-139`). |

---

## 5. Target abstractions derived from dsh

### 5.1 The dsh pattern being adopted

dsh's execution world has one **service definition + provider + consumer** shape per family (`Y:\Setup\REA deepseek\03-model-tools-capabilities.md:205-207`). Its own cross-cutting summary states the goal directly: **one execution world** where fs/subprocess/sandbox seams are co-dependent, and **fail loud / fail closed** on unknowns (`04-interfaces-delivery-reference.md:518-519`). The kernel volume adds the provider property that matters here: capability seams are swappable without touching consumers, and a missing injected service fails at load, never silently (`01-kernel-and-composition.md:131-135`). The important properties for PLUTON are:

1. **One shared subprocess service.** `subprocess-local` owns spawn, supervision, and teardown; shell, terminal, tools, and LSP route through it (`03-model-tools-capabilities.md:223-226`). This is why one provider change moves the whole execution world.
2. **Policy-only sandbox seam.** `SandboxService.confine(argv, policy)` returns `ConfinedArgv` with `enforcement: full | partial`, denial signatures, and runner-failure rules (`03-model-tools-capabilities.md:266-281`). `danger-full-access` bypasses the sandbox entirely (`:279`).
3. **Fail-closed unavailability.** Missing sandbox -> `SANDBOX_UNAVAILABLE` refusal (`:280`). Denial vs runner failure is classified separately (`:281`).
4. **Backend per platform.** Linux bwrap -> Landlock fallback; Windows restricted-token ACL with `enforcement: partial` (`:285-289`).
5. **Escalation + approvals.** Read-only -> workspace-write -> danger-full-access, with denial markers and approval through `ctx.approval` (`:291-298`). Permission presets compose sandbox mode + approval policy (`:318-328`).
6. **PTY-backed terminals.** `ctx.terminals` is PTY-backed named sessions; subprocess owns ConPTY (`:223-231`).
7. **Provider registry pattern.** Subagents use a named provider registry and a continuity capability (`:441-447`). PLUTON's engine registry is already analogous; this is not a prerequisite for native execution.

### 5.2 Mapping to PLUTON

| dsh abstraction | dsh contract | PLUTON today | Target mapping |
|---|---|---|---|
| `ctx.subprocess` | One shared spawn/supervision/teardown service, node-pty/ConPTY (`:223-226`) | `util/exec.run` for one-shot; raw `child_process.spawn` in `AcpClient` (`src/util/exec.ts:34-59`; `src/engines/acp/client.ts:42-48`) | `ProcessService` inside the native provider: bounded one-shot exec + streaming spawn + kill-tree. `util/exec` stays the one-shot primitive but must support explicit env and tree kill. |
| `ctx.shell` | `ShellExecutor` resolves a spec then spawns through subprocess + sandbox (`:209-214`) | No generic shell seam; engine adapters spawn ACP; verification uses argv arrays | `ExecutionProvider.exec(session, argv, opts)` is the shell-equivalent. All argv arrays, never shell strings (existing config rule: `src/config/schema.ts:11-14`). |
| `ctx.sandbox` | `confine(argv, {mode, workspaceRoot, sessionId}) -> ConfinedArgv` (`:266-281`) | `SandboxManager` combines lifecycle + exec; no argv confinement | Split: `ConfinementProvider` implements the dsh contract for native; Docker `ConfinementProvider` is a no-op because the container is the boundary, but reports `full` for the mount policy and `partial` for egress. |
| `ctx.terminals` | PTY-backed named sessions (`:228-231`) | tmux-in-container; no host PTY (`src/terminal/types.ts:1-8`) | `TerminalProvider`; native v1 may expose PTY sessions without cross-process attach. |
| `ctx.approval` | One-shot request; missing answerer -> deny; durable events (`:310-315`) | Durable approvals + interactive engine channel (`src/engines/interactive-approval.ts`; `docs/SECURITY.md:130-139`) | Reuse. Add execution policy to approval scope and denial/escalation events. |
| `ctx.permissionPresets` | Compose sandbox mode + approval policy (`:318-328`) | `approval_mode` + `workspace_policy` + sandbox config are separate | Add native policy presets: `read-only+ask`, `workspace-write+ask`, `danger-full-access+never`; do not silently widen one knob when the other changes. |
| `ctx.sessionPersistence` | Version-gated write handle, exclusive writer, fail-closed unknown event vocabulary, flush/close (`02-agent-session-persistence.md:224-237`, `:248-253`) | SQLite store + events; schema v7; unknown sandbox kind throws (`src/store/store.ts:1937-1941`) | Persist execution sessions/events with the same discipline: unknown provider/backend/enforcement values refuse, never default. |
| `ctx.subagents` provider registry | Named providers, continuable children (`:437-447`) | Engine registry + adapter factory (`src/engines/registry.ts`; `approval.ts:113-134`) | Not required for this migration; keep as a future alignment point. |

### 5.3 What not to copy

- **Do not copy dsh's `danger-full-access` as a normal default.** PLUTON's `local-process` acknowledgement exists because host execution is not isolation (`src/sandbox/factory.ts:13-20`; `docs/adr/0004-sandbox-container-model.md:46-50`). Native `danger-full-access` must remain a separately acknowledged dev mode.
- **Do not make confinement a boolean.** dsh's `full`/`partial` is load-bearing. Windows ACL enforcement is expected to be partial; the UI/doctor/JSON must say so, per platform and per policy.
- **Do not put container lifecycle inside the confinement seam.** dsh's sandbox is per-execution and stateless; PLUTON's Docker provider is a long-lived per-Muse container. Splitting lifecycle from confinement keeps both models honest.
- **Do not claim terminal confinement by association.** A host tmux session outside the confined process is not confined, even if the engine is. Terminal is a convenience boundary today; native must either confine the shell inside the PTY or label it as unconfined.

---

## 6. Proposed native execution provider

This section is an interface design sketch. No file in this section exists in the repository; the names are proposals. The design deliberately keeps the existing `EngineAdapter`, `AcpClient`, `RunSupervisor`, workspace manager, store, and approval channel.

### 6.1 Core contracts

```ts
// Policy vocabulary mirrors dsh's mode + workspaceRoot + sessionId
// (03-model-tools-capabilities.md:266-281).
export type ExecutionMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type NetworkPolicy = 'none' | 'restricted' | 'open'

export interface ExecutionPolicy {
  mode: ExecutionMode
  /** Absolute host path the session may operate on. */
  workspaceRoot: string
  /** Stable id for denial/audit correlation; not a secret. */
  sessionId: string
  /** Absolute host paths that must remain readable but not writable. */
  readOnlyPaths?: string[]
  /** Absolute host paths writable in workspace-write mode (engine home, temp). */
  writablePaths?: string[]
}

export interface ConfinementProbe {
  available: boolean
  backend: 'docker' | 'windows-acl' | 'bwrap' | 'landlock' | 'none'
  enforcement: 'full' | 'partial'
  detail: string
  fix?: string
  limitations: string[]
}

export interface RunnerFailureRule {
  /** e.g. backend launcher missing, policy parse failure, helper crash. */
  pattern: RegExp
  code: string
}

export interface ConfinedArgv {
  /** runner + profile + separator + caller argv; Docker may pass through. */
  argv: string[]
  enforcement: 'full' | 'partial'
  /** Backend dialect denial markers: EROFS, EACCES, EPERM, ACL denial text. */
  denialSignatures: string[]
  runnerFailureRules: RunnerFailureRule[]
  backend: ConfinementProbe['backend']
}

export interface ConfinementProvider {
  probe(): Promise<ConfinementProbe>
  confine(
    argv: string[],
    policy: ExecutionPolicy,
    opts: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): Promise<ConfinedArgv>
}
```

### 6.2 Session and provider contracts

```ts
export type ExecutionProviderKind = 'docker' | 'native'

export interface ExecutionSessionSpec {
  projectId: string
  museId: string
  engineKind: string
  /** Host path the engine must use as its cwd (checkout or project root). */
  hostWorkdir: string
  /** Host path to the Muse's private engine home. */
  hostEngineHome: string
  /** Absolute host root that the policy boundary is expressed against. */
  workspaceRoot: string
  policy: ExecutionPolicy
  limits: { cpus: number; memoryMb: number; pids: number }
  network: NetworkPolicy
  /** Already sanitized by buildEngineEnv/engine adapter; never the full host env. */
  env: Record<string, string>
  engine: {
    /** Resolved by host discovery for native; pinned container path for Docker. */
    binaryPath?: string
    platform: NodeJS.Platform
  }
  terminalBackend: 'auto' | 'conpty' | 'tmux' | 'none'
}

export interface ExecutionProbe {
  available: boolean
  provider: ExecutionProviderKind
  backend: ConfinementProbe['backend']
  enforcement: 'full' | 'partial'
  detail: string
  fix?: string
  capabilities: {
    fileReadOnly: boolean
    fileWorkspaceWrite: boolean
    networkNone: boolean
    resourceLimits: boolean
    processTreeKill: boolean
    terminal: boolean
  }
}

export interface SessionFacts {
  id: string
  provider: ExecutionProviderKind
  backend: ConfinementProbe['backend']
  enforcement: 'full' | 'partial'
  mode: ExecutionMode
  workspaceRoot: string
  engineHome: string
  pids: number[]
  startedAt: string
  policyHash: string
  limitations: string[]
}

export interface ProcessHandle {
  readonly pid?: number
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  /** Must terminate the whole tree, not just the direct child. */
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface ExecutionSession {
  readonly id: string
  readonly spec: ExecutionSessionSpec
  facts(): Promise<SessionFacts>
  /** Directly usable as AcpSpawnFn; no ACP changes required. */
  spawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string>; windowsHide: boolean }): Promise<ProcessHandle>
  exec(argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number; input?: string }): Promise<ExecResult>
  openTerminal(opts: { name: string; cwd: string; cols: number; rows: number }): Promise<TerminalHandle>
  close(): Promise<void>
}

export interface ExecutionProvider {
  readonly kind: ExecutionProviderKind
  probe(): Promise<ExecutionProbe>
  /** Validate policy/paths/binaries; must not start an engine process. */
  prepare(spec: ExecutionSessionSpec): Promise<ExecutionSession>
  list(): Promise<SessionFacts[]>
  /** Kill all live processes for a session; Docker keeps the container unless explicitly stopped. */
  close(session: ExecutionSession): Promise<void>
  /** Explicit cleanup; not called at the end of every run until cleanup policy is decided. */
  stopEnvironment(session: ExecutionSession): Promise<void>
}
```

`ExecResult` is the existing bounded runner result shape (`src/util/exec.ts`); `ProcessHandle` is structurally compatible with `AcpChild` (`src/engines/acp/client.ts:22-31`). Making `kill` tree-aware is the one semantic change the ACP client needs to inherit for free: `AcpClient.close` calls `child.kill()` (`:294-301`). The provider owns session teardown and must expose it explicitly; callers must not rely on garbage collection, mirroring dsh's `AgentHandle.dispose()` ownership rule (`02-agent-session-persistence.md:20-27`).

### 6.3 Mapping to existing types

| Existing | Target | Compatibility rule |
|---|---|---|
| `SandboxManager` (`src/sandbox/types.ts:59-108`) | `ExecutionProvider` | `DockerExecutionProvider` delegates every method; `SandboxManager` stays internal and tested. |
| `SandboxSpec` (`:26-43`) | `ExecutionSessionSpec` | Docker adapter converts mounts/network/limits; native derives from host paths/policy. |
| `SandboxInspect` | `SessionFacts` | Native has no container image/user/mounts; substitute backend/enforcement/pids/policyHash. |
| `DockerExecContext` (`src/engines/docker-exec.ts:20-29`) | `ExecutionSession` | Docker session wraps `containerName` + `mounts`; native wraps host workdir + confinement. |
| `AcpSpawnFn` (`src/engines/acp/client.ts:39`) | `ExecutionSession.spawn` | Same signature once async unwrapped; adapt with a tiny wrapper. |
| `LocalProcessSandbox` | `NativeExecutionProvider` + `danger-full-access` | Keep the old class and config as a deprecated alias; do not silently promote it. |
| `SandboxManager.exec` | `ExecutionSession.exec` | Verification and terminal helpers move here. |
| `TerminalManager` (`src/terminal/types.ts`) | `TerminalProvider` | Docker implementation keeps `TmuxTerminalManager`; native returns a PTY or `TerminalUnavailableError`. |
| `RunDeps.sandboxManager` / `dockerSpawn` (`src/cli/commands/run.ts:76-84`) | `RunDeps.executionProvider` | Keep deprecated fields for one release so tests and embedders do not break. |

### 6.4 Docker provider (behavior-preserving adapter)

```ts
class DockerExecutionProvider implements ExecutionProvider {
  constructor(private readonly manager: SandboxManager,
              private readonly spawn: AcpSpawnFn = defaultSpawn) {}
  // probe -> manager.probe()
  // prepare -> ensureMuseContainer + DockerExecContext
  // session.spawn -> dockerExecSpawn(context, spawn)
  // session.exec -> manager.exec(container, argv, opts)
  // close -> close ACP sessions; do NOT stop the container (current behavior)
  // stopEnvironment -> manager.stop + manager.remove (explicit only)
  // terminal -> TmuxTerminalManager / buildAttachArgv
}
```

The Docker provider must first be a **pure refactor**: same argv, same timeouts, same labels, same bridge binding, same lifecycle. Acceptance gate: all existing Docker tests pass unchanged (section 9, Phase 1).

### 6.5 Native provider (Windows and Linux)

```ts
class NativeExecutionProvider implements ExecutionProvider {
  constructor(
    private readonly confine: ConfinementProvider,
    private readonly processes: ProcessService,
    private readonly terminals: TerminalProvider,
  ) {}
  // probe -> confine.probe() + engine discovery + process/terminal capabilities
  // prepare -> validate host paths/binaries/policy; compute policyHash; no process
  // session.spawn -> confine(argv) -> processes.spawn(confined.argv)
  // session.exec -> confine(argv) -> processes.exec(confined.argv)
  // close -> processes.killTree(session.pids)
}
```

**Session adapter construction.** `nativeAdapterFor` is intentionally much smaller than `containerAdapterFor`:

```ts
export function nativeAdapterFor(
  muse: MuseRecord,
  session: ExecutionSession,
  facts: EngineIsolationFacts,
): EngineAdapter {
  return engineAdapterForMuse(muse, {
    spawnFn: (command, args, options) => session.spawn(command, args, options),
    platform: process.platform,
    binaryPath: resolveHostEngineBinary(muse.engineKind), // discovery is the gate
    isolatedCheckout: facts.isolatedCheckout,
    mapWorkdir: (p) => p, // identity
  })
}
```

`resolveHostEngineBinary` must use the existing `discover` functions (`src/engines/opencode/discover.ts`, `src/engines/qwen/discover.ts`) and their `.cmd`/script-entry handling; it must not pass a `.cmd` shim to `spawn` without the resolved node/executable target. The Docker adapter's pinned `/usr/local/bin/...` logic (`src/cli/commands/run.ts:309-313`) is not reusable.

**Policy derivation.** The policy is derived from the Muse's `workspace_policy` and the session kind, not from the engine's self-report:

| Muse/session | Execution mode | Writable paths | Approval default |
|---|---|---|---|
| `coordinator-read-only` manager session | `read-only` | none (project root readable) | existing `approval_mode` |
| `read-only` researcher/reviewer | `read-only` | none | existing |
| `isolated-task-checkout` coder/tester | `workspace-write` | task checkout + Muse engine home + private temp | existing |
| chat operator (CLI/SPA) | `read-only` unless an isolated checkout is explicitly selected | engine home may be writable for auth/session state | existing |
| acknowledged `danger-full-access` | `danger-full-access` | host user's effective access | explicit `never` + acknowledgement |

`danger-full-access` must be a separate acknowledgement (`sandbox.native.danger_full_access_acknowledged` or the deprecated `local_process_acknowledged`), not a value someone can flip silently.

### 6.6 Bridge and approvals

- **Bridge:** native always binds the `ToolHttpServer` default loopback (`src/tools/http-transport.ts:26-28`). Container mode sets `0.0.0.0` in both paths (`src/cli/commands/run.ts:674-681`; `src/cli/commands/chat.ts:281-293`); native must leave both conditions false. The per-session bearer token remains (`src/tools/http-transport.ts:91-102`, `:179-188`).
- **Approvals:** reuse `createEngineApprovalChannel` and the durable approval table. Add one action, `execution.escalate`, with a scope of `{museId, sessionId, fromMode, toMode, paths}`. A denial must surface the stable marker from the confinement backend and must not be retried outside confinement. Missing answerer => deny, matching the existing fail-closed behavior (`src/engines/interactive-approval.ts`; `docs/SECURITY.md:134-139`).
- **Preset composition:** add a native preset table mirroring dsh's `workspace-write` + `ask` and `danger-full-access` + `never` (`03-model-tools-capabilities.md:318-328`). Do not change approval mode and execution mode independently in one UI action without showing both.

### 6.7 Provider selection and fail-closed rules

```ts
export function createExecutionProvider(config: PlutonConfig): ExecutionProvider {
  switch (config.sandbox.kind) {
    case 'docker': return new DockerExecutionProvider(createSandboxManager(config))
    case 'native': return new NativeExecutionProvider(...)
    case 'local-process': return new NativeExecutionProvider(/* danger-full-access, ack */)
  }
}
```

Rules:
1. `native` requires a successful `probe()`; otherwise `SandboxUnavailableError` with an exact fix. No fallback to Docker or local-process.
2. `native` with `network: 'restricted'` must either implement a documented egress filter or refuse. Mapping to host networking is forbidden.
3. `native` with `workspace-write`/`read-only` and a missing confinement backend must refuse. `danger-full-access` is the only mode allowed to run without a backend, and only after acknowledgement.
4. Docker selection is unchanged; a Docker probe failure still fails closed (`src/sandbox/docker.ts:60-65`).
5. `sandbox.image` under native produces a warning, not a silent ignore; `sandbox build-image` remains Docker-only.

---

## 7. Platform compatibility matrix

Legend: **Full** = enforced by the OS/backend and testable; **Partial** = enforced with documented holes; **None** = no enforcement; **Unproven** = design-possible but no evidence; **N/A** = not applicable. Docker columns describe today's implementation, not an aspiration.

| Capability | Docker on Windows | Docker on Linux | Native Windows | Native Linux | `local-process` |
|---|---|---|---|---|---|
| Filesystem read boundary | Full for mount set; host home not mounted | Full for mount set | Partial: restricted token + ACL; system paths readable by design | Full where bwrap/Landlock available | None |
| Filesystem write boundary | Full for mount set (`readonly` project root) | Full for mount set | Partial: ACL `workspace-write`; ACL edge cases/TEMPs | Full where bwrap/Landlock available | None |
| Non-root execution | Full: numeric non-root user (`docker.ts:80-81`, `:117-121`) | Full, subject to uid mapping | Full: invoking user; **refuse root** for supervised sessions | Full: invoking user; refuse root | Full: invoking user (could be root) |
| Process-tree kill | Docker owns the container; `docker rm -f` kills it | Same | Partial: Job Object required; `taskkill /T /F` is not a guarantee | Full: `setsid` + process-group kill; `PR_SET_PDEATHSIG` helper | None: `child.kill()` only (`src/engines/acp/client.ts:294-301`) |
| CPU/memory/PID limits | Full: cgroups via `--cpus/--memory/--pids-limit` (`docker.ts:86-91`) | Full: cgroups | Partial: Job Object limits | Partial/full: cgroups v2 (`systemd-run --user --scope`) if present | None |
| Network `none` | Full: `--network none` (`docker.ts:94-99`) | Full | None/Unproven: needs WFP/AppContainer; refuse if absent | Full: bwrap `--unshare-net` | None |
| Network egress filter (`restricted`) | **Not a filter**: bridge with DNS (`docs/PLUTON_ARCHITECTURE.md:107`) | Same | None unless firewall rule by SID/path; refuse | None unless nftables/cgroup egress helper; refuse | None |
| Environment allowlist | Full: Docker passes `-e NAME` only (`docker-exec.ts:146-164`) | Full | Full if enforced in `ProcessService`; `util/exec` default merges full env (`src/util/exec.ts:43-46`) | Same | Full only if caller passes explicit env; default leaks |
| Secret isolation | Container mount/env allowlist; host trusted (`docs/SECURITY.md:130-133`) | Same | Partial: same user can read user files unless ACL denies; engine home private | Partial/full: Landlock/bwrap deny home/state; host user same UID | None |
| Terminal persistence | Full: tmux in container (`terminal/manager.ts:87-90`) | Full | Unproven: ConPTY + broker; or no attach | Unproven: host tmux or PTY; confinement question | None: attach refuses (`terminal/attach.ts:81-87`) |
| Engine binary pinning | Full: image pins OpenCode 2.0.31/Qwen 0.25.2 (`Dockerfile:30-42`) | Full | Partial: host discovery/PATH; `PLUTON_*_BIN`; version check | Partial: same | Full: whatever is on host |
| Toolchain reproducibility | Full: image | Full: image | Partial: host Node/git/tmux | Partial: host Node/git | Partial |
| Tool bridge exposure | **Gap**: `0.0.0.0` while container run live (`docs/SECURITY.md:152-156`) | Same | Full: loopback only | Full: loopback only | Full: loopback |
| Verification confinement | **Gap**: host `util/exec.run` (`verify/runner.ts:141`) | Same | Partial: run via provider | Partial/full: run via provider | None |
| Cleanup / orphan reaping | **Gap**: no production stop/reap (section 2.5) | Same | Provider must kill tree; crash recovery via Job Object close | Provider must kill group; PID registry fallback | None |
| Enforcement reporting | Container assumed; no explicit `full/partial` field | Same | Must report `partial` | `full` FS / `partial` limits | Must report `none` |
| Evidence | Docker Desktop Windows live smoke (`docs/SECURITY.md:123-129`) | Linux E2E **NOT RUN** (`docs/LINUX_BIND_MOUNT_VALIDATION.md`) | **No implementation/test** | **No implementation/test** | Host-mode live smoke (`docs/smoke-live-run.md:5-9`), no confinement |

### 7.1 Windows native backend

**Target backend:** restricted-token + ACL process runner (`sandbox-windows-acl`-style), as dsh reports `enforcement: partial` (`Y:\Setup\REA deepseek\03-model-tools-capabilities.md:285-289`).

Required pieces:
1. **Token creation:** `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE` and restricting SIDs; launch via `CreateProcessAsUser`/`CreateProcessWithTokenW`. A plain `spawn` runs with the parent's full token and is **not** confinement.
2. **ACL:** canonicalize the workspace and engine-home paths; grant the restricted token read/execute on system paths and read/write on the allowed paths; deny writes elsewhere the process could otherwise reach. ACL inheritance and reparse points/UNC paths are known sharp edges and must be tested.
3. **Job Object:** create a job before resuming the process; assign the child; set `ProcessMemoryLimit`, `ActiveProcessLimit`, and CPU rate control; `TerminateJobObject` on close. This is the only reliable process-tree kill on Windows.
4. **ConPTY:** `CreatePseudoConsole` via `node-pty` or a small native addon. If unavailable, `terminal_backend: 'none'` and attach fails closed; do not silently spawn an unconfined console.
5. **No WSL dependency:** ADR-0010's supported path uses WSL2+Docker, but native Windows must not assume a general WSL distro or `tmux.exe`; the ADR notes native Windows tmux is not supported (`docs/adr/0010-windows-wsl2-boundary.md:7-11`; `docs/PLUTON_ARCHITECTURE.md:109`).
6. **`.cmd` resolution:** `opencode`/`qwen` discovery can resolve npm shims to a node script or executable (`src/engines/opencode/discover.ts:68-89`; `src/engines/qwen/discover.ts:47-64`). Native spawn must use the resolved target, not a shell. `spawn('foo.cmd', ...)` is not equivalent across Node versions and does not provide a confinement boundary.
7. **Paths:** Windows path normalization, case-insensitivity, 8.3 names, junctions, and `\\?\` prefixes must be canonicalized before ACL/policy checks. The workspace may be on `Y:\`; the provider must not assume a POSIX path.

**Honest limitation:** Windows ACL enforcement is expected to be `partial`; it is not a container. Do not claim parity with Docker's mount namespace. If a policy requires capabilities the backend cannot enforce (for example `network: none` without WFP), fail closed.

### 7.2 Linux native backend

**Target chain:** bwrap first, Landlock fallback, consistent with dsh (`03-model-tools-capabilities.md:285-289`).

Required pieces:
1. **bwrap:** `--ro-bind / /`, `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`, `--bind <workspace> <workspace>`, `--bind <engine-home> <engine-home>`, `--unshare-all`, `--die-with-parent`, `--new-session`, `--chdir <workspace>`, then the engine argv. `read-only` omits the writable bind; `workspace-write` binds only the checkout/engine home/temp. `network: none` adds `--unshare-net`.
2. **Landlock fallback:** ship the static `landlock-run` helper (or equivalent); probe ABI/kernel support; apply path allowlists. dsh ships this as a static-musl prebuilt from its native addon (`Y:\Setup\REA deepseek\04-interfaces-delivery-reference.md:329-332`), which is the packaging model PLUTON should copy. Landlock is not a full container: no PID/network namespace by itself. Mark `partial` where network/limits are not covered.
3. **User namespaces / AppArmor:** probe `unprivileged_userns_clone`, bwrap availability, and AppArmor restrictions. A bwrap failure is a runner failure, not a denial; distinguish them per dsh (`:281`).
4. **Process groups:** spawn with `setsid` (or a wrapper that sets it); on close send `SIGTERM` to `-pid`, wait, then `SIGKILL`; verify no surviving group members. `util/exec.run` currently kills only the direct child on timeout (`src/util/exec.ts:55-59`), so the native provider cannot rely on it for tree teardown.
5. **Limits:** cgroups v2 via `systemd-run --user --scope` with `MemoryMax`, `CPUQuota`, `TasksMax`; if the user session lacks delegation, report `partial` and do not claim Docker-equivalent limits.
6. **UID:** run as the invoking user. The Docker `10001` mapping (`src/sandbox/user-mapping.ts:33-76`) is irrelevant. Root execution must be refused for supervised sessions; if the operator is root, fail closed with a fix rather than silently running as root.
7. **Host file permissions:** native avoids bind-mount ownership mismatch, but the process can read any file the user can read unless Landlock/bwrap denies it. The policy must explicitly deny `~`, `.pluton/state`, other projects, and credentials paths.

### 7.3 macOS

Native execution is **out of scope** for this migration. dsh uses Seatbelt via `sandbox-exec` (`Y:\Setup\REA deepseek\03-model-tools-capabilities.md:288`), but PLUTON has no macOS-native evidence and its release matrix says native engines are unverified (`docs/RELEASE.md:96-110`). `sandbox.kind: native` on macOS must return `SandboxUnavailableError` with a fix ("use Docker, or implement the macOS backend") rather than a partial implementation. Docker on macOS remains supported to the extent it is today.

---

## 8. Security-gap matrix

This is a migration risk register, not a claim that the target is secure. "Residual" names what remains after the proposed backend works as designed.

| # | Risk | Current Docker behavior | Native target | Residual / gate |
|---|---|---|---|---|
| S-01 | Write outside workspace | Bind mounts; read-only project root for non-isolated policies (`muse-provision.ts:37-45`) | ACL/Landlock deny outside allowed paths | Windows ACL edge cases (junctions, inherited ACEs) must be tested; Linux Landlock ABI gaps. |
| S-02 | Read secrets/home | Mount allowlist; host home not mounted; engine home is mounted | Deny `~`, `.pluton/state`, other projects, credential stores | Same-UID reads on Windows may remain possible without a full token/ACL design; test. |
| S-03 | Network egress | `restricted` is **not** an egress filter (`docs/PLUTON_ARCHITECTURE.md:107`); `none` is full | `none` via `--unshare-net`; `restricted` refused unless a real filter exists | Do not label `restricted` as filtered. This is a product decision, not just code. |
| S-04 | Resource exhaustion | Docker cgroups (`docker.ts:86-91`) | Job Objects/cgroups | Partial on both; document limits and test OOM/CPU behavior. |
| S-05 | Orphan process after cancel/crash | Container persists; no stop/reap (section 2.5) | Job Object kill-on-close / process group kill + PID registry | Crash recovery must be tested (kill parent, then verify no child). |
| S-06 | Secret leakage via env | Explicit Docker env names; `docker exec` passes names only | `ProcessService` explicit env; never `util/exec` default | **Trap:** `util/exec.run` merges `process.env` (`src/util/exec.ts:43-46`). Native must use explicit env or a new API. |
| S-07 | Bridge exposed on LAN | `0.0.0.0` while container run live (`SECURITY.md:152-156`) | Loopback only | Docker path still has the gap until a separate fix; native must not inherit it. |
| S-08 | SPA host bypass | Server chat runs `engineAdapterForMuse` on host (`routes.ts:1292`) | Same provider as CLI; or explicit host-only refusal | **Must be fixed before native default.** A native provider that leaves this path host-run creates a false sense of confinement. |
| S-09 | Verification escapes sandbox | Host `util/exec.run` (`verify/runner.ts:141`) | Provider `exec` in the task's policy | Existing Docker behavior is a parity gap; test checks cannot write outside workspace. |
| S-10 | Terminal is trusted/unconfined | tmux in container; operator terminal trusted (`SECURITY.md:148-149`) | PTY inside confinement, or explicitly unconfined with warning | Native v1 may have no attach; do not claim terminal confinement. |
| S-11 | Toolchain drift | Image pins engines/tools (`Dockerfile:30-60`) | Host discovery + version check/record | No image means PATH drift; doctor must report versions and unsupported versions must fail. |
| S-12 | Container cleanup | No production stop/reap | Native provider closes processes; Docker cleanup remains separate | Add `sandbox stop/rm` or a documented reaper before claiming lifecycle parity. |
| S-13 | Approval bypass | Engine requests answered fail-closed; interactive channel | Same + execution escalation approval | Missing answerer => deny; test. |
| S-14 | Auditability | Labels/events; no explicit enforcement field | `execution.*` events + `SessionFacts` | Persist provider/backend/enforcement; no secrets. |
| S-15 | Windows partial enforcement | N/A | Explicit `enforcement: partial` in doctor/JSON/UI | Users must not read "native" as "as strong as Docker". |

**Current Docker gaps that native does not automatically fix:** no custom seccomp/AppArmor, no read-only rootfs guarantee, `restricted` is not egress filtering, bridge binds all interfaces, Linux bind-mount ownership is NOT RUN, and there is no production container stop/reap. A native provider can improve S-07 and S-09 in its own path, and S-10 only if the terminal Option B in Phase 6 lands; it cannot retroactively fix the Docker path. Both must be reported honestly.

---

## 9. Ordered migration phases, rollback, and acceptance criteria

### 9.1 Phase plan

**Phase 0 - Baseline and decision freeze**
- Goal: make the migration safe to start from a known commit.
- Work: record HEAD and working-tree state; rerun the Docker unit/integration suites; archive the prior parity report; decide that Docker remains the default and native is opt-in.
- Gate: `npm run release:check` and the Docker E2E job are green (or their NOT RUN status is recorded with the exact reason); no uncommitted source changes.
- Rollback: none needed; this phase changes no code.
- Exit: signed-off baseline with test counts and known gaps.

**Phase 1 - Extract the provider seam (pure refactor)**
- Goal: make Docker go through `ExecutionProvider` with byte-identical behavior.
- Work: add the interfaces from section 6; implement `DockerExecutionProvider` over `SandboxManager`/`dockerExecSpawn`; add `ExecutionSession` wrapper for `DockerExecContext`; make `RunDeps` accept `executionProvider` while keeping `sandboxManager`/`dockerSpawn` as deprecated aliases; no config or CLI behavior change.
- Gate: all existing Docker tests pass unchanged; create argv, env argv, path mapping, bridge bind, container lifecycle, and attach argv are asserted equal to HEAD.
- Rollback: revert the refactor commit; Docker code path was never removed.
- Exit: one Docker implementation, two identical test runs (old path vs provider path).

**Phase 2 - Native `danger-full-access` development mode**
- Goal: prove ACP + supervisor + bridge + workspace work through a native process, without claiming isolation.
- Work: add `sandbox.kind: native`; add schema v8 (sandbox provider/backend/enforcement); add `NativeExecutionProvider` with `danger-full-access` only; reuse `util/exec`/`defaultSpawn` and host engine discovery; require an explicit acknowledgement (new key or deprecated `local_process_acknowledged`); CLI `run` and `chat` first; leave `attach` refused.
- Gate: a Windows host run completes a task; a Linux host run completes a task; no Docker daemon required; session close works; env is explicit; no `0.0.0.0` binding; all existing tests still pass. Full process-tree teardown is a Phase 4 gate, not a Phase 2 claim.
- Rollback: set `sandbox.kind: docker`; no DB rows are required for native dev sessions if v8 is not yet written, or restore the pre-v8 DB backup.
- Exit: native dev mode works but is labeled `danger-full-access` and `enforcement: none` everywhere.

**Phase 3 - Filesystem confinement (Windows + Linux)**
- Goal: implement `workspace-write` and `read-only` with real OS enforcement.
- Work: Windows restricted-token/ACL backend + canonicalization; Linux bwrap/Landlock backend with probe/fallback; `ConfinementProvider.confine`; denial classification; `doctor`/`sandbox probe` report backend and enforcement; fail closed when unavailable.
- Gate: adversarial tests on both platforms: write outside workspace denied, read of a denied home/state path denied or explicitly allowed by policy, symlink/junction escape denied, `read-only` cannot write the workspace, denial is distinguishable from runner failure. Linux: bwrap and Landlock paths each tested. Windows: `full` is never reported for ACL.
- Rollback: set `sandbox.kind: docker`; native sessions with a missing backend refuse before any process starts.
- Exit: `workspace-write`/`read-only` accepted on both platforms with measured enforcement; `danger-full-access` remains acknowledged.

**Phase 4 - Process lifetime, resources, and network policy**
- Goal: make cancellation/crash cleanup and resource/network claims true.
- Work: Windows Job Objects (kill-on-close, memory/process/CPU limits); Linux `setsid` + process-group teardown, optional cgroups v2; PID registry for crash recovery; `network: none` (bwrap/unshare; Windows WFP or refusal); `restricted` refused or backed by a real filter; `doctor` reports limits/network capabilities.
- Gate: kill the parent process during a task and verify no child survives; cancel during a tool call; OOM/CPU stress within bounds; `network: none` cannot reach a listening host port; missing WFP/cgroups yields a clear refusal or `partial`, not a silent pass.
- Rollback: config flip; provider kills all live sessions on startup; Docker path unchanged.
- Exit: no orphan process in the tested scenarios; capability matrix matches actual probes.

**Phase 5 - Verification through the provider + bridge loopback + SPA unification**
- Goal: eliminate the two host-execution bypasses before native becomes default.
- Work: route verification checks through `ExecutionProvider.exec` with the task's policy and a sanitized env; keep loopback-only bridge in native; make server chat use the same provider selection as CLI (or, as a temporary explicit exception, refuse to call it confined and surface a warning - not the preferred end state); make server verify use the provider; add an end-to-end SPA chat confinement test.
- Gate: a verification check that attempts to write outside the workspace is denied under `workspace-write` and under Docker (if Docker verification is also fixed); SPA chat in Docker mode either runs in the container or refuses with an exact message; no native path binds `0.0.0.0`; a token-bearing request from a non-loopback interface is refused.
- Rollback: keep Docker verification and server chat on the old path behind a flag; do not switch default.
- Exit: one execution provider selection for CLI runs, CLI chat, SPA chat, server runs, and verification; no silent host fallback.

**Phase 6 - Native terminals and attach (scope decision gate)**
- Goal: either deliver terminal parity or explicitly ship without it.
- Option A (recommended for v1): native `attach` returns `TerminalUnavailableError` with a clear message; terminal remains Docker-only; document the gap in `RELEASE.md` and `SECURITY.md`.
- Option B: implement ConPTY + a per-session terminal broker on Windows and a confined tmux/PTY on Linux; prove that the shell is inside the same confinement as the engine; add an `attach` path that does not use `docker exec`.
- Gate for Option B: terminal shell cannot write outside policy; attach/detach does not fail tasks (`src/terminal/types.ts:6-8`); terminal rows persist correctly; no unconfined host tmux is used under a confined engine. Gate for Option A: exact error, no misleading `attach` success, docs matrix updated.
- Rollback: keep Option A; no schema change if terminals are deferred.
- Exit: a deliberate, documented terminal scope decision.

**Phase 7 - Default switch and deprecation**
- Goal: make native the default only where the evidence supports it.
- Work: per-platform default decision (likely Linux where bwrap/Landlock is proven; Windows only with `allow_partial_enforcement` and a visible warning; macOS stays Docker); update templates, README, RELEASE, SECURITY, ADRs; deprecate `local-process` with a warning and a removal date; keep Docker supported.
- Gate: all acceptance criteria below; a rollback drill from native to Docker on a real project; packaged tarball contains native helper binaries; release gate checks them; CI runs both Windows and Linux native E2E.
- Rollback: config flip plus DB restore if v8 was written; Docker remains installed and tested.
- Exit: default chosen by evidence, not by preference.

### 9.2 Rollback plan

1. **Configuration rollback.** Set `sandbox.kind: docker` (or the previous provider) in `pluton.yaml`. Docker code, image, and tests remain in the tree for at least two minor releases. Do not delete Docker modules during the migration.
2. **Database rollback.** Schema v8 is forward-only: `migrate()` refuses a database newer than the binary (`src/store/migrations.ts:347-353`). Before applying v8, stop Pluton and copy `.pluton/state/pluton.sqlite` plus `-wal`/`-shm` (SQLite WAL) to a backup path. Rolling back the binary requires restoring that backup; editing the user_version down is not supported.
3. **Process rollback.** On graceful rollback, call `provider.close()` for every live session. On crash, Windows Job Objects with kill-on-close must terminate the tree; Linux uses the process-group/PID registry. If a PID registry entry is stale, `doctor` reports it and a future explicit `sandbox reap` command may clean it. Do not claim this command exists until it does.
4. **Feature-flag rollback.** Optional `PLUTON_EXECUTION_PROVIDER=docker` environment override for emergency rollback only; it must emit a visible warning and must not be a silent default. Config remains the primary switch.
5. **Bridge/DB compatibility.** Old clients ignore new `provider/backend/enforcement` JSON fields. Old binaries cannot read v8; that is a hard rollback boundary, not a compatible downgrade.
6. **Rollback drill.** Before the default switch, run: native run -> cancel mid-task -> flip to Docker -> start a Docker run in the same project -> verify no orphan native process and no container/DB corruption. Record the result.

### 9.3 Acceptance criteria

| ID | Criterion | Evidence required | Gate |
|---|---|---|---|
| AC-01 | Docker behavior is unchanged by the seam refactor | Existing Docker unit/integration/E2E pass; argv/lifecycle snapshots equal HEAD | Phase 1 |
| AC-02 | Native `danger-full-access` runs a supervised task on Windows and Linux | Real run log, task reaches `verifying`, no Docker daemon | Phase 2 |
| AC-03 | `workspace-write` denies writes outside the task checkout | Adversarial test (write, symlink, junction/reparse) fails closed with a denial marker | Phase 3 |
| AC-04 | `read-only` denies writes to the workspace | Same, plus a read succeeds | Phase 3 |
| AC-05 | Missing backend fails closed | `SandboxUnavailableError` with exact fix; no process starts | Phase 3 |
| AC-06 | Windows enforcement is labeled `partial` | `doctor`, `sandbox probe`, JSON, UI all show `partial`; no `full` claim | Phase 3 |
| AC-07 | Cancellation kills the whole process tree | Parent/child/grandchild test; no survivor after timeout/cancel/SIGINT | Phase 4 |
| AC-08 | Crash recovery leaves no orphan | Kill Pluton during a task; verify Job Object/process group cleanup | Phase 4 |
| AC-09 | Resource limits are enforced or refused | Memory/CPU/PID stress; missing cgroup/WFP yields refusal/`partial` | Phase 4 |
| AC-10 | `network: none` has no egress | Attempt to reach a host listener; connection fails | Phase 4 |
| AC-11 | Secrets are not inherited | Marker secret in host env is absent from engine/child env; explicit allowlist test | Phase 2/4 |
| AC-12 | Bridge is loopback-only under native | Bind assertion + non-loopback request refusal | Phase 5 |
| AC-13 | Verification runs in the same policy as the task | Check that writes outside workspace is denied; no host-only check path | Phase 5 |
| AC-14 | SPA chat is not a host bypass | SPA chat either runs in the provider or refuses with an exact message; test captures the behavior | Phase 5 |
| AC-15 | Docker-mode `0.0.0.0` exposure is either fixed or explicitly retained with a warning | Security test and docs; no accidental native inheritance | Phase 5 |
| AC-16 | DB v7->v8 migration is rollbackable via backup/restore | Migration test + restore drill; old binary refusal is explicit | Phase 2/7 |
| AC-17 | Config migration is backward compatible | Old `docker` and `local-process` configs still validate; new keys strict | Phase 2 |
| AC-18 | Native attach behavior is explicit | Either a confined terminal test or an exact `TerminalUnavailableError` | Phase 6 |
| AC-19 | CI proves both platforms | Windows and Linux native E2E jobs; no skipped test reported as pass | Phase 7 |
| AC-20 | Docs/release matrix match evidence | `RELEASE.md`, `SECURITY.md`, README, ADR updates cite test names and dates | Phase 7 |
| AC-21 | Rollback drill succeeds | Native -> Docker in one project; no orphan, no DB corruption | Phase 7 |
| AC-22 | Performance is bounded | Session start and task overhead measured against Docker; regressions documented, not hidden | Phase 7 |

---

## 10. Data migration and backward compatibility

### 10.1 Schema v7 -> v8

Current schema: `SCHEMA_VERSION = 7` (`src/store/migrations.ts:327-339`). The `sandboxes` table is v2-era (`:135-147`) and has no provider/backend/enforcement columns. Proposed v8:

```sql
ALTER TABLE sandboxes ADD COLUMN provider TEXT;        -- 'docker' | 'native' | 'local-process'
ALTER TABLE sandboxes ADD COLUMN backend TEXT;         -- 'docker' | 'windows-acl' | 'bwrap' | 'landlock' | 'none'
ALTER TABLE sandboxes ADD COLUMN enforcement TEXT;     -- 'full' | 'partial' | 'none'
ALTER TABLE sandboxes ADD COLUMN policy_json TEXT;     -- mode/paths/network/limits; no secrets
ALTER TABLE sandboxes ADD COLUMN last_seen_at TEXT;    -- nullable; observational
```

Notes:
- `kind` remains the compatibility discriminator; `provider` can mirror it for future split. The minimum change is to widen `rowToSandbox` to accept `'native'` (`src/store/store.ts:1937-1941`) and widen `SandboxRecord.kind` (`src/domain/models.ts:176`). The extra columns are for observability and do not change the state machine.
- `sandboxes.container_name`/`container_id`/`image` stay nullable. Native writes `container_name = null`, `container_id = <session id>`, `image = null`; `state` uses the existing `absent|creating|running|stopped|error` values (`src/domain/state.ts:176-177`). Define `running` = provider has a live session for that Muse, `stopped` = no live session, `error` = last close/kill failed. Do not write `running` for a merely prepared (process-less) session.
- **Terminals are not migrated in v8.** Native v1 (recommended) does not support `attach`; `terminals.tmux_session_name` stays `NOT NULL` (`src/store/migrations.ts:148-157`). If terminal parity is later delivered, add a v9 with `backend` and `terminal_ref` and keep `tmux_session_name` for Docker compatibility.
- Migration must run inside the existing transaction wrapper (`src/store/migrations.ts:355-363`). `from > SCHEMA_VERSION` still refuses (`:347-353`), so a v8 DB cannot be opened by a v7 binary. This is the rollback boundary. Mirror dsh's persistence discipline: a version gate, an exclusive writer, and a **fail-closed unknown vocabulary** (`Y:\Setup\REA deepseek\02-agent-session-persistence.md:224-237`, `:248-253`). For PLUTON, unknown `provider`/`backend`/`enforcement` values must throw in `rowToSandbox`, not be coerced to Docker or `full`.

### 10.2 Record and API compatibility

- `SandboxRecord` gains optional `provider`, `backend`, `enforcement`, `policyJson`, `lastSeenAt`; existing constructors/tests that omit them remain valid. `rowToSandbox` fills defaults for old rows (`provider = kind`; `enforcement = 'unknown'` because a legacy Docker row did not record its enforcement scope, and `'none'` for local-process). Never backfill `'full'`.
- `SandboxState` is unchanged; no new state machine values. If a native session is transient, `state='stopped'` is a valid resting state.
- Store JSON/HTTP responses are additive. Old clients ignore unknown fields. A new client must treat a missing `enforcement` on an old row as `unknown`, not `full`.
- Events: add `execution.session_started`, `execution.session_exited`, `execution.policy_applied`, `execution.denial`, `execution.escalation_requested`. Payloads carry ids/backend/enforcement/mode; never env values, tokens, or full command lines containing secrets. Existing event redaction (`docs/SECURITY.md:100-102`) applies.
- `doctor` JSON gains a `native` section with availability/backend/enforcement/limitations; old consumers can ignore it.

### 10.3 Config compatibility

- `sandbox.kind` enum becomes `['docker', 'native', 'local-process']` with default `docker`. Existing configs remain valid.
- New optional block (strict):
```yaml
sandbox:
  kind: native
  native:
    confinement: workspace-write        # read-only | workspace-write | danger-full-access
    allow_partial_enforcement: false    # if false, partial backends refuse the policy
    danger_full_access_acknowledged: false
    terminal_backend: auto              # auto | conpty | tmux | none
```
- `local-process` remains valid for one deprecation window; it maps to native `danger-full-access` and keeps the existing acknowledgement. A warning says it is deprecated and unconfined.
- `sandbox.container_user` must **not** be added just to preserve the docs; it is not in the schema today (`src/config/schema.ts:91-100`) and native does not use uid mapping. Fix the doc drift at `docs/LINUX_BIND_MOUNT_VALIDATION.md:70-72` instead.
- `muses.<id>.limits` should either be honored by both providers or rejected. Today it is accepted but ignored by container provisioning (`src/config/schema.ts:36-43` vs `src/cli/commands/run.ts:273-277`). Native should not silently inherit that inconsistency.
- Templates remain `kind: docker` until the default switch; changing them earlier would surprise users and CI.

### 10.4 Backward compatibility rules

1. A Docker config with no native block behaves exactly as at HEAD.
2. A local-process config with the acknowledgement still starts, with a deprecation warning; without the acknowledgement it still fails (`src/sandbox/factory.ts:13-20`).
3. An old DB (v7) migrates in place; a new DB cannot be read by an old binary.
4. A native session never writes a `sandboxes` row that an old binary would try to parse unless v8 is applied; Phase 2 must either defer native row writes or include v8.
5. Docker image/build scripts and `package.json` `files` remain until the deprecation window ends.
6. `pluton attach` behavior is explicit: Docker works; native/local-process returns a precise error; no silent host shell.

---

## 11. Test gaps

The following gaps are confirmed by the absence of tests or by explicit NOT RUN records. They are not "nice to have"; each maps to an acceptance criterion.

| # | Gap | Why it matters | Required test | Platform |
|---|---|---|---|---|
| T-01 | No native provider tests | The entire target is unproven | Unit contract tests for `ExecutionProvider`/`ConfinementProvider`; fake backend first | All |
| T-02 | No Windows restricted-token/ACL tests | Windows is expected to be `partial`; ACL edge cases are the risk | Create restricted token, write outside workspace, junction/reparse escape, inheritance | Windows |
| T-03 | No Job Object tests | `child.kill()` does not kill a tree; orphan risk | Parent/child/grandchild kill; crash of Pluton; kill-on-close | Windows |
| T-04 | No ConPTY tests | Terminal parity is unknown | PTY spawn/read/write/resize/close; no console fallback | Windows |
| T-05 | No bwrap/Landlock tests | Linux enforcement is unproven | bwrap and Landlock paths; denial vs runner failure; missing backend | Linux |
| T-06 | No process-group kill test | `util/exec` kills only the direct child (`src/util/exec.ts:55-59`) | `setsid` group kill; SIGTERM then SIGKILL; no survivor | Linux |
| T-07 | No explicit-env test for native | `util/exec.run` inherits full env by default (`:43-46`) | Marker secret absent; allowlist present; no `process.env` merge | All |
| T-08 | No SPA chat confinement test | GAP-01 is untested and user-visible | SPA chat in docker/native mode: container/confined or explicit refusal | All |
| T-09 | No verification-confined test | Verification runs on host even in Docker mode | Check attempts write outside workspace; denied; artifacts still recorded | All |
| T-10 | No v7->v8 migration test | Forward-only DB boundary | Migrate v7 fixture; read old rows; old binary refusal; backup/restore drill | All |
| T-11 | No native config tests | Strict schema and deprecation | `native` block, partial refusal, local-process deprecation, unknown key failure | All |
| T-12 | No native terminal/attach test | Scope decision is unresolved | Confined PTY/tmux test or exact `TerminalUnavailableError` | All |
| T-13 | No orphan/reaper test | No production `stop()` today (section 2.5) | Kill parent, list surviving PIDs, provider cleanup, `doctor` report | All |
| T-14 | No Docker cleanup test | Containers persist after runs; no `sandbox stop` | Explicit cleanup command or documented reaper; label guard; foreign container refusal | All |
| T-15 | Linux bind-mount E2E is NOT RUN | Docker Linux claim is unproven | Run `tests/e2e/linux-bind-mount.e2e.test.ts` on a real Linux host | Linux |
| T-16 | `doctor` engine discovery is host-side in Docker mode | It does not prove the in-image engine exists (`doctor.ts:148-196`) | In-image binary check or a clear "image build proves it" note; native host version check | All |
| T-17 | No concurrency test across providers | Multiple Muses and sessions can collide | Two Muses, two policies, simultaneous spawns; no path/process cross-talk | All |
| T-18 | No performance baseline | Native may be slower or faster; claims need numbers | Session start, task overhead, memory; compare with Docker | All |
| T-19 | CI has no Windows native E2E | The primary host is Windows | Windows CI job with native backend tests; no "skipped = pass" | Windows |
| T-20 | CI has no Linux native E2E | The stronger confinement path is unproven | Linux CI job with bwrap/Landlock tests | Linux |

**Test-design rules for the migration.**
- Every security test must assert a **negative** outcome (denied/refused), not just a successful run.
- A skipped test must be reported as `NOT RUN` with a reason, matching the project's existing honesty convention (`docs/LINUX_BIND_MOUNT_VALIDATION.md:3-5`).
- Fake sandboxes are fine for orchestration tests but cannot satisfy a confinement acceptance criterion.
- E2E must run the real provider (Docker or native) and the real engine binary; mock adapters cannot prove process/ACL behavior.
- Match dsh's evidence discipline: run *matched evidence* locally (behavior tests, snapshots, real-provider E2E) and let CI own exhaustive matrices (`Y:\Setup\REA deepseek\04-interfaces-delivery-reference.md:301-305`). A green unit suite with a skipped native E2E is not evidence of native confinement.

---

## 12. Risks, assumptions, and unknowns

### 12.1 Assumptions to validate

| ID | Assumption | Validation |
|---|---|---|
| A-01 | A restricted-token/ACL Windows runner can be packaged as a native addon/helper without breaking the npm tarball. | Build on Windows 11; pack/install; run ACL tests from the packed artifact. |
| A-02 | ConPTY via `node-pty` (or a small addon) is acceptable for packaging/licensing/CI. | License review; prebuild availability for Node 24/Windows; fallback to no terminal. |
| A-03 | Target Linux hosts have bwrap or Landlock (or the static `landlock-run` helper can be shipped). | Probe on Ubuntu CI + a real host; fail-closed tests when absent. |
| A-04 | cgroups v2 delegation is available for per-session limits; otherwise `partial` is acceptable. | `systemd-run --user --scope` test; document partial. |
| A-05 | Windows `network: none` can be refused without making the product unusable. | Product decision; default Docker on Windows until a WFP/AppContainer design exists. |
| A-06 | Native performance is acceptable relative to Docker. | Measure session start/task overhead; set a threshold. |
| A-07 | Users will accept a visible `partial` enforcement label on Windows. | UI/doctor copy review; no hidden downgrade. |
| A-08 | Docker remains available as the fallback for macOS and unsupported policies. | Keep Docker tests and packaging through the deprecation window. |

### 12.2 Unknowns

| ID | Unknown | Current evidence |
|---|---|---|
| U-01 | Exact Windows ACL semantics for inherited ACEs, junctions, and UNC/`Y:\` paths. | No implementation; must be tested. |
| U-02 | Whether Node 24 + ConPTY works reliably in the packaged CLI on Windows. | No test; `node-pty` not in the repo. |
| U-03 | Landlock ABI/network coverage on the target Linux kernels. | No probe; dsh uses a static helper, but PLUTON has no equivalent. |
| U-04 | Whether server chat can be containerized without exposing the bridge on `0.0.0.0`. | Server chat is host today; bridge is loopback (`routes.ts:1043-1056`). |
| U-05 | Whether native sessions should write `sandboxes` rows at all. | No native implementation; row semantics are container-oriented. |
| U-06 | Whether terminal parity is required for the first native release. | Docker tmux is a feature; native v1 can defer attach, but this is a product decision. |

### 12.3 Facts that must not be softened

- Native execution does **not** exist at `595e8b6`. There is no `ExecutionProvider`, no `ConfinementProvider`, no ACL/bwrap/Landlock runner, no Job Object code, and no ConPTY code in `src/`.
- Docker is the only path with live container evidence; the Linux bind-mount path is **NOT RUN**.
- `local-process` is not isolation; it runs with the host user's permissions (`src/sandbox/local-process.ts:21-22`).
- SPA chat runs engines on the host even when Docker is configured (`src/server/routes.ts:1292`, `:1320`).
- Verification runs on the host even in Docker mode (`src/verify/runner.ts:141`).
- No production code calls `SandboxManager.stop()`, and there is no `sandbox stop` CLI command.
- `muses.<id>.limits` is accepted by config but not consumed by container provisioning.
- `sandbox.container_user` is documented but absent from the strict schema.

---

## 13. Recommendation

1. **Adopt the provider seam first, not a native backend.** Phase 1 is a pure Docker refactor with byte-identical behavior. It creates the seam, proves the tests, and makes the later change reversible.
2. **Fix the two host bypasses regardless of native progress.** SPA chat (GAP-01) and host verification are security/parity defects today. They should be tracked as their own issues even if native execution never ships.
3. **Ship native v1 as an acknowledged `danger-full-access` dev mode only.** It validates ACP/supervisor/bridge/workspace on the host. Do not call it isolation, do not make it the default, and do not use it for untrusted work.
4. **Then ship OS confinement, Linux first for filesystem guarantees, Windows second with an honest `partial` label.** A Windows restricted-token/ACL runner is useful but not Docker-equivalent. If `allow_partial_enforcement` is false, `workspace-write`/`read-only` must refuse on Windows until the backend is proven.
5. **Keep Docker as the reference oracle and default until the acceptance table passes.** The default switch is per platform and evidence-based. macOS native is out of scope.
6. **Do not promise terminal parity in native v1.** Either ship a confined PTY/tmux implementation with tests or return an exact `TerminalUnavailableError`; do not spawn an unconfined host shell behind a "native" label.
7. **Make the migration observable.** `doctor`, `sandbox probe`, JSON, and events must report provider, backend, enforcement, limitations, and the exact fix when unavailable. An unlabeled execution mode is a security bug.

---

## Appendix A. Recorded repository state

| Item | Value |
|---|---|
| HEAD | `595e8b6588e6deae6962c7efa40a6e09eada3ef5` |
| Branch | `main` |
| Commit | `docs: run answer-and-results audit record` (2026-10-21T20:12:46+05:30) |
| Branch/working tree | Source tree unmodified by this audit. `git status --porcelain` shows five pre-existing `docs/audit-*.png` files and the untracked `docs/audits/` directory; this report adds `docs/design/native-execution-migration-design.md`. |
| Node | `v24.20.0` |
| Platform | win32 |
| Schema | `SCHEMA_VERSION = 7` (`src/store/migrations.ts:339`) |
| Prior report | `docs/audits/source-parity-report.md` (untracked, 55,807 bytes); not overwritten. |
| Reference gap | `REA.txt` does not exist on `Y:\`; all four dsh volumes exist under `Y:\Setup\REA deepseek\`. Citations use document headings/line numbers from those volumes. |

## Appendix B. dsh corpus coverage and references

All four companion volumes were read. `REA.txt` does not exist on `Y:\`; the volumes under `Y:\Setup\REA deepseek\` are the available reference corpus. Volume `03` is the primary execution-contract source; `01`, `02`, and `04` are used for the composition seam, session/persistence discipline, ACP/native-addon packaging, testing doctrine, and cross-cutting guarantees.

| dsh location | Topic used |
|---|---|
| `01-kernel-and-composition.md:77-79` | Safety posture: not security-audited; fail loud on misconfiguration, fail closed on approval/sandbox unavailability. |
| `01-kernel-and-composition.md:117-135` | Services on the ctx key, capability seams (definition + provider + consumer), failure-loudness at load. |
| `02-agent-session-persistence.md:20-27` | Agent contract, explicit `dispose()` ownership, caller-owned teardown. |
| `02-agent-session-persistence.md:224-237` | `SessionPersistence` seam: write handle, exclusive writer, flush/close, fail-closed event vocabulary. |
| `02-agent-session-persistence.md:248-253` | Version governance, migration chain, future-version refusal, publish-beside-source. |
| `03-model-tools-capabilities.md:205-231` | Service/provider/consumer pattern; `ctx.shell`, `ctx.subprocess`, `ctx.terminals`. |
| `03-model-tools-capabilities.md:262-302` | `ctx.sandbox` contract, `ConfinedArgv`, fail-closed, Linux/Windows backends, `full`/`partial`, escalation. |
| `03-model-tools-capabilities.md:306-328` | Approval seam, fail-closed answerers, permission presets. |
| `03-model-tools-capabilities.md:437-447` | Subagent provider registry/continuity (mapping only; not a migration prerequisite). |
| `04-interfaces-delivery-reference.md:158-162` | ACP server is automation-only and deliberately omits product UI semantics. |
| `04-interfaces-delivery-reference.md:266-307` | Testing/quality split, coverage gate, snapshot replay, E2E/gate aggregation, local-vs-CI doctrine. |
| `04-interfaces-delivery-reference.md:329-332` | Native-system addon packaging, static-musl `landlock-run`, no Windows package. |
| `04-interfaces-delivery-reference.md:514-520` | Cross-cutting guarantees: one execution world, reversible disposal, fail loud/closed, snapshot integrity. |

## Appendix C. Verification statements

- This report was produced without modifying `src/`, `tests/`, `docker/`, `scripts/`, or existing docs. The only new file is this report.
- Every repository claim above was checked against the cited file at HEAD. Where a claim is structural (for example "no production caller"), it is labeled `[F]` only when a search/read supports it; otherwise `[I]`.
- The design does not assert that any native backend has been built, run, or tested. The acceptance gates in section 9 are the definition of done.

