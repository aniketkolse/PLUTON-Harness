# Pluton TUI Architecture Audit & Baseline

Date: 2026-10-17
Repository: Pluton-Harness (`Y:\Pluton`)
Language & Runtime: TypeScript on Node.js >= 24 (ESM native, `node:sqlite`)
Dependencies: `commander`, `yaml`, `zod` (zero external TUI libraries; zero-dependency terminal implementation)

---

## 1. Current Architecture Overview

### Entry Points
- **CLI Main (`src/cli/main.ts`):** `pluton chat [muse]`, `pluton muse chat <muse>`, and bare `pluton` gate with `shouldOpenChat({ isTty, hasProject })`.
- **Chat Command Runner (`src/cli/commands/chat.ts`):**
  - Resolves Muse record and loads or creates a SQLite `chat_sessions` row.
  - Provisions operator HTTP tool bridge via `ToolHttpServer` (token bearer authenticated, restricted operator tool catalog).
  - Configures background run runner (`startRunInBackground`) to supervise autonomous runs.
  - Instantiates `TerminalHost` and `ChatSession`, running the event loop.

### Presentation & I/O
- **`src/tui/terminal.ts` (`TerminalHost` / `ChatIo`):**
  - Manages stdin/stdout, raw mode (`setRawMode(true)`), bracketed paste (`\x1b[?2004h`).
  - Previously used an inline live-region model (`renderFrame` moving up `parkedRow` and clearing down with `\x1b[J`) and committing past messages to scrollback (`commitLine`).
  - Lacked alternate-screen buffer (`\x1b[?1049h`), full-screen viewport layout, and transcript scrolling.
- **`src/tui/render.ts`:**
  - `renderHeader`: 4-line text banner with project, muse, session ID, and help hints.
  - `renderStatusLine`: Single line summarizing muse, engine/model, run status, approvals pending, token usage.
  - `renderInput`: Multiline prompt line with cursor positioning via sentinel character.
  - `renderToolLine`: Compact tool line (`▶`, `✔`, `✖`).
- **`src/tui/theme.ts`:**
  - Color palette respecting `NO_COLOR` and TTY state.
- **`src/tui/width.ts`:**
  - Custom display-width calculation (handling ANSI stripping, CJK/East Asian Wide characters, emojis).
- **`src/tui/editor.ts` & `src/tui/keys.ts`:**
  - Editor state machine with cursor, command history, and collapsed bracketed paste (`[paste #N +M lines]`).
  - Key mapping for Enter, Shift+Enter, Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+O, cursor arrows, Home/End.

### Runtime & Event Flow
- **`src/chat/session.ts` (`ChatSession`):**
  - Bridges ACP engine session (`sendPrompt`) to UI view state (`ChatViewState`).
  - Handles streaming `EngineEvent` tokens: text chunks, tool executions, errors, usage, and approval requests.
  - Runs periodic background poll timer (`store.eventsSince`) to stream run and task updates from background workers into the chat.
  - Intercepts `/...` commands through `src/chat/commands.ts`.

---

## 2. Observed Issues & Pain Points

1. **Inline vs. Full-Screen Layout:**
   - The inline scrollback approach causes screen jumping when multi-line prompts or rapid streaming tokens arrive.
   - Long conversations push previous turns into the terminal's native scrollback buffer where the TUI has no navigation or scroll control.
2. **Missing Orchestra Inspector:**
   - While the background run supervisor records rich task state, dependencies, and Muses in SQLite, there is no side panel or inspector rendering this state.
3. **Tool Activity Display:**
   - Tool calls are rendered as single lines without expandable detail cards, durations, or input/output views.
4. **Approval Requests:**
   - Pending approvals appear as basic text notices (`approval_... pending`) rather than distinct actionable cards with `[A]`pprove / `[D]`eny / `[V]`iew actions.
5. **Command Autocomplete & Suggestions:**
   - Unknown commands simply print `unknown command '/foo'`. There is no inline autocomplete popup or fuzzy matching suggestions for slash commands.
6. **Markdown & Code Rendering:**
   - Streaming assistant output is printed as plain text without Markdown formatting, code block framing, or syntax styling.

---

## 3. Chosen Implementation Path

We will enhance the zero-dependency `src/tui/` stack to a full-screen, alternate-screen hybrid architecture without adding any external runtime dependencies:
1. **Alternate Screen Buffer (`src/tui/terminal.ts`):**
   - Enable alternate screen (`\x1b[?1049h`), hide cursor during frame rendering (`\x1b[?25l`), and clear/redraw cleanly.
   - Restore main screen (`\x1b[?1049l`) and cursor (`\x1b[?25h`) on all exit and signal paths.
2. **Two-Column Responsive Layout (`src/tui/layout.ts` & `src/tui/render.ts`):**
   - When terminal width >= 120 and height >= 30, display a two-column view: Chat transcript (72%) + Orchestra Inspector (28%).
   - When width < 120, collapse Orchestra Inspector by default, toggled with `Tab` or `/inspector`.
   - When height < 24, show compact header/footer and resize hints if too cramped.
3. **Streaming Markdown & Code Blocks:**
   - Pure parser/renderer for headers, bold, italics, inline code, and fenced code blocks with clean borders and line indentation.
4. **Expandable Tool Activity Cards:**
   - Structured tool state (queued, running, succeeded, failed, cancelled) with start/end duration, expandable output preview, and ANSI sanitization.
5. **Interactive Approval Cards:**
   - High-visibility cards with action, target, reason, and one-key `[A]`pprove / `[D]`eny / `[V]`iew bindings.
6. **Command Autocompletion & Palette:**
   - `/` autocomplete dropdown showing available commands, descriptions, and argument hints.
   - Unknown commands output up to 3 closest matches with Levenshtein/prefix ranking.
7. **Orchestra Inspector:**
   - Muses status (role, engine/model, current state).
   - Task graph / list from active run.
   - Pending approvals and recent event feed.

---

## 4. Baseline Verification

- **Command:** `npm run check` (`tsc -p tsconfig.json && vitest run`)
- **Result:**
  - TypeScript: 0 errors
  - Vitest: 50 test files passed, 605 tests passed (100% green).
- **Environment:**
  - Node.js v24.20.0
  - Docker Desktop 29.8.2 running with Linux containers
  - Windows 11 / Windows Terminal / PowerShell
