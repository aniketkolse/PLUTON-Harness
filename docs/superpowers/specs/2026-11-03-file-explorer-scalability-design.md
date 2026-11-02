# PLUTON 4.1 Phase 5 Design Specification: File Explorer Scalability, Lazy Tree & Deep Navigation

- **Phase**: PLUTON 4.1 Phase 5
- **Audit items addressed**: Item 12 (Recursive file browsing, search, breadcrumbs), Item 13 (Large/deep directory support, remove 300-file silent truncation)
- **Author**: Pluton Core Architecture Team
- **Date**: 2026-11-03
- **Status**: Proposed / Under Review

---

## 1. Intent and Why

Pluton's Files tab allows operators to inspect and edit code files within the active project workspace. In versions 4.0 and 4.1 Phase 1–4, the backend implementation of `GET /api/files` relied on a synchronous directory walker (`listWorkspaceFiles`) with a hardcoded `maxFiles = 300` limit. In any non-trivial repository (or repositories where `node_modules`, `tests`, or root assets exceed 300 items), the walk terminated prematurely, silently hiding deeply nested files and directories from the operator.

Furthermore, the frontend file tree re-rendered the entire DOM tree on every background poll, resetting folder expansion states, and lacked path-based searching, breadcrumb navigation, and multi-file tabs.

Phase 5 addresses these limitations by introducing:
1. An on-demand, lazy-loading directory API with deterministic offset/limit pagination for large folders.
2. A recursive, bounded file search endpoint across nested project directories.
3. Strict multi-project context isolation across all file endpoints and frontend state stores.
4. An interactive frontend navigation experience: lazy tree nodes, state persistence across folder toggles, search input, breadcrumbs, multi-file editor tabs with unsaved change protection, and clean flat iconography.
5. Uncompromised containment security ensuring traversal attacks, symlink escapes, and protected secrets (`.git`, `.pluton`, `.env*`, `node_modules`) are strictly denied.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Unlimited Practical Depth**: Allow operators to browse arbitrarily nested folders (6–8+ levels) smoothly.
- **On-Demand Lazy Loading**: Subdirectories load their immediate children on demand upon expansion rather than walking the whole filesystem at once.
- **Pagination for Giant Folders**: Directories containing >500 items support deterministic pagination (`offset`, `limit`) so large directories never lock the process or UI.
- **Fast Recursive Search**: Allow searching filenames and relative paths with a 100-result cap and clear truncation messaging.
- **Stable Navigation State**: Remember expanded folders, active tabs, cursor positions, and selected files per project. Navigating or polling never collapses the tree.
- **Multi-File Editor Tabs**: Support opening multiple files in tabbed panes, switching between them, preserving unsaved edits, and warning before closing dirty tabs.
- **Strict Project Isolation**: Enforce explicit project identification (`X-Pluton-Project` or `?projectId=`) on all directory, file read, write, and search requests.
- **Enterprise-Grade Security**: Strict lexical and realpath containment; rejection of directory traversal (`..`), symlink escapes, Windows unstable segments, and access to internal state or secrets.

### Non-Goals
- Full web-based IDE (monaco-editor, language server protocol, multi-cursor, git gutter). Pluton uses its lightweight embedded code editor.
- Editing binary files, multimedia, or files >2MB in the web editor (they are identified and blocked with clear error messaging).
- Searching file content (full-text ripgrep/grep search across entire workspace). Phase 5 focuses on path and filename discovery; full-text search belongs in a future agentic tool/endpoint.

### Anti-Goals
- **Do not read the entire project into memory**: Never walk the whole filesystem at once or load unbounded directory trees.
- **Do not bypass `resolveWorkspaceFile` / `safeResolvePath`**: Never create a separate uncontained filesystem reader.
- **Do not leak cross-project files**: Never allow one project's files or tabs to bleed into another project's workspace view.

---

## 3. Architecture & Key Technical Decisions

### Decision 1: On-Demand Directory Endpoint (`GET /api/files`)
Instead of returning only a flat array of all files, `GET /api/files` supports query parameters:
- `dir`: workspace-relative directory path (default `""` for root).
- `offset`: integer offset for pagination (default `0`).
- `limit`: integer limit (default `500`, max `1000`).
- `sessionId`: optional session workspace override.
- `projectId`: explicit project selector.

