# Docker-Free PLUTON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Docker entirely unnecessary for PLUTON installation, startup, task execution, terminal attachment, verification, and multi-agent orchestration, establishing native execution as the default runtime.

**Architecture:** Switch configuration and template defaults to `sandbox.kind: native` with `runtime.network_policy: open`. Implement host-native terminal management and attachment via `NativeTerminalManager` (`tmux` on host when available; clean fail-closed when absent). Update `doctor`, `init`, `attach`, and CLI help to eliminate Docker requirements. Add guard tests verifying zero Docker invocations during native lifecycle. Author migration guide and acceptance report.

**Tech Stack:** Node.js 24+, TypeScript ESM, SQLite (`node:sqlite`), Vitest, Git.

**Spec:** `docs/design/native-execution-migration-design.md` and user requirements.

## Global Constraints

- Default configuration and onboarding (`pluton init`, templates) must be 100% Docker-free.
- Native engine, terminal, workspace, approval, and verification lifecycle must operate without Docker.
- Working directory confinement within allowed project/workspace roots and environment variable allowlisting are preserved.
- Process trees must be terminated cleanly without container reliance (`taskkill` on Windows, process groups on POSIX).
- Platform-specific sandbox limitations must be reported honestly (`enforcement: 'partial'`).
- Add tests that fail if normal native runtime attempts to invoke `docker`.

## Review Focus

1. **Onboarding & Init**: `pluton init` on a clean machine without Docker must produce a valid configuration that starts without warnings or errors.
2. **Doctor Diagnostics**: `pluton doctor` must pass on a host without Docker CLI or Docker daemon installed when native mode is configured.
3. **Terminal Attachment**: `pluton attach` must resolve and attach to native host terminal sessions without invoking `docker exec`, and report exact errors if host tmux is missing.
4. **Approval & Dynamic Muse Provisioning**: Applying a proposed Muse in approvals must not attempt container provisioning when in native mode.
5. **Docker Execution Guard**: Any execution of the `docker` binary during native onboarding, probe, run, chat, or verification must trigger an immediate test failure.

---

### Task 1: Docker-Free Default Configuration and Onboarding

**Files:**
- Modify: `src/config/schema.ts:118-134`
- Modify: `templates/teams/full-stack.yaml:17-28`
- Modify: `templates/teams/bugfix.yaml:10-21`
- Modify: `templates/teams/repository-analysis.yaml:10-20`
- Test: `tests/unit/config.test.ts`
- Test: `tests/unit/native-config.test.ts`

**Interfaces:**
- `sandboxConfigSchema`: `kind` defaults to `'native'`.
- `runtimeConfigSchema`: `network_policy` defaults to `'open'`.
- `nativeSandboxConfigSchema`: sets `acknowledge_partial_enforcement` and `acknowledge_host_network` defaults for seamless configuration.
- Templates provide `sandbox.kind: native` with explicit partial enforcement acknowledgements.

- [ ] **Step 1: Write failing test in `tests/unit/config.test.ts` expecting `native` default**

```ts
it('defaults sandbox.kind to native and network_policy to open', () => {
  const parsed = plutonConfigSchema.parse({
    version: 1,
    project: { name: 'test-proj' },
    muses: {
      manager: {
        role: 'supervisor',
        engine: 'mock',
        model: 'mock/model',
      },
    },
  })
  expect(parsed.sandbox.kind).toBe('native')
  expect(parsed.runtime.network_policy).toBe('open')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts -t "defaults sandbox.kind to native"`
Expected: FAIL (currently defaults to 'docker')

- [ ] **Step 3: Update `src/config/schema.ts` and `templates/teams/*.yaml`**

Update `sandboxConfigSchema` in `src/config/schema.ts` to default `kind` to `'native'`, update `runtimeConfigSchema` to default `network_policy` to `'open'`, and update all team templates in `templates/teams/` to specify `sandbox.kind: native`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts tests/unit/native-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts templates/teams/ tests/unit/config.test.ts tests/unit/native-config.test.ts
git commit -m "feat(config): default sandbox to native and update team templates"
```

---

### Task 2: Host Native Terminal Attachment Lifecycle

**Files:**
- Create: `src/terminal/native.ts`
- Modify: `src/terminal/attach.ts:30-44`, `src/terminal/attach.ts:81-118`
- Modify: `src/cli/commands/attach.ts:63-115`
- Test: `tests/unit/attach.test.ts`
- Test: `tests/integration/cli-attach.test.ts`

**Interfaces:**
- Consumes: `TerminalManager` from `src/terminal/types.ts`.
- Produces: `NativeTerminalManager` in `src/terminal/native.ts` driving host `tmux` sessions directly (or honest error when tmux is not on host PATH).
- `buildAttachArgv`: Supports native mode returning `['tmux', 'attach-session', '-t', tmuxTarget]`.
- `attachToMuseTerminal`: Handles `sandboxKind === 'native'` without requiring Docker containers.

- [ ] **Step 1: Write failing tests for native terminal attachment in `tests/unit/attach.test.ts`**

```ts
it('builds host tmux argv for native sandbox target', () => {
  const argv = buildAttachArgv({ sessionName: 'pluton-proj-worker' }, 'native')
  expect(argv).toEqual(['tmux', 'attach-session', '-t', '=pluton-proj-worker'])
})

