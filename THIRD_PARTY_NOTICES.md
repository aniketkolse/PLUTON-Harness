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

## Reference repositories (studied, not incorporated)

| Repository | Commit studied | License | Reuse |
|---|---|---|---|
| davidondrej/cloudroom-core | `3949daaea3c7613458e9ad14afddbd267a0a56bc` | Apache-2.0 | None (concept-level study only) |
| milind-soni/OpenMausBot | `7d008053cbdb255c2078fbf772630e634000dce5` | Apache-2.0 except `enterprise/` (source-available; production requires a license key) | None (concept-level study only); `enterprise/` never consulted for implementation |

Trademarks: the OpenMausBot/MausBot names and mascot are trademarks of their owner; Pluton does
not use them. OpenCode is used as an external engine via its documented CLI protocols and is not
bundled or modified.

## License of Pluton-Harness itself

Undecided — the repository is currently `private` with `license: UNLICENSED` in `package.json`.
This is an explicit owner decision, recorded in ADR-0011.