**Response Schema**:
```json
{
  "ok": true,
  "dir": "src/server",
  "entries": [
    { "name": "activity.ts", "path": "src/server/activity.ts", "type": "file", "size": 10420, "modified": 1792080000000 },
    { "name": "routes.ts", "path": "src/server/routes.ts", "type": "file", "size": 89400, "modified": 1792080000000 },
    { "name": "views", "path": "src/server/views", "type": "dir", "size": 0, "modified": 1792080000000 }
  ],
  "files": [
    "src/server/activity.ts",
    "src/server/routes.ts",
    "src/server/views"
  ],
  "total": 3,
  "hasMore": false,
  "offset": 0,
  "limit": 500,
  "rootDir": "C:\\Work\\App"
}
```
*Backwards compatibility note*: The response includes both `entries` (typed item details) and `files` (`entries.map(e => e.path)`) so existing test assertions and callers continue to function without disruption. Entries are deterministically sorted: directories first (alphabetical), then files (alphabetical).

### Decision 2: Recursive File Search Endpoint (`GET /api/files/search`)
- Query parameters: `q` (search query string), `limit` (default `100`, max `200`), `sessionId` (optional session workspace), `projectId` (explicit project).
- **Runaway & Event Loop Protection**: Traverses files and directories with a strict safety cap of 10,000 scanned entries or `limit` matches. If either limit is hit, traversal halts immediately and returns `truncated: true`.
- Excludes protected segments (`.git`, `.pluton`, `node_modules`, `dist`, `coverage`, `.DS_Store`) and secret patterns (`.env`, `.env.*`).
- Returns matching relative paths and item types (`type: "file" | "dir"`):
```json
{
  "ok": true,
  "query": "routes",
  "matches": [
    { "name": "routes.ts", "path": "src/server/routes.ts", "type": "file" },
    { "name": "views", "path": "src/server/views", "type": "dir" }
  ],
  "totalMatches": 2,
  "truncated": false
}
```
- In the UI: clicking a file match opens it in the editor and reveals/highlights it in the tree; clicking a directory match reveals and expands that folder in the tree.

### Decision 3: Directory Resolution Security (`resolveWorkspaceDir`)
Implement `resolveWorkspaceDir(rootDir, targetDir)` in `src/server/routes.ts` mirroring `resolveWorkspaceFile`:
1. Resolve target relative to `rootDir` with `safeResolvePath`. Return 403 if target escapes root.
2. Check `protectedWorkspaceSegment` on lexical path. Return 403 if `.git`, `.pluton`, or `node_modules`.
3. Resolve realpath of `rootDir` and `targetDir`. Return 404 if directory does not exist.
4. Verify canonical containment: `!canonicalRel.startsWith('..') && !isAbsolute(canonicalRel)`.
5. Check `protectedWorkspaceSegment` on canonical path.
6. Verify `statSync(canonical).isDirectory()`. Return 400/404 if it is a file or special device.
7. Return canonical directory and canonical relative path.

### Decision 4: Project & Session Context Routing on All File Endpoints
Ensure `targetProj = this.getTargetProject(req, parsedUrl)` is passed to `this.workspaceRootFor(...)` across:
- `GET /api/files`
- `GET /api/files/search`
- `GET /api/files/content`
- `PUT /api/files/content`
- `DELETE /api/files/content`

### Decision 5: Frontend State Separation & Multi-File Tabs
State in `src/server/static-assets.ts`:
- Frontend state is keyed by a composite context key `contextKey = projectId + ':' + (activeSessionId || 'default')`.
- `state.projectFileState[contextKey]`:
  - `expandedDirs`: Set of directory paths currently expanded in this context.
  - `selectedPath`: Currently focused path in file tree.
  - `openTabs`: Array of tab objects `{ path, content, originalContent, isDirty, scrollPos, cursorOffset }`.
  - `activeTabPath`: Currently displayed tab.
- When switching projects or sessions, active tabs, dirty buffers, and file tree state are preserved in that context's slot without loss or cross-talk.
- Tab bar above the editor (`#fileTabsBar`):
  - Click tab: activate that tab, restore cursor and scroll.
  - Close button `×`: if dirty, prompt operator confirmation (`plutonConfirm`) before closing.
  - Dirty dot `●` indicates unsaved changes.
  - Ctrl+S saves current active tab.

### Decision 6: Breadcrumb Navigation
Above the editor and tree, breadcrumb elements render ancestor segments:
`Root > src > server > routes.ts`
Clicking an ancestor directory auto-navigates and expands that directory in the tree.

---

## 4. Detailed Component Specifications

### 4.1 Backend APIs
1. **`GET /api/files`**
   - Query: `dir`, `offset`, `limit`, `sessionId`, `projectId`.
   - Reads immediate entries using `readdirSync(canonical, { withFileTypes: true })`.
   - Filters out `ignored` (`dist`, `.DS_Store`, `coverage`, `.git`, `.pluton`, `node_modules`).
   - Slices deterministic page `entries.slice(offset, offset + limit)`.
   - Returns `{ ok: true, dir, entries, total, hasMore, offset, limit, rootDir }`.

