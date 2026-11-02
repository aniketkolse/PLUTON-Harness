# PLUTON 4.1 Phase 3 Design Specification: Project Persistence & Dynamic Multi-Builds

- **Date:** 2026-11-03
- **Status:** Proposed (Under Review)
- **Target:** `PLUTON-Harness` on `main`

---

## 1. Intent & The Why

Pluton was initially operated primarily within a single repository working directory per process. As developers coordinate multiple repositories and microservices, requiring independent terminal windows or losing context upon directory changes impairs developer productivity.

Phase 3 introduces **project-based workspace isolation with support for concurrent multi-builds**. Developers can register multiple Pluton projects, switch between them frictionlessly from both the terminal and the web workspace, run background builds concurrently across different projects without cross-talk or event leakage, and return to existing workspaces with full conversation and run history intact.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Hybrid Project Resolution:** Predictably resolve the active project across all commands using:
  1. Explicit `--project <id>` flag
  2. Current Working Directory (CWD) if within a registered project root
  3. Global active-project pointer (`~/.pluton/active-project`)
  4. Explicit error and prompt if no project is identifiable
- **Persistent Project Registry:** Store registered projects centrally in `~/.pluton/projects.json` with atomic writes, tracking `id`, `name`, `rootDir`, `configPath`, `defaultBranch`, and `lastOpenedAt`.
- **Concurrent Multi-Build Execution:** Support background supervised builds across different projects simultaneously without mixing supervisor processes, task allocations, worker sessions, or workspace files.
- **Project-Scoped Terminal Experience:**
  - `pluton project list` (showing registered projects, directory marker, and active status)
  - `pluton project switch <id>` (atomically updates global active project without changing terminal CWD)
  - `pluton project current` (displays active project and resolution source)
  - `pluton project add <path>` and `pluton project remove <id>`
  - `pluton run list --all-projects` and `pluton build` (reusing persistent project workspaces)
- **Web Workspace Multi-Project Switching:**
  - Project switcher dropdown in header/sidebar displaying active project and running build indicators.
  - Project-scoped file explorer, session history, Ship roster, and run inspector.
  - Project-filtered Server-Sent Events (SSE) preventing cross-project event pollution while maintaining global status badges.
- **Controlled In-Project Concurrency:** Multiple builds within the same project enforce git worktree isolation or controlled sequential concurrency to prevent git/file contention.

### Non-Goals
- **Cross-Project File Merging:** Pluton will not merge branches or files across separate project repositories.
- **Distributed Remote Worker Nodes:** All builds run locally on the operator machine within native sandbox boundaries.
- **Arbitrary Shell Directory Jumping:** `pluton project switch` updates Pluton's internal active pointer; it does not attempt to mutate the calling shell's working directory (`cd`).

### Anti-Goals
- **No Shared State Leaks:** No mixing of SQLite rows, task checkouts, or chat histories between project IDs.
- **No Build Interruption on Switch:** Switching active project must never cancel, pause, or corrupt background builds.
- **No Redundant Build Confirmations:** A project with an established workspace must not repeatedly prompt the operator for basic workspace creation on subsequent builds.
- **No Brittle Name-Only Resolution:** Projects are strictly identified by stable unique IDs; display names are metadata.

---

## 3. Architecture & Key Systems

### 3.1 Central Project Registry (`~/.pluton/projects.json`)
A global registry stored in the user profile directory (`os.homedir() + '/.pluton'`), overridable via `PLUTON_HOME`.

```ts
export interface ProjectRegistryEntry {
  id: string              // Canonical SQLite project ID (e.g., project_xxxx)
  name: string            // Project display name from pluton.yaml
  slug: string            // Human-readable slug (e.g., my-app)
  rootDir: string         // Normalized absolute filesystem path
  configPath: string      // Normalized absolute path to pluton.yaml
  defaultBranch: string   // Git default branch
  registeredAt: string    // ISO-8601 timestamp
  lastOpenedAt: string    // ISO-8601 timestamp
}

export interface ProjectRegistry {
  version: 1
  activeProjectId: string | null
  projects: Record<string, ProjectRegistryEntry>
}
```

