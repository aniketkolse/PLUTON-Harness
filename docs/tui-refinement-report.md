# Pluton TUI Refinement Implementation Report

**Date:** 2026-10-17  
**Specification:** `PLUTON_TUI_REFINEMENT_PROMPT.md`  
**Execution:** Inline TDD on `main`  
**Status:** Complete & Verified (635 tests passing)

---

## 1. Summary of Changes & Architecture Decisions

1. **Alternate Screen & Terminal Lifecycle (`src/tui/terminal.ts`)**:
   - Added `alternateScreen: true` option to `TerminalHost` using standard ANSI sequence `\x1b[?1049h` on enter and `\x1b[?1049l` on exit.
   - Cleans up cursor visibility, bracketed paste, and raw mode on SIGINT, normal exit, and unhandled errors without leaving corrupted terminal state.
   - Preserves 100% backward compatibility with `ScriptedIo` and existing test suites.

2. **Responsive Layout Engine (`src/tui/layout.ts`)**:
   - Pure geometry calculator:
     - Terminals >= 120 columns & >= 30 rows display a two-column view (Chat transcript 73%, Orchestra Inspector 27%).
     - Terminals < 120 columns collapse the Orchestra Inspector by default, toggled via `Tab` or `/inspector`.
     - Small terminals (< 40x12) display an explicit resize warning rather than corrupted graphics.
     - Dynamic prompt composer allocation between 2 and 5 rows based on draft length.

3. **Pluton Visual Identity & Theme Tokens (`src/tui/theme.ts`)**:
   - Signature Muted Violet (`\x1b[38;5;141m`) and Cool Cyan focus (`\x1b[38;5;75m`).
   - Semantic roles: green (success), amber (warning/approval), red (error), and subtle charcoal borders.
   - Fallback icons for no-color terminals: `[v]`, `[x]`, `*`, `..`, `o`, `>`, `v`.

4. **Zero-Dependency Markdown & Code Block Formatter (`src/tui/markdown.ts`)**:
   - Streams formatted Markdown: headings (`#`, `##`, `###`), bold (`**text**`), italic (`*text*`), and inline code (` `code` `).
   - Formats fenced code blocks (```lang ... ```) with syntax framing, borders, language tag, and stream indicator.
   - Wraps lists and blockquotes cleanly without breaking ANSI escape codes or wide characters.

5. **Tool Activity Component & ANSI Sanitization (`src/tui/activity.ts`)**:
   - Replaced cryptic raw tool text with structured status lines: icon (`▸`, `✓`, `✖`), duration (`1.2s`), and truncated output previews.
   - Sanitizes untrusted terminal control codes to prevent tool output from hijacking the TUI.

6. **Interactive Action Approval Cards (`src/tui/approval.ts`)**:
   - High-visibility boxed approval cards displaying action, target, reason, and requesting Muse.
   - Dedicated keyboard affordances: `[A] Approve once`, `[D] Deny`, `[V] View details` hooked directly to existing approval operations.

7. **Centralized Command Registry & Autocomplete (`src/chat/commands.ts`)**:
   - Metadata-driven command catalog (`/help`, `/status`, `/runs`, `/run <goal>`, `/approvals`, `/approve <ref>`, `/deny <ref>`, `/new`, `/inspector`, `/clear`, `/exit`, `/quit`).
   - Slash autocomplete menu rendered above composer as the user types `/`.
   - Unknown slash commands suggest up to 3 closest commands via Levenshtein / prefix matching plus `/help`.

8. **Orchestra Inspector Panel (`src/tui/orchestra.ts`)**:
   - Collapsible live inspector showing:
     - Muses list: slug, role, engine/model, and live state (working, idle, waiting).
     - Task graph / list: title, owner Muse, and scheduler status.
     - Pending approvals: pending count and quick IDs.
     - Recent events stream.

---

## 2. Verification Commands & Test Results

- **Typecheck & Test Command:**
  ```powershell
  npm run check
  ```
- **Results:**
  - TypeScript compilation: 0 errors
  - Vitest test suites: **57 passed (57)**
  - Total tests: **635 passed (635)**
  - Zero test regressions across domain, config, store, sandbox, engines, tools, CLI, and TUI.

---

## 3. How to Launch and Smoke Test

1. **Launch Interactive Chat TUI:**
   ```powershell
   node bin/pluton.js chat
   ```
2. **Keyboard Controls:**
   - `Enter`: Send prompt
   - `Shift+Enter` or `Ctrl+J`: Insert newline
   - `/`: Open slash-command autocomplete
   - `Tab`: Toggle Orchestra inspector panel
   - `PageUp` / `PageDown`: Scroll transcript
   - `Ctrl+P`: Command palette / help
   - `A` / `D` / `V`: Quick approve, deny, or view details when an approval is pending
   - `Esc`: Stop / interrupt active run
   - `Ctrl+C`: Clear draft -> interrupt active turn -> double press to exit