2. **`GET /api/files/search`**
   - Query: `q`, `limit` (default 100).
   - Breadth-first or bounded depth search for `q` inside file and directory relative paths.
   - Skips protected segments and symlinks pointing outside.
   - Caps at `limit`. Flags `truncated: true` if matches exceeded limit.

3. **`GET /api/files/content`**, **`PUT /api/files/content`**, **`DELETE /api/files/content`**
   - Fix missing `targetProj` parameter in PUT/DELETE.
   - Guard against files > 2MB and binary encoding.

### 4.2 Frontend File Explorer & Editor
1. **Tree Rendering (`#filesList`)**:
   - Top-level folders rendered with chevron icons (`file-chevron`) and folder icons (`file-icon-dir`).
   - Clicking a folder:
     - If not loaded: fetches `GET /api/files?dir=<path>`, renders children inside `.file-children`, adds path to `expandedDirs`.
     - If loaded: toggles `.is-collapsed` and aria-expanded without wiping DOM.
   - If folder has `hasMore`: renders a "Load more..." button at the end of the folder child list.
2. **Search Header (`#fileSearchInput`)**:
   - Filter input at top of files sidebar.
   - Debounced (250ms). Cancels previous in-flight requests using request token/timestamp.
   - Shows matching paths in dropdown or search view.
   - Clicking a search result opens the file, adds parents to `expandedDirs`, and highlights the node.
3. **Editor Tabs Bar (`#fileTabsBar`)**:
   - Horizontal tab container inserted above `#fileViewerHeader`.
   - Each tab has icon, filename, dirty indicator, and close button.
   - Switching tabs preserves `textarea.selectionStart`, `scrollTop`, and unsaved content.
4. **Breadcrumbs (`#fileBreadcrumbs`)**:
   - Situated in file viewer header.
   - Clickable segments trigger folder reveal.
5. **Iconography**:
   - Minimal flat SVG icons for directories, code (`ts`, `js`, `py`, `json`, `yaml`, `md`, `css`, `html`), and fallback text files.

---

## 5. Security & Invariant Guarantees

1. **Workspace Boundary**: Every requested path must strictly resolve inside the target project workspace (`safeResolvePath` and `realpathSync`).
2. **Traversal Resistance**: Paths containing `..`, null bytes, control characters, or Windows 8.3 short-name aliases (`PROGRA~1`) are rejected with 403.
3. **Symlink Escape Resistance**: Symlinks and Windows directory junctions targeting locations outside the workspace are blocked.
4. **Sensitive Path Immunity**: `.git`, `.pluton`, `node_modules`, `.env`, and private key files cannot be read, listed, searched, or deleted.
5. **Project Scoping**: Request headers (`X-Pluton-Project`) and query params (`projectId`) govern target workspace resolution; builds on other projects cannot alter the explorer's project context.

---

## 6. Verification and Testing Plan

1. **Unit & Security Tests**:
   - `tests/unit/workspace-directory-resolver.test.ts`: Directory resolution, traversal blocking, symlink escaping, Windows tilde aliases, protected directory filtering.
   - `tests/unit/file-search.test.ts`: Recursive search, query matching, 100-result cap, truncation flag, ignoring protected segments and `.env`.
2. **Integration Tests**:
   - `tests/integration/server-files-api.test.ts`:
     - Test `GET /api/files` with `dir` parameter and pagination (`offset`, `limit`) on a directory with >500 generated files.
     - Test deep nesting (8+ folder levels).
     - Test `GET /api/files/search` with relative query matching.
     - Test multi-project isolation (Project A vs Project B file requests).
     - Test PUT and DELETE preserving project workspace.
   - `tests/integration/spa-file-navigation.test.ts`:
     - Verify HTML asset contract for `#fileTabsBar`, `#fileBreadcrumbs`, `#fileSearchInput`.
     - Verify asset verifier script passes with updated IDs.
3. **End-to-End & Regression Verification**:
   - Full suite run: `npm run typecheck`, `npm run build`, `npm run verify:assets`, `npm run verify:docs`.
   - Confirm active supervisor, chat, and build operations remain untouched.

---

## 7. What's Left to the Builder
- Detailed DOM markup and CSS styling for `#fileTabsBar`, `#fileBreadcrumbs`, and search input in `src/server/static-assets.ts`.
- Exact debouncing intervals (250ms recommended) and abort handling for search.
- Clean icon path SVG definitions for the flat iconography.
