# SPA UX Overhaul — Workspace Picker, Conversation, Tools, Files, Sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Track every checkbox; do not skip the verification step between tasks.

**Goal:** Fix the eight operator-facing UX defects in the embedded Pluton SPA without regressing the runtime contracts (139 test files / 1143+ tests, 0 TypeScript errors).

**Scope:** `src/server/folder-picker.ts`, `src/server/routes.ts`, `src/store/store.ts`, `src/server/static-assets.ts`, and the matching Vitest suites.

**Tech stack:** Node.js 24, TypeScript 5.9, `node:sqlite`, zero-dependency embedded SPA.

## Global Constraints

- No new runtime dependencies. The SPA stays offline-ready in `src/server/static-assets.ts`.
- Every mutation endpoint stays token-authenticated and workspace-contained (`safeResolvePath` + `realpathSync`).
- No purple/violet hues anywhere in CSS, including hard-coded hexes that bypass the token layer.
- `npm run check` and `npm run build` must both pass before the work is reported complete.
- Tests are updated in the same commit as the markup/asset contracts they assert.

---

## Problem → Fix Map

### P1. Windows folder dialog opens behind Pluton

**Problem:** `folder-picker.ts` calls `IFileOpenDialog.Show(IntPtr.Zero)`. An unowned shell dialog is a separate top-level window, so Windows can place it behind the browser/desktop shell. The operator must minimise Pluton to find it.

**Fix:** Resolve the foreground window with `GetForegroundWindow()`, bring it to the foreground, and pass its HWND as the dialog owner (`dialog.Show(owner)`). The PowerShell host stays hidden (`-WindowStyle Hidden`, `windowsHide: true`) so no console window is shown.

**Test:** Decode the `-EncodedCommand` in a unit test and assert the script contains `GetForegroundWindow` and `dialog.Show(owner)`.

### P2. Rectangles around tools and messages; tool name/status too loud

**Problem:** `.tool-card-input` and `.tool-card-body` draw bordered boxes; the tool name is cyan (`--accent-cyan`); the status pill has an amber/green background. Messages still carry a queued left border.

**Fix:**
- Remove every border/background from tool cards, inputs, bodies, and status pills.
- Tool name → `var(--text-muted)`; summary chip text-only.
- Status shows on the right (`Running`, `Completed`, `Failed`) in `var(--text-dim)`; only `Failed` keeps a muted red tint.
- Remove `max-height: 280px; overflow: auto` from `.tool-card-body` so the complete output is always visible.
- Remove the left border from `.msg-user.is-queued`; messages remain borderless.

**Test:** SPA asset test asserts the new CSS contract and the removal of the clamp/coloured status rules.

### P3. Chat does not follow new output

**Problem:** `maybeScroll()` tests `isNearBottom()` *after* appending. A large tool card or a big streaming frame moves the content farther than the 80 px threshold, so following silently stops and the "Jump to latest" button appears.

**Fix:** Track intent with `state.followTail`.
- Defaults to `true`; session replay forces it `true`.
- Scroll listener sets it from `isNearBottom()` only when the operator scrolls.
- New messages/stream frames scroll when `followTail` is true, regardless of how tall the appended content is.
- Jump button clears `followTail` when the operator scrolls up; clicking it restores following.

**Test:** SPA asset test asserts `state.followTail`, the scroll listener update, and the preserved jump-button toggles.

### P4. Tool output is monochrome and not code-aware

**Problem:** Tool output is escaped plain text. Code written/read by tools is indistinguishable from prose.

**Fix:** Infer a language from the tool name/summary/output (file extension, JSON payload, or code-looking body) and run `highlightCode()` only for code-like output. Plain prose/shell logs stay uncoloured to avoid false positives. Improve the token palette to the VS Code dark theme (comments green-grey, strings warm, keywords blue, numbers sage).

**Test:** SPA asset test asserts `guessToolCodeLang`, `highlightCode(cleanedOutput`, and the palette tokens.

### P5. Purple/violet remnants (split-view, mic, activity indicator)

**Problem:** `.tool-btn` uses purple-tinted `#161422`, `#2a263d`, `#b5b1c9`; composer bar and activity tooltip use `#181625` / `#241e38`; the activity badge pulses with a cyan glow; worker "completed" badges are cyan.

**Fix:**
- Replace every purple-tinted hex with the neutral tokens.
- Mic and activity indicator become icon-only: transparent background, no border, no glow.
- Split-view button uses the neutral `.tool-btn` style.
- Worker status badges and tool-stream entries become neutral grey.
- Extend the purple-regression test with the removed hexes.

**Test:** Existing neutral-grey test expanded; SPA asset test asserts icon-only mic/activity rules.

### P6. No per-item delete for sessions or files

**Problem:** Sessions and files can only be created/opened.

**Fix:**
- `Store.deleteChatSession(id)` deletes messages, plans, inbox rows, then the session inside one transaction.
- `DELETE /api/sessions/:id` refuses while a turn is running, drops the live runner/MCP session, and returns 404 for foreign/unknown sessions.
- `DELETE /api/files/content?path=…` removes a workspace-contained file.
- Session rows and file rows get a hover/focus delete control with a confirmation.
- Deleting the active session selects the next one (or creates `Session 1` when none remain).
- Deleting the file currently open in the editor closes the editor.

