# Pluton TUI Diagnosis: Launch-Path & Rendering Root Causes

**Date:** 2026-10-17  
**Repository:** `Y:\Pluton`  
**Git Status:** Working tree clean on `main` (commit `b7254e9`)

---

## 1. Findings & Root Cause Analysis

### A. Why the previous refinement did not appear in the screenshot
1. **`ChatSession.renderFrame()` was never hooked up to `renderFullScreenFrame()`:**
   - In `src/chat/session.ts`, `renderFrame()` still constructed a 2-line mini status frame (`lines = [statusLine]`, `lines.push(...live)`, `lines.push(...inputRender.lines)`).
   - Although `renderFullScreenFrame()` was created in `src/tui/render.ts`, it was never called inside `ChatSession`.
2. **Line-Oriented Scrollback Printing (`commitLine`):**
   - In `ChatSession`, every event (header, prior messages, user message `> ...`, tool events, and assistant responses) called `commitLine(text)`.
   - `commitLine(text)` called `this.deps.io.commit(text)`.
   - In `TerminalHost`, `commit(text)` directly called `this.stdout.write(text + '\n')`.
   - As a result, the application continuously appended text to the terminal scrollback as plain stdout lines rather than managing a persistent full-screen viewport.
3. **Alternate Screen Buffer Rendering Loop:**
   - `TerminalHost` had an `alternateScreen` flag, but when redrawing it used relative cursor-up sequences (`\x1b[${up}A`) designed for a 2-line bottom region, not full-screen absolute frame drawing (`\x1b[H`).

### B. Launcher & Build Target Analysis
- **Launcher Entry Point:** `bin/pluton.js`.
- **Dual Path Execution:**
  ```javascript
  const dist = join(here, '..', 'dist', 'cli', 'main.js')
  const src = join(here, '..', 'src', 'cli', 'main.ts')
  if (existsSync(dist)) {
    await import(pathToFileURL(dist).href)
  } else if (existsSync(src)) {
    await import(pathToFileURL(src).href)
  }
  ```
- If `dist/` is present, `bin/pluton.js` runs `dist/cli/main.js`. If `npm run build` is not run after source changes, the launcher executes stale compiled JavaScript!
- **Build Command:** `npm run build` (`tsc -p tsconfig.build.json`), outputting to `dist/`.

### C. Why "No pluton tools are exposed in this session's catalog" occurred
- **Root Cause:**
  - Operator tools (`project.status`, `run.list`, `run.get`, `run.start`, `approvals.list`) defined in `src/tools/operator-catalog.ts` require permissions: `project.status`, `run.list`, `run.inspect`, `run.start`, `approvals.list`.
  - In `pluton.yaml` (and project templates), the `manager` Muse's `permissions` list was explicitly configured with task delegation permissions, but omitted the 5 operator permissions.
  - In `src/bootstrap.ts`, `m.permissions ?? []` defaulted to empty if omitted, ignoring `ROLE_DEFAULT_PERMISSIONS.supervisor`.
  - Consequently, `PlutonToolBridge.listTools()` filtered out all operator tools, returning an empty list `[]` to OpenCode.
  - OpenCode queried MCP `tools/list`, received zero tools, and truthfully told the user: *"No pluton tools are exposed in this session's catalog"*.

---

## 2. Remediation Plan

1. **Implement Real Full-Screen TUI in `ChatSession` (`src/chat/session.ts` & `src/tui/terminal.ts`):**
   - When running in `alternateScreen` mode, `ChatSession` owns the full-screen terminal canvas via `renderFullScreenFrame()`.
   - `transcriptLines` stores conversational turns, tool cards, and approval blocks.
   - Real-time streaming renders dynamically inside the chat pane.
   - `TerminalHost.redraw()` writes full-screen frames from `\x1b[H` with cursor parked at the composer caret (`\x1b[${row};${col}H`).
   - `TerminalHost.commit()` avoids printing unformatted text to stdout when `alternateScreen` is active.
2. **Wire Real Orchestra Inspector Data (`src/chat/session.ts`):**
   - Populate `viewState.orchestra` with live data from `Store` (Muses, tasks from active run, pending approvals, recent events).
3. **Fix Operator Tool Exposure & Default Permissions (`src/bootstrap.ts`, `src/domain/permissions.ts`, templates):**
   - Ensure `manager` / supervisor role receives `ROLE_DEFAULT_PERMISSIONS.supervisor` if permissions are omitted.
   - Update team templates to include operator tool permissions for supervisors.
   - Add a visible warning in the chat when an operator Muse is missing required tool permissions.
4. **Build and Validate the Real Launch Target:**
   - Execute `npm run build` to update `dist/`.
   - Test both `src/cli/main.ts` and `bin/pluton.js`.
