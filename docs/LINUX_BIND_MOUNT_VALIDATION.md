# Linux bind-mount ownership validation (SECURITY.md §8.9)

> **Historical Docker procedure (superseded).** Docker and container execution were removed;
> `sandbox.kind: docker` is rejected and `tests/e2e/linux-bind-mount.e2e.test.ts` no longer
> exists. This document is retained only as a record of the pre-native validation plan. Current
> Linux confinement is documented in [`NATIVE_EXECUTION.md`](NATIVE_EXECUTION.md) and
> [`SECURITY.md`](SECURITY.md).

**Status: NOT RUN.** No native Linux Docker host was available on 2026-10-20.
This document is the reproducible procedure and the evidence record. A skipped
run, a Docker Desktop run, or a Windows run is **NOT TESTED** — never a pass.

## Why this check exists

Pluton runs each Muse in a container as `--user <uid>:<gid>` and bind-mounts
host-owned engine homes and task checkouts. On POSIX non-root hosts,
`resolveContainerUser()` (`src/sandbox/user-mapping.ts`) selects the host
`uid:gid`; Windows uses `10001:10001`. If the container identity does not line
up with the host files it must write, the worker cannot edit its checkout even
though the container started correctly.

Docker Desktop's mounts are broadly writable regardless of uid. That is useful
for the container/tmux layer but it **masks** the Linux failure mode, so it is
not evidence for this check (`SECURITY.md` §8.9).

## Required environment

- A **native Linux host** (the Docker daemon runs on the same kernel and
  filesystem as the checkout). Not Docker Desktop, not a Windows/macOS VM, not
  WSL2, and not a Linux container inside Docker Desktop.
- A **non-root** host user with Docker access (`id -u` is not `0`). The test
  skips on root because the default resolver deliberately refuses root.
- Node.js >= 24 and this repository checked out with `npm ci` already run.
- A reachable Docker daemon. The check records the versions; it is not pinned
  to one engine version, but it was authored against Docker 29.8.2.
- No userns-remap/rootless daemon is assumed. If the daemon remaps uids, record
  `docker info` security options and treat that as a separate configuration.

## Worker image and preflight

The base image is sufficient; supervised runs need the `engines` profile.

```bash
# Read-only readiness probe. For container-mode supervised runs, dispatchReady
# must be true and the recorded profile must be "engines".
node bin/pluton.js sandbox probe --json

# Build/record with the documented command — never hand-edit
# .pluton/state/worker-image.json and never bypass a drift warning.
node bin/pluton.js sandbox build-image            # base (this test)
node bin/pluton.js sandbox build-image --engines  # supervised runs

# Independent image preflight
docker image inspect pluton-worker:local --format 'id={{.Id}} user={{.Config.User}}'
docker run --rm --network none --entrypoint sh pluton-worker:local \
  -c 'id; node --version; git --version; tmux -V'
```

If `sandbox probe` reports drift (`record sha256:… vs actual sha256:…`), the
image was replaced since the last recorded build. Re-run the documented build
command; do not edit the record or skip the check.

## Disposable workspace and automated run

The test creates its own `mkdtempSync` workspace and only removes paths and
containers it created. Do not point it at a real checkout.

```bash
PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts \
  tests/e2e/linux-bind-mount.e2e.test.ts
```

The file is collected everywhere but skips unless `process.platform === 'linux'`
and `PLUTON_E2E_DOCKER=1`. The test uses the real `DockerSandboxManager` and
`resolveContainerUser({ envUser: '' })`, so it asserts the **default**
host-mapping path. An explicit `PLUTON_CONTAINER_USER` or
`sandbox.container_user` override is a different configuration and needs its
own validation.

The test also resets and reuses the same disposable host file for two full
container lifecycles, then removes everything in a final cleanup test.

## Exact assertions

| # | Assertion | Expected |
|---|---|---|
| 1 | Resolver on a native Linux non-root host | `source === "host-detected"`; `containerUser === "<host uid>:<host gid>"` |
| 2 | Container identity | `id -u` prints exactly `<host uid>` and `id -g` prints exactly `<host gid>` (`id -u -g` is invalid: GNU/POSIX `id` accepts only one choice) |
| 3 | Read a host-owned `0644` file | `cat` exits 0 and the bytes are exactly `seed\n` |
| 4 | Create and append | both writes exit 0 |
| 5 | Host-side ownership after writes | both files report `uid === host uid`, `gid === host gid`; the existing file stays mode `0644`; content is exactly `seed\nappended\n` |
| 6 | Read-only mount | write exits non-zero, stderr matches `Read-only file system`; the host directory listing is unchanged |
| 7 | Restrictive permissions | a `0700` host directory owned by the host uid denies read **and** write to a foreign `10001:10001` container; stderr matches `Permission denied` |
| 8 | Cleanup | `docker inspect <name>` fails after removal; the disposable workspace is gone; an unrelated sentinel file outside it still exists |
| 9 | Repetition | the second create/write/remove cycle preserves ownership and leaves no container |