**Test:** Store unit test for cascade; server integration test for both DELETE endpoints; SPA asset test for the controls.

### P7. File preview is trapped in the sidebar

**Problem:** `openFile()` writes into the small `#filePreview` box in the Files pane. There is no close control and no way to edit.

**Fix:** Remove `#filePreview` from the sidebar and add a main-area `#fileViewer` overlay:
- Header: file icon, path, language label, dirty marker, `Edit`, `Save`, `×`.
- Body: read-only highlighted view with line-number gutter; edit mode is a transparent textarea over the same highlighted layer (caret visible, text transparent), with scroll-synced gutter.
- `Ctrl/Cmd+S` saves; `Escape` closes; closing with unsaved changes asks for confirmation.
- Worktree diffs reuse the same viewer in read-only diff mode.
- Files larger than 200k chars render uncoloured to keep typing responsive; the 2 MB read cap still applies.

**Test:** SPA asset test asserts the viewer IDs/functions/CSS; server test covers read → edit → save → re-read.

### P8. File save endpoint missing

**Problem:** `GET /api/files/content` is read-only.

**Fix:** `PUT /api/files/content?path=…` accepts a raw `text/plain` body (max 2 MB), reuses the same containment/canonicalisation checks as GET, and writes the existing file. A dedicated body reader keeps the 1 MB JSON limit for every other endpoint.

**Test:** Integration test saves content and reads it back; traversal and oversize attempts are rejected.

---

## Execution Order

- [x] **Task 1 — Folder dialog ownership.** Patch `folder-picker.ts`; extend `tests/integration/session-workspace.test.ts`; run that suite.
- [x] **Task 2 — Store + API primitives.** Add `deleteChatSession`; refactor file resolution; add `PUT`/`DELETE` file routes and `DELETE` session route; add `readTextBody`. Tests: `tests/unit/chat-store.test.ts`, `tests/integration/server-api.test.ts`.
- [x] **Task 3 — Conversation polish.** Auto-follow state, borderless tool/message CSS, neutral status/name, full tool output, code highlighting. Tests: `tests/integration/spa-ui.test.ts`.
- [x] **Task 4 — Theme cleanup.** Replace purple hexes; icon-only mic/activity; neutral worker badges. Tests: neutral-grey SPA test.
- [x] **Task 5 — File viewer/editor.** Replace sidebar preview with main-area viewer; wire open/edit/save/close/diff; line gutter; syntax colour. Tests: SPA asset contract + server save path.
- [x] **Task 6 — Delete controls.** Session and file delete UI; active-item fallbacks. Tests: SPA asset contract + server deletes.
- [x] **Task 7 — Full verification.** `npm run check`, `npm run build`, rebuilt app smoke test at the tokenised URL; commit.

## Verification Commands

```bash
npx vitest run tests/integration/session-workspace.test.ts tests/unit/chat-store.test.ts tests/integration/server-api.test.ts tests/integration/spa-ui.test.ts
npm run check
npm run build
```

## Manual Acceptance Checklist

1. Click the workspace chip / "Change Folder": the native dialog appears **in front of** Pluton with no console window.
2. Tool cards have no rectangles; the tool name and right-hand status are grey; long output is fully visible and code is coloured.
3. Scroll up: new output stops following and "Jump to latest" appears. Click it: following resumes.
4. No purple/violet remains; the mic is an icon with no box; the activity badge has no box/glow.
5. Session rows show a delete control; deleting the active session moves to the next one.
6. File rows show a delete control; the current file closes if deleted.
7. Clicking a file opens the main-area editor with a close ×; edit + save persists to disk; diff mode is read-only.

## Verification Evidence (2026-10-27)

- `npm run check`: 139 test files, 1150 tests passed, `tsc` clean.
- Targeted suites: 63 tests passed across session-workspace, chat-store, server-api, spa-ui.
- `npm run build`: clean.
- Rebuilt app smoke test (headless server, browser automation):
  - File `ux-verify.ts` opened in the main-area viewer (`typescript`, 4 token spans, 2-line gutter); Edit → input → Save persisted `export const answer: number = 42;` to disk; Save hidden again and the dirty marker cleared.
  - Close × hid the viewer; deleting `ux-verify.ts` showed a confirm, removed the file, and refreshed the list.
  - A new session was created and deleted; the active session fell back to the next one and the toast read "Session deleted".
  - Scroll listener: jump control appeared when scrolled to the top and hid at the bottom.
  - Computed styles: tool card/body/input `0px` borders, transparent backgrounds, `max-height: none`, `overflow: visible`; name `rgb(161,161,170)`, status `rgb(113,113,122)`; mic and activity transparent.
  - `Ctrl+E` entered edit mode; `Escape` closed a clean viewer, and a dirty close showed the discard confirm.
- Manual-only item: the native folder dialog itself cannot be opened safely from automation; `session-workspace.test.ts` decodes the PowerShell command and asserts `GetForegroundWindow`, `SetForegroundWindow(owner)`, and `dialog.Show(owner)`.