- **ID Alignment:** The `id` in `projects.json` strictly mirrors the SQLite `projects.id` primary key (`project_<timestamp><hex>`) created by `store.ensureProject`. CLI commands allow targeting by either canonical ID, slug, or normalized root path.
- **Authority & Atomic Pointer:** `projects.json` is the single authoritative source of truth. The file `~/.pluton/active-project` mirrors `activeProjectId` as a plain UTF-8 string for shell script convenience. Writes to both are atomic (write to temporary PID-tagged file, then `renameSync`).
- **Path Canonicalization:** All stored and queried filesystem paths are canonicalized (`realpathSync.native`) to avoid Windows 8.3 short-name and case-sensitivity mismatches.
- **Stale Path Detection:** If a registered project's directory or `pluton.yaml` is deleted or inaccessible, operations flag the project as unavailable and suggest `pluton project remove <id>` rather than throwing uncaught exceptions.

### 3.2 Hybrid Project Resolution Engine

Every CLI command and server request resolves its target project through `resolveProjectContext(cwd, explicitId)`:

```
[Command Invocation]
         │
         ▼
Is explicit `--project <id>` provided?
 ├── YES ──► Lookup in registry (or validate path if path given). Found?
 │             ├── YES ──► Return ProjectContext (Source: 'explicit')
 │             └── NO  ──► Throw NotFoundError("project '<id>' not registered")
 └── NO
         │
         ▼
Is CWD inside a registered project directory (or has pluton.yaml)?
 ├── YES ──► Auto-register if new, return ProjectContext (Source: 'cwd')
 └── NO
         │
         ▼
Does `~/.pluton/active-project` exist and point to valid project?
 ├── YES ──► Return ProjectContext (Source: 'global-active')
 └── NO
         │
         ▼
Throw ProjectRequiredError("no active project found; run `pluton project switch <id>` or `pluton init`")
```

### 3.3 Multi-Project Server Architecture (`src/server/`)

The application server (`startAppServer`) operates as a **Unified Multi-Project Server** (Option 1): a single local process hosts all registered projects, allowing seamless project switching in the same browser window without port redirects.

