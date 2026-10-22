# Third-party notices — Pluton-Harness

Pluton-Harness is an independent project. It is **not affiliated with** Cloudroom, OpenMausBot,
OpenCode, or their maintainers. Those repositories were studied read-only at recorded commits for
architectural patterns; see `docs/reverse-engineering/reuse-and-license-audit.md`. No source code
from them is copied or vendored in this milestone.

## Runtime dependencies

| Package | Version | License | Use |
|---|---|---|---|
| commander | 15.0.0 | MIT | CLI argument parsing |
| zod | 4.6.7 | MIT | schema validation (config, IPC payloads) |
| yaml | 2.9.1 | ISC | `pluton.yaml` parsing |

## Development dependencies

| Package | Version | License | Use |
|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | type checking / build |
| vitest | 5.0.5 | MIT | test runner |
| @types/node | 26.6.5 | MIT | Node type definitions |

`node:sqlite` is a module of the Node.js runtime (MIT-licensed project), not a bundled dependency.

## External engines driven at runtime (installed separately by the operator, not bundled)

| Engine | Version verified | License (as shipped) | Use |
|---|---|---|---|
| OpenCode CLI (`opencode` / `opencode-ai`) | v2.0.32 | MIT | supported engine, driven over `opencode acp` (stdio JSON-RPC) |

OpenCode is a separate product installed outside this repository. Pluton starts it as a child
process through its documented CLI flags (argv arrays, never shell strings) and communicates
over its official structured protocol. No engine code is copied, vendored, patched or
redistributed by Pluton; the engine receives neither Pluton's own source nor secrets beyond the
documented credential environment allowlist (ADR-0008). See ADR-0003 for the verified protocol
facts and selection rationale. Qwen Code support was removed in the OpenCode-only migration and
is no longer a runtime dependency.

## Reference repositories (studied, not incorporated)

| Repository | Commit studied | License | Reuse |
|---|---|---|---|
| davidondrej/cloudroom-core | `3949daaea3c7613458e9ad14afddbd267a0a56bc` | Apache-2.0 | None (concept-level study only) |
| milind-soni/OpenMausBot | `7d008053cbdb255c2078fbf772630e634000dce5` | Apache-2.0 except `enterprise/` (source-available; production requires a license key) | None (concept-level study only); `enterprise/` never consulted for implementation |

Trademarks: the OpenMausBot/MausBot names and mascot are trademarks of their owner; Pluton does
not use them. OpenCode is used as an external engine via its documented CLI protocol and is not
bundled or modified.

## License of Pluton-Harness itself

Pluton-Harness is licensed under the Apache License, Version 2.0.
See [`LICENSE`](LICENSE) in the root directory.
