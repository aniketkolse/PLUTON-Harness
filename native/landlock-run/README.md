# landlock-run

The Pluton native execution helper. One process per confined engine session.

## What it enforces

| Control | Mechanism |
| --- | --- |
| Filesystem read / write / execute | Landlock path-beneath rules (ABI 3+) |
| Network `restricted` / `none` | Private network namespace, loopback only |
| Privilege | Unprivileged user namespace (uid 0 inside, mapped to caller) |
| Mounts | Private mount namespace, private `/tmp`, fresh `/proc` |
| Process visibility | PID namespace, engine is PID 1 |
| Environment | Cleared, then exactly the request's `env` map |
| Bridge (restricted) | Loopback proxy thread -> host bridge AF_UNIX socket |

Landlock is never used as a network control. Landlock does not mediate
network sockets; network isolation comes from the network namespace.

## Protocol

`landlock-run --probe` prints one JSON object:

```json
{
  "helperAbi": 1,
  "version": "0.1.0",
  "landlockAbi": 7,
  "userNamespaces": true,
  "mountNamespaces": true,
  "networkNamespaces": true,
  "pidNamespaces": true
}
```

`landlock-run run /absolute/request.json` reads a request:

```json
{
  "helper_abi": 1,
  "mode": "workspace-write",
  "network": "restricted",
  "cwd": "/abs/checkout",
  "argv": ["/abs/engine", "--flag"],
  "env": { "PATH": "/usr/bin:/bin" },
  "read_roots": ["/abs/project", "/usr", "/bin", "/lib", "/etc"],
  "write_roots": ["/abs/checkout", "/abs/session/tmp"],
  "exec_roots": ["/usr", "/bin", "/abs/engine-dir"],
  "tmp_dir": "/abs/session/tmp",
  "private_tmp": true,
  "bridge": { "unix_path": "/abs/bridge.sock", "port": 43123 },
  "session_id": "ses_..."
}
```

The helper writes a single readiness line to inherited fd 3 after the proxy is
listening and the child has applied Landlock:

```json
{"ready":true,"helperAbi":1,"version":"0.1.0","sessionId":"ses_...","pid":123,"bridgePort":43123}
```

On startup failure the child writes `{"ready":false,"error":"..."}` instead and
exits 125. The helper never downgrades: every requested control either works or
the session does not start.

## Build

```sh
./build.sh                             # linux-x64
./build.sh aarch64-unknown-linux-musl  # linux-arm64
```

The build is static (musl). `build.sh` updates `manifest.json` with the
SHA-256 and size. The TypeScript capability check refuses a helper whose hash
or size does not match the manifest, and refuses a missing target.

arm64 must be built on an arm64 host (or with a cross toolchain); an unbuilt
target is reported unavailable and confined policies fail closed.
