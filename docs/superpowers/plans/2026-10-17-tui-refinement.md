# Pluton-Harness TUI Refinement Implementation Plan

**Goal:** Refine the existing Pluton-Harness terminal user interface into a dense, polished, chat-first agentic coding TUI inspired by Claude Code and Pi with Pluton's visual identity, preserving 100% of the underlying runtime, engine adapters, and storage.

**Specification Reference:** `PLUTON_TUI_REFINEMENT_PROMPT.md` and `docs/tui-audit.md`.

---

## Architecture & Component Breakdown

1. **Theme & Styling (`src/tui/theme.ts`)**:
   - Pluton signature colors: Muted Violet (`#A78BFA` / ANSI 256 `\x1b[38;5;141m`), Cool Cyan focus (`\x1b[38;5;75m`), Deep Charcoal accents, Semantic status (Green, Amber, Red, Dim Grey).
   - Text label reinforcement for no-color/limited terminals.
   - Text & ASCII fallback icons (`●`, `✓`, `✖`, `▸`, `▾`, `◌`, `○`).

2. **Terminal Host Lifecycle (`src/tui/terminal.ts`)**:
   - Alternate screen buffer mode (`\x1b[?1049h` on start, `\x1b[?1049l` on stop) for full-screen view.
   - Cursor management (`\x1b[?25l` hide during redraw, park at composer caret with `\x1b[?25h`).
   - Clean signal handling and terminal restoration on SIGINT, SIGTERM, uncaught exceptions, and normal exit.
   - Full backward compatibility with `ChatIo` and `ScriptedIo` used by existing unit & integration tests.

3. **Layout & Box Model (`src/tui/layout.ts`)**:
   - Pure geometry calculator:
     - `columns >= 120` & `rows >= 30`: Two-column arrangement (Chat: 72–75%, Orchestra: 25–28%).
     - `columns < 120`: Collapsed inspector by default (full width for chat), toggleable via `Tab` or `/inspector`.
     - `rows < 24`: Compact header/footer, capped composer, prioritize conversation.
   - Computes exact bounds for Header, Transcript, Orchestra, Composer, Autocomplete Popup, and Footer.

4. **Markdown & Code Block Renderer (`src/tui/markdown.ts`)**:
   - Zero-dependency streaming-aware terminal Markdown formatter:
     - Headers (`#`, `##`, `###`) with accent styling.
     - Bold (`**text**`), Italic (`*text*`), Inline code (`` `code` `` with distinct background/color).
     - Fenced code blocks (```lang ... ```) with syntax framing, top/bottom rounded or ASCII borders, and left gutter indentation.
     - Lists (`- `, `* `, `1. `) and blockquotes (`> `).
     - Link formatting (`[text](url)`).

5. **Tool Activity Model & Cards (`src/tui/activity.ts` & `src/tui/render.ts`)**:
   - Correlated tool lifecycle (`queued`, `running`, `succeeded`, `failed`, `cancelled`, `denied`).
   - Tracks duration (`1.2s`), input/output preview, truncated logs with explicit `[+N lines truncated]` badge.
   - Expand/collapse state (`▸` collapsed summary vs. `▾` expanded output).
   - Untrusted ANSI sanitization to prevent control code injection from tool output.

6. **Approval Cards & Interactive Key Handling (`src/tui/approval.ts` & `src/chat/session.ts`)**:
   - Structured approval cards with action, target resource, reason, requesting Muse, and explicit decision affordances:
     `[A] Approve once   [D] Deny   [V] View details`
   - Active approval shortcut handling: pressing `A` / `D` when an approval card is active invokes existing `slashContext.approve(ref)` / `slashContext.deny(ref)`.

7. **Slash Commands Autocomplete & Unknown Suggestions (`src/chat/commands.ts`)**:
   - Centralized command registry with metadata (`name`, `aliases`, `syntax`, `description`, `argHint`).
   - `/` autocomplete dropdown showing matching commands and syntax hints as user types.
   - Unknown command handler returning up to 3 closest matches via Levenshtein / prefix matching plus `/help`.

8. **Orchestra Inspector (`src/tui/orchestra.ts` & `src/chat/session.ts`)**:
   - Consumes live runtime state from `Store`:
     - Muses: slug, role, engine/model, current state (working, idle, waiting).
     - Task Graph: active run tasks, dependencies, blockers, and status.
     - Approvals: pending approvals count and active items.
     - Recent Events: chronological lifecycle event stream.
   - Toggleable visibility via `Tab` or `/inspector`.