it('attaches to native host terminal session without docker', async () => {
  const manager = new FakeTerminalManager()
  const spawned: string[][] = []
  const outcome = await attachToMuseTerminal({
    sandboxKind: 'native',
    manager,
    target: { sessionName: 'pluton-proj-worker' },
    spawnAttach: (argv) => {
      spawned.push(argv)
      return Promise.resolve(0)
    },
  })
  expect(outcome.exitCode).toBe(0)
  expect(spawned[0]).toEqual(['tmux', 'attach-session', '-t', '=pluton-proj-worker'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/attach.test.ts -t "native"`
Expected: FAIL

- [ ] **Step 3: Implement `NativeTerminalManager` and update `attach.ts`**

Implement `NativeTerminalManager` in `src/terminal/native.ts` that executes host `tmux` commands. Update `buildAttachArgv` and `attachToMuseTerminal` in `src/terminal/attach.ts` to branch on `sandboxKind: 'native'`. Update `src/cli/commands/attach.ts` to instantiate `NativeTerminalManager` when `sandbox.kind === 'native'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/attach.test.ts tests/integration/cli-attach.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/terminal/ src/cli/commands/attach.ts tests/unit/attach.test.ts tests/integration/cli-attach.test.ts
git commit -m "feat(terminal): add native host terminal manager and attach support"
```

---

### Task 3: Doctor Diagnostics and CLI Help Alignment

**Files:**
- Modify: `src/cli/commands/doctor.ts:60-103`, `src/cli/commands/doctor.ts:220-255`
- Modify: `src/cli/main.ts:530-580`, `src/cli/main.ts:1030-1060`
- Test: `tests/integration/cli-status.test.ts` (or doctor test)

**Interfaces:**
- `doctor`: In native mode, Docker CLI and daemon are marked optional/info and never cause a `fail` status. WSL2 is not required on Windows for native execution.
- `main.ts`: CLI help text for `sandbox` and `attach` reflects native first-class support.

- [ ] **Step 1: Write unit test verifying `doctor` passes in native mode without Docker**

```ts
it('reports healthy doctor checks for native mode when docker is absent', async () => {
  // test doctor with native config and mocked absence of docker
})
```

- [ ] **Step 2: Run test to verify failure or test doctor behavior**

Run: `npx vitest run tests/integration/doctor.test.ts`

- [ ] **Step 3: Update `src/cli/commands/doctor.ts` and `src/cli/main.ts`**

Make Docker checks conditional: if `sandbox.kind !== 'docker'`, Docker is reported as optional (`info`) rather than `fail`. Update CLI command descriptions.

- [ ] **Step 4: Run test and doctor CLI to verify**

Run: `npx vitest run tests/unit/ tests/integration/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli/main.ts
git commit -m "fix(doctor): remove docker requirement from healthy native diagnostics"
```

---

### Task 4: Runtime Guard Tests (Assert Zero Docker Invocations)

**Files:**
- Create: `tests/integration/docker-free-runtime.test.ts`

**Interfaces:**
- Consumes: `runInit`, `runRun`, `sandboxProbe`, `doctor` across clean directories.
- Produces: Guard asserting that no `docker` process is ever spawned during native operations.

- [ ] **Step 1: Write integration guard test in `tests/integration/docker-free-runtime.test.ts`**

Implement tests that run:
1. `runInit` (project onboarding).
2. `sandboxProbe` (substrate probe).
3. `runDoctor` (diagnostics).
4. `runRun` (multi-agent execution).
5. `attachToMuseTerminal` (terminal plan mode).
With a process interceptor or PATH stub that records any attempt to call `docker` and fails if any invocation occurs.

- [ ] **Step 2: Run test to verify it passes against native provider**

Run: `npx vitest run tests/integration/docker-free-runtime.test.ts`
Expected: PASS with 0 Docker invocations.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/docker-free-runtime.test.ts
git commit -m "test: add guard test verifying zero docker invocations in native runtime"
```

---

### Task 5: Documentation, Migration Note, and Acceptance Report

**Files:**
- Create: `docs/MIGRATION.md`
- Create: `docs/ACCEPTANCE_REPORT.md`
- Modify: `docs/SECURITY.md`
- Modify: `README.md`

**Interfaces:**
- `docs/MIGRATION.md`: Step-by-step instructions for converting existing `pluton.yaml` from `docker` to `native`.
- `docs/ACCEPTANCE_REPORT.md`: Audit of all Docker references in the repository with rationale, verification matrix proving Docker-free operation, and platform sandbox notes.

- [ ] **Step 1: Author `docs/MIGRATION.md`**

Document migration path: updating `sandbox.kind: native`, configuring `acknowledge_partial_enforcement` and `acknowledge_host_network`, handling terminal sessions, and workspace compatibility.

- [ ] **Step 2: Author `docs/ACCEPTANCE_REPORT.md`**

Document full audit of remaining Docker references (isolated in `src/sandbox/docker.ts` as legacy opt-in), test run verification results, and platform isolation capabilities.

- [ ] **Step 3: Update `docs/SECURITY.md` and `README.md`**

Ensure all claims reflect native partial enforcement without relying on container isolation.

- [ ] **Step 4: Commit**

```bash
git add docs/MIGRATION.md docs/ACCEPTANCE_REPORT.md docs/SECURITY.md README.md
git commit -m "docs: add native execution migration guide and acceptance report"
```

---

### Task 6: Full Verification Suite

**Files:**
- All source, tests, and documentation.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: 100% pass across all unit, integration, and E2E suites.

- [ ] **Step 4: Run live demo script with Docker disabled**

Run: `node scripts/demo-native-run.mjs`
Expected: exit 0, completed run with isolated checkouts and durable SQLite events.
