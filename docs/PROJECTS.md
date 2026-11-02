# Projects & Persistent Multi-Build Architecture in Pluton 4.1

Pluton 4.1 Phase 3 introduces project-based workspace isolation, persistent project registration, multi-project context management, and concurrent background builds.

Developers can register multiple Pluton projects across their workstation, switch between them frictionlessly from both the terminal and the web workspace, run background builds concurrently across different projects without event cross-talk, and return to existing workspaces with full conversation and execution history intact.

---

## 1. Central Project Registry

All registered Pluton projects are indexed in the user's global Pluton home (`~/.pluton/projects.json` by default).

### Registry Schema (`~/.pluton/projects.json`)
```json
{
  "version": 1,
  "activeProjectId": "project_mvzno59tc37506b4",
  "projects": {
    "project_mvzno59tc37506b4": {
      "id": "project_mvzno59tc37506b4",
      "name": "Frontend Web App",
      "rootDir": "/home/user/repos/frontend",
      "configPath": "/home/user/repos/frontend/pluton.yaml",
      "defaultBranch": "main",
      "registeredAt": "2026-11-03T01:00:00.000Z",
      "lastUsedAt": "2026-11-03T01:00:00.000Z"
    }
  }
}
```

### Key Guarantees
- **Canonical IDs**: Projects are assigned stable unique identifiers in the format `project_<timestamp><hex>`. Project identification never relies solely on display names.
- **Active Project Pointer**: `~/.pluton/active-project` stores the currently active canonical project ID.
- **Atomic Operations**: Registration and project state writes use atomic temporary-file renames with Windows lock tolerance.

---

## 2. Four-Tier Hybrid Project Resolution

Whenever a Pluton command or execution context runs, the target project is resolved according to a strict 4-tier precedence hierarchy:

```
Priority 1: Explicit CLI Flag (--project <id|name|prefix>)
   ↓ (not provided)
Priority 2: Working Directory (CWD is inside a registered project)
   ↓ (CWD outside registered projects)
Priority 3: Global Active Project (~/.pluton/active-project pointer)
   ↓ (no active pointer or target directory unmounted)
Priority 4: ProjectRequiredError (or auto-register if CWD contains a fresh pluton.yaml)
```

1. **Explicit Flag (`--project <id|prefix|name>`)**: Overrides all environment cues. Resolves by exact ID, unique prefix, or exact name match.
2. **Current Working Directory (CWD)**: If the current directory or any parent is registered, that project is resolved automatically without requiring manual switching.
3. **Global Active Project (`~/.pluton/active-project`)**: If run from an unassociated directory, Pluton defaults to the globally active project.
4. **Fails Closed**: If no registered project is active or found, Pluton aborts safely with `ProjectRequiredError`, providing clear remediation steps.

---

## 3. CLI Project Management

### Listing Registered Projects
```bash
pluton project list [--json]
```
Outputs a table of all registered projects, showing active status, name, ID, and root directory.

### Showing the Current Active Project
```bash
pluton project current [--json]
```
Displays the active project ID, name, root directory, and default branch.

### Switching the Active Project
```bash
pluton project switch <id|name|prefix>
```
Updates `~/.pluton/active-project` and the registry's `lastUsedAt` timestamp. Note: Switching the active project never alters or terminates ongoing background builds.

### Registering an Existing Project
```bash
pluton project add [path] [--name <custom-name>]
```
Registers the project directory located at `[path]` (defaults to current working directory). Validates the presence of `pluton.yaml`.

### Removing a Project from the Registry
```bash
pluton project remove <id|name> [--json]
```
Deregisters the project from Pluton's index. Does not delete user repository files on disk.

### Renaming a Project
```bash
pluton project rename <id|name> <new-name>
```
Atomically updates the project display identity across:
1. `pluton.yaml` (`project.name`), preserving formatting and YAML comments.
2. Local SQLite store (`projects.name`).
3. Central registry (`~/.pluton/projects.json` name and slug).
The project's filesystem path, canonical ID, and active runs are preserved without moving directories.

### Global Project Flag
Every primary Pluton CLI command accepts the global `--project <id|name>` option:
```bash
# Start a chat session on a specific registered project
pluton chat --project frontend

# Run an orchestration build on another project without changing CWD
pluton run --project backend --goal "Implement user authentication endpoint"

# View status of a specific project
pluton status --project mobile-app

# View runs across all registered projects
pluton status --all-projects
```

---

## 4. Multi-Build Coordination & Concurrency Isolation

Pluton coordinates concurrent execution across projects while preventing intra-project file contention:

1. **Cross-Project Concurrency**: Background builds (`pluton run`) running in separate projects execute concurrently without blocking or event leakage. Each project operates against its own isolated SQLite store (`.pluton/pluton.db`), SSE broadcaster, and execution log watcher.
2. **Persistent Workspace Reuse**: The first Build in a project establishes the active `project_sessions` workspace and increments `build_count`. Subsequent builds reuse the persistent workspace without redundant confirmation prompts (`buildCount > 0`).
3. **Dynamic Planning Refinement**: When a new Build starts within an established project session, the supervisor extracts prior-build lineage (up to 5 recent builds, task status histograms, and unfinished task titles) and instructs the manager to refine the existing architecture and plan rather than recreating from scratch.
4. **Intra-Project Concurrency Control**: Starting a concurrent build on an active workspace within the same project is detected and protected with an immediate `409 Conflict` (or worktree isolation), preventing corrupted git index states and colliding file edits.
5. **Fencing and Heartbeats**: SQLite heartbeat and supervisor claim fencing (`claimRunSupervisor`) guarantee that concurrent supervisor loops never collide.

---

## 5. Web Workspace Multi-Project Integration

Pluton's web workspace provides unified multi-project access hosted by a single application server process (`pluton web`):

### Project Selector Dropdown
- Located in the application header (`projectSelectDropdown`, `projectSelectBtn`).
- Displays the active project name, root directory, and dropdown menu of all registered projects.
- Clicking any project switches the active project in the browser session immediately.

### Project Identity & Persistent Settings
- Settings tab includes the Project Identity card (`#projectIdentityCard`, `#projectNameInput`, `#btnSaveProjectName`).
- Operators can rename project display names in-place via `PATCH /api/projects/:id`.
- The initial Build dialog allows naming the project (`#buildConfirmProjectName`) before kicking off the first build.
- Shows persistent project session metadata (`#projectIdentityMeta`), including build counts, creation timestamps, and root workspace directory.

### Client-Scoped Project Context
- Web client operations pass the selected project ID in HTTP headers (`X-Pluton-Project: <id>`) and query parameters (`?projectId=<id>` or `?project=<id>`).
- Switching projects in the web interface updates the browser URL (`?project=<id>`) and client state **without** overwriting the terminal's global `~/.pluton/active-project` pointer.
- Live Server-Sent Events (`/api/events?projectId=<id>`) dynamically route events for the active project so background activities in other projects do not contaminate the active view.
- Sessions, file browser trees, model configurations, and run activity cards automatically scope to the selected project.