---

## Tasks

### Task 1: Theme & Visual Tokens
- Add Pluton palette tokens (violet accent, cyan focus, charcoal borders, semantic status colors).
- Ensure no-color fallback preserves clear textual status indicators.
- Unit tests: `tests/unit/tui-theme.test.ts`.

### Task 2: Layout Engine (`src/tui/layout.ts`)
- Implement pure `computeLayout(width, height, opts)`:
  - Header, Transcript viewport, Orchestra panel (collapsible), Composer area, Autocomplete popup bounds, Footer.
  - Responsive thresholds (>=120 cols wide, >=30 rows high vs. compact narrow/short modes).
- Unit tests: `tests/unit/tui-layout.test.ts`.

### Task 3: Terminal Markdown & Code Formatter (`src/tui/markdown.ts`)
- Implement lightweight Markdown formatter with headers, bold, italics, inline code, fenced code blocks with bordered box/gutter, lists, and links.
- Respect terminal width wrapping without breaking ANSI escape codes or wide characters.
- Unit tests: `tests/unit/tui-markdown.test.ts`.

### Task 4: Command Registry & Autocomplete (`src/chat/commands.ts`)
- Centralize `COMMAND_REGISTRY` with syntax, descriptions, and argument hints.
- Add `getCommandSuggestions(query)` for autocomplete.
- Add `getUnknownCommandSuggestions(unknownCmd)` returning top 3 closest matches with Levenshtein distance.
- Unit tests in `tests/unit/chat-commands.test.ts`.

### Task 5: Tool Activity Component & Approval Cards
- Implement structured tool cards with correlation ID, state badges, duration calculation, and ANSI sanitization.
- Implement approval cards with clear boxed framing, action details, and action prompts (`[A] Approve once`, `[D] Deny`, `[V] View details`).
- Unit tests: `tests/unit/tui-activity.test.ts` and `tests/unit/tui-approval.test.ts`.

### Task 6: Orchestra Inspector View (`src/tui/orchestra.ts`)
- Implement pure renderer for Orchestra Inspector: Muses list, task dependency tree/list, pending approvals, and recent events.
- Unit tests: `tests/unit/tui-orchestra.test.ts`.

### Task 7: Full-Screen Viewport & Redraw Pipeline (`src/tui/render.ts`)
- Integrate Header, Transcript with scrolling, Orchestra Inspector, Composer with multiline cursor, Autocomplete popup, and Status Footer into `renderFullScreen`.
- Unit tests: `tests/unit/tui-render.test.ts`.

### Task 8: Keyboard Bindings & Navigation (`src/tui/keys.ts`)
- Add support for `Tab` (cycle focus / toggle inspector), `PageUp`/`PageDown` (scroll transcript), `Ctrl+P` (command palette), `A`/`D`/`V` (approval shortcuts).
- Autocomplete selection keys (Tab/Enter to complete, Up/Down to navigate suggestions).
- Unit tests: `tests/unit/tui-keys.test.ts`.

### Task 9: TerminalHost Alternate Screen & Signal Handling (`src/tui/terminal.ts`)
- Enable alternate screen buffer (`\x1b[?1049h` / `\x1b[?1049l`) and cursor hide/show.
- Clean restore on normal exit, error, and SIGINT/SIGTERM.
- Maintain full compatibility with `ChatIo` and `ScriptedIo`.
- Unit tests: `tests/unit/tui-terminal.test.ts`.

### Task 10: ChatSession Coordinator & State Integration (`src/chat/session.ts` & `src/tui/state.ts`)
- Store transcript blocks, active tool records, scroll offset, inspector toggle, and autocomplete state in `ChatViewState`.
- Wire approval keys (`A`/`D`) to execute real slash approvals when approval is pending.
- Wire poll tick to update Orchestra data (Muses, tasks, approvals, events).
- Integration tests: `tests/integration/chat-session.test.ts` and `tests/integration/cli-chat.test.ts`.

### Task 11: End-to-End Verification & Polish
- Run full test suite (`npm run check`).
- Manual verification in live environment.
- Produce `docs/tui-refinement-report.md`.
