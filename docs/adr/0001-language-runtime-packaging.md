# ADR-0001 — Language, runtime and module packaging

- Status: Accepted (2026-10-16)
- Deciders: Pluton implementation session

## Context

Pluton-Harness needs a CLI plus a local daemon with durable state, subprocess supervision
(engine processes, `docker`, `tmux`, `git`), and JSON/HTTP/MCP integration. The master prompt
recommends TypeScript/Node unless evidence justifies otherwise. The build environment is
Windows 11 + WSL2 (no general-purpose Linux distro with a shell) with Node v24.20.0.

## Decision

- **Language:** TypeScript, `strict` plus `noUncheckedIndexedAccess`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `isolatedModules`.
- **Runtime:** Node.js ≥ 24. Source is executed directly (`node src/cli/main.ts`) using Node's
  native type stripping; a `tsc` build (`tsconfig.build.json`, `rewriteRelativeImportExtensions`)
  produces `dist/` for packaging. Relative imports carry the `.ts` extension in source.
- **Packaging:** a **single npm package** (`pluton-harness`, private) with enforced module
  directories mirroring the conceptual architecture (`domain/ runtime/ persistence/ engines/
  orchestration/ sandbox/ terminal/ workspace/ tools/ verification/ config/ cli/`) and
  `bin: pluton`. Boundaries are enforced by dependency-direction unit tests and review, not by
  package physics.
- **Package manager:** npm (only npm is installed; no pnpm/yarn).
- **Dependency budget (deliberately small):** `commander` (CLI parsing), `zod` (config/schema
  validation), `yaml` (config files); dev: `typescript`, `vitest`, `@types/node`.
  `@modelcontextprotocol/sdk` is added when the tool bridge is implemented.

## Consequences

- No build step needed in development; CI/consumers can use `dist/`.
- TS enums/namespaces/parameter-properties are forbidden by `erasableSyntaxOnly` (string-union
  types and plain classes are used instead).
- Module boundaries are softer than real packages; a unit test asserts the intended import
  direction so the split into workspaces remains possible later without redesign.
- Zero native-addon dependencies at runtime, which matters on Windows.

## Alternatives considered

- **Many npm workspaces** as suggested in the prompt layout — rejected for this build: cross-
  workspace TS resolution and build orchestration add friction with no benefit for a local,
  private tool; the directory layout keeps the same conceptual boundaries.
- **`tsx`/`ts-node` loaders** — unnecessary; Node 24 strips types natively (verified).
- **Rust or Go daemon** — no evidence of a need; Node is the verified host runtime here.
- **pnpm/yarn workspaces** — not installed; npm is sufficient.

## Evidence

- Env recon: `node v24.20.0`, `npm 10.9.9`, no pnpm/yarn.
- Native TS probe: `node .pluton-tmp/tsprobe.ts` → `NATIVE_TS_OK`, exit 0.
- `node:sqlite` availability probe (see ADR-0002).