Assertions 6–7 are the negative controls: a permissive mount or an accidental
`chmod 0777` must make them fail.

## Expected outcomes and failure interpretation

- **PASS** — all assertions hold. Record the evidence table below and update
  `SECURITY.md` §8.9 to point at the dated result.
- **FAIL, identity mismatch** — compare `id -u` and `id -g` with
  `docker inspect --format '{{.Config.User}}' <container>` and
  `resolveContainerUser()`. Do not "fix" it with `chmod 0777`.
- **FAIL, `Permission denied` on a file the host user owns** — inspect
  `stat -c '%u:%g %a' <path>` and `docker info` for userns-remap/rootless
  settings. On native Linux the expected values are the host uid/gid.
- **FAIL, read-only write succeeds** — the `--mount ...,readonly` option was
  lost; inspect `docker inspect --format '{{json .Mounts}}' <container>`.
- **FAIL, leftovers** — `docker ps -a --filter label=io.pluton.managed` shows
  the test's containers; remove only those, then re-run.
- **SKIP** — not native Linux, or `PLUTON_E2E_DOCKER` unset. This is
  **NOT TESTED**, not a pass.

## Cancellation / failure cleanup

The ownership test covers normal lifecycle cleanup. On the same Linux host,
also run the existing opt-in Docker/tmux E2E and a supervised Build cancel (see
`docs/RELEASE.md` and `tests/e2e/docker-sandbox.e2e.test.ts`), then assert:

- the run and task are durably `cancelled`;
- no engine process or `sleep infinity` container for that run remains;
- `docker ps -a --filter label=io.pluton.managed` shows no unexpected test
  containers;
- the disposable workspace is removed.

## Cleanup and safety

- The test removes only its `mkdtemp` workspace and the containers it named.
- Never run it against a real checkout or a workspace containing user data.
- Before a manual retry, find leftovers with
  `docker ps -a --filter label=io.pluton.managed` and remove only the
  containers whose names start with `pluton-e2e-linux-`.
- Do not capture env dumps, tokens, or `.env` contents. The ownership test uses
  no engine credentials.

## Evidence record

Copy this table into the dated result (do not include secrets):

| Field | Value |
|---|---|
| Date / commit | |
| Host OS and kernel | `uname -a` |
| Host identity | `id` (uid/gid, non-root) |
| Docker client/server | `docker version` |
| Docker context / backend | `docker context show`; `docker info` (`OperatingSystem`, `KernelVersion`, `SecurityOptions`) |
| Worker image | tag and `docker image inspect --format '{{.Id}}'` |
| Image preflight | `id; node --version; git --version; tmux -V` |
| Mount options | `docker inspect --format '{{json .Mounts}}' <container>` |
| Command | `PLUTON_E2E_DOCKER=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/linux-bind-mount.e2e.test.ts` |
| Result | PASS / FAIL / NOT RUN |
| Leftovers | `docker ps -a --filter label=io.pluton.managed` |

## Attempt log

### 2026-10-20 — NOT RUN (blocked environment)

- Host: Windows 11 Home Single Language, version 10.0.26300, x64.
- Docker: client and server 29.8.2; Docker Desktop 4.95.0; context
  `desktop-linux` (named pipe); `DOCKER_HOST`/`DOCKER_CONTEXT` empty.
- `docker info`: `OSType=linux`, `OperatingSystem=Docker Desktop`,
  `KernelVersion=6.18.33.2-microsoft-standard-WSL2`, `Name=docker-desktop`.
- Docker contexts: only `default` (named pipe) and `desktop-linux`; no remote
  Linux host is configured. The Linux daemon is Docker Desktop's WSL2 VM, not a
  native Linux host, so the test was **not executed**.
- Worker image preflight: `pluton-worker:local` id
  `sha256:107f7ac0f670…`, runs as `uid=10001(pluton)`, node v24.22.0, git
  2.39.5, tmux 3.3a, opencode v2.0.31 (engines profile).
- Workspace record: `.pluton/state/worker-image.json` points at
  `sha256:8110c52b…`, which does not exist locally; `sandbox probe` therefore
  reports `dispatchReady: false`. This was **not** bypassed or hand-edited.
  The disposable `.pluton-tmp/smoke-docker` project records the present
  `sha256:107f7ac0…` image and is the project used for the earlier Docker
  evidence. Run `pluton sandbox build-image --engines` in a workspace before
  expecting supervised builds there.

The test file is typechecked with the repository. That is not Linux execution
evidence; the status remains **NOT RUN**.
