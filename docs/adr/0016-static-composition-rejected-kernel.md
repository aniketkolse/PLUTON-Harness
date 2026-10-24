# ADR-0016 — Static Composition, Not a Runtime Plugin Kernel

- Status: Accepted (2026-10-25)
- Deciders: Core Architecture Team
- References: ADR-0001 (Language Runtime), ADR-0003 (Engine Adapter Protocol), ADR-0014 (Shared Desktop & Browser Architecture), ADR-0015 (Desktop Delivery)

## Context

The DeepSeek Harness reference describes a **runtime plugin kernel** (Cordis 4.x): the host boots a
kernel, every feature — the CLI surface, the chat UI, ~55 `ui-*` packages, jobs, approvals, the
directory picker — is a dynamically loaded plugin with its own lifecycle, and a plugin market plus
hot module replacement supply extensions without restarting the process.

PLUTON reaches the same feature set through **static composition**: explicit TypeScript imports and
small registries that are populated at boot and never mutated afterwards.

| Surface | PLUTON mechanism | Kernel alternative (rejected) |
| --- | --- | --- |
| Engines | `registerBuiltinEngines()` → `Map<kind, EngineFactory>` (`src/engines/registry.ts`) | dynamic engine plugin load |
| Tools | fixed catalog + `operator-catalog.ts` (`src/tools/`) | runtime tool-plugin market |
| CLI | one Commander tree (`src/cli/main.ts`) | per-command plugin packages |
| UI | one SPA asset + shared `ui/` + `tui/` modules | ~55 independently versioned `ui-*` plugins |
| Config | typed schema → immutable `LoadedConfig` (`src/config/schema.ts`) | profile/patch composition at runtime |
| Packaging | one Node process, one `dist/` build | kernel + separately installed plugin graph |

The kernel buys extension without a fork; it costs a lifecycle API, version-skew support, a trust
boundary for third-party code, and a debugging model where "which plugin owns this behaviour?" is a
runtime question. PLUTON is local-first and single-operator: its extension pressure is low, while its
security and debuggability requirements are high.

## Decision

**Keep static composition. Do not adopt a runtime plugin kernel, plugin marketplace, HMR, or a
separate Electron/Python host to mirror the reference's architecture.**

1. **Registries are boot-time constants.** A registry is populated once during startup and is
   read-only afterwards. Adding a capability is a source change with a compile-time contract, a
   test, and a review — not an install step.
2. **No arbitrary code loading.** PLUTON never `import()`s code from a project, a config file, a
   network location, or a user plugin directory. The only executable extension surface remains the
   engine adapter contract (ADR-0003), whose implementations ship in the package and are selected by
   a validated `engine:` value.
3. **Explicit dependencies, one composition root.** `src/cli/main.ts` and `src/bootstrap.ts` wire
   modules together. Modules do not discover each other at runtime. Dependency direction is
   machine-checked (`tests/unit/module-boundaries.test.ts`).
4. **Market, HMR, and alternate hosts stay rejected.** A plugin market, hot reload, an Electron
   replacement, and a Python SDK are not feature-parity gaps to close; they are architecture the
   reference chose for a different product boundary.

## Revisit triggers

Revisit this decision only when **all** of the following are demonstrated, not projected:

- a concrete third-party extension with an owner and a support commitment exists;
- the extension cannot be expressed as an engine adapter, a config value, or a tool in this repo;
- static composition has become the measured bottleneck (e.g. every extension forces a fork or a
  release-train conflict).

If revisited, prefer a **manifest + declared-capability contract** with process isolation over
in-process arbitrary code loading, and write a superseding ADR before implementation. If a future
extension wants profile/patch config composition only, that is a config-schema change (ADR-0002
migration rules), not a plugin kernel.

## Consequences

### Positive

- One build, one process, one dependency graph: `npm pack` contents and startup order are knowable
  from the source tree.
- The trust boundary stays small: no third-party code executes inside the Pluton process, and no
  plugin can mutate durable state without going through `Store`.
- Failures are reproducible from a commit, not from a lockfile of plugin versions.
- The module-boundary and capability-conformance tests can pin the whole composition surface.

### Negative

- Third-party extension requires a contribution or a fork; there is no install-a-plugin story.
- Adding an engine/tool/UI feature touches the central registries and the CLI tree.
- We forgo HMR during UI development; the dev loop is a rebuild/restart.

### Neutral

- The kernel's genuinely useful ideas — explicit capability records, lifecycle states, and
  inspectable registries — are adopted in substance (typed `EngineCapabilities`, A7 conformance
  test, static registry inspection) without adopting its dynamic machinery.