1. **Project Context Pool:** `Map<string, { store: Store, loaded: LoadedConfig, logWatcher: ServerLogWatcher, broadcaster: ServerEventBroadcaster }>` holds cached handles to project contexts and SQLite stores, dynamically opening registered projects on demand and recycling idle handles.
2. **Global Server Discovery:** The server claim/info is stored globally at `~/.pluton/run/server.json` (as well as mirrored in the launch project's `.pluton/run/server.json`). Any CLI invocation can locate the active server and delegate build queries or executions.
3. **REST Route Scoping:**
   - Routes resolve project scope via query parameter `?projectId=<id>`, header `x-pluton-project: <id>`, or falling back to the server's primary launch project.
   - Endpoints `/api/projects`, `/api/projects/switch`, `/api/projects/current` expose project enumeration, status, and metadata.
   - **Client-Scoped Web Switching:** Switching projects in the browser SPA updates that browser session/tab context (`state.activeProjectId` and URL query `?project=<id>`). It does NOT mutate the terminal's global `active-project` pointer, preventing browser actions from hijacking active CLI terminal sessions.
4. **SSE Event Multiplexing:**
   - SSE connection `/api/events?projectId=<id>` stays cleanly bound to the target project's `ServerLogWatcher` and integer `afterSeq` cursor, preventing sequence number collisions across independent databases.
   - Cross-project build activity badges are pushed via an un-replayed global heartbeat/summary event (`project_status_update`).
5. **Persistent Project Workspace Re-use:**
   - First build creates the project's primary workspace record (`workspaces` table).
   - Subsequent builds detect existing project workspace and reuse it directly, skipping redundant start-build prompts while maintaining sensitive tool execution approvals.

### 3.4 Concurrent Multi-Build Coordination

- **Run Isolation:** `startRunInBackground` operates on a specific `(ProjectContext, Store, projectId, runId)`. Background runs across Project A and Project B execute on separate Node.js event-loop tick chains, with isolated `ToolHttpServer` instances and separate native execution bridges.
- **Process & Resource Tracking:** The server maintains `activeRunTasks: Map<string, { runId: string, projectId: string, promise: Promise<RunSummary> }>`.
- **Intra-Project Concurrency Isolation:**
   - When a build is already active in Project A, a secondary build in Project A uses `GitWorkspaceManager`'s isolated checkout mechanism (adhering strictly to ADR-0005: "never shared worktrees").
   - If the operator explicitly requests single-workspace execution without checkouts while a build is already in flight, the request rejects with `409 Conflict` (`run '<id>' is currently building in this workspace`).

---

## 4. User Interface Specifications

### 4.1 CLI Commands

```bash
# List all registered projects with active / CWD indicators
pluton project list [--json]

# Switch global active project
pluton project switch <id|name>

# Show currently resolved project and source
pluton project current

# Manually register an existing project directory
pluton project add <path> [--name <name>]

# Deregister a project from registry (does not delete files)
pluton project remove <id>

# Run a build in a specific project without switching CWD or global active project
pluton build --project <id> --goal "Implement auth"

# List runs across all registered projects
pluton run list --all-projects
```

### 4.2 Web Workspace SPA

1. **Header Project Switcher:**
   - Replaces static workspace name with an interactive dropdown selector (`#projectSelectorDropdown`).
   - Lists registered projects, their root paths, and real-time status badges (e.g. `● 1 build active`).
   - Includes "+ Open Project..." action triggering folder picker.
2. **Active Project Banner:**
   - Displays current project name, default branch, and path.
3. **Project Context Switching:**
   - Switching project in dropdown updates `state.activeProjectId`, pushes `?project=<id>` to browser URL.
   - Clears and reloads file tree (`/api/files`), chat sessions (`/api/sessions`), Ships roster (`/api/ships`), and run inspector (`/api/runs`).
   - In-flight background builds in previously viewed projects continue running unimpeded.

---

## 5. Security & Isolation Guarantees

1. **File Containment:** `resolveWorkspaceFile` always evaluates paths against the target project's `rootDir` or designated session/build worktree. No project can access files in another project's root.
2. **SQLite Partitioning:** Project databases remain strictly isolated in `<rootDir>/.pluton/state/pluton.sqlite`. No shared cross-project database writes occur.
3. **Credential Segregation:** Provider credentials remain in `<rootDir>/.pluton/provider-homes/<id>/credential.json` per project, preventing cross-tenant API key leaks.
4. **Fencing & Supervisor Ownership:** SQLite heartbeat and supervisor claim fencing (`claimRunSupervisor`) guarantee that concurrent supervisor loops on identical or separate projects never collide.

---

## 6. Implementation Stages (Preview of Plan)

- **Stage 1: Central Project Registry & Storage Utilities** (`src/projects/registry.ts`, `src/projects/resolution.ts`)
- **Stage 2: CLI Project Commands** (`src/cli/commands/project.ts`, wiring into `src/cli/main.ts`)
- **Stage 3: Multi-Project Server Router & Context Pool** (`src/server/routes.ts`, `src/server/server.ts`)
- **Stage 4: Multi-Build Concurrency & Persistent Workspace Reuse** (`src/orchestrator/service.ts`, `src/server/routes.ts`)
- **Stage 5: Web Workspace Project Switcher & Scoped Views** (`src/server/static-assets.ts`)
- **Stage 6: Comprehensive Unit, Integration & Concurrency Tests**
