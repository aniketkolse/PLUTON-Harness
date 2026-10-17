# ADR-0013 — TUI 2.0: Modular agentic coding presentation architecture and visual design system

- Status: Accepted (2026-10-18)

## Context

Pluton's chat interface (ADR-0012) established an inline terminal chat loop with the operator Muse. However, as Pluton matured into a full-scale multi-agent coding harness, the user interface needed to evolve into a production-grade agentic terminal experience (TUI 2.0).

Requirements:
1. Distinctive visual identity featuring a purple pirate-ship banner (`#8B5CF6`, `#A78BFA`), structured User/Assistant transcript messages, tool activity progress telemetry, diagnostics ResultCards with diff coloring, a docked multiline InputBox, and a persistent StatusBar with context token utilization.
2. Cross-platform rendering across Windows Terminal/ConPTY, macOS, Linux, and WSL2, gracefully degrading across truecolor (24-bit RGB), 256-color, 16-color, `NO_COLOR`, and ASCII box-drawing fallbacks.
3. Security defense against terminal injection attacks: untrusted assistant prose or tool execution output must not be able to issue terminal control escape sequences (`\x1b[2J`, `\x1b]52`, cursor manipulation).
4. Zero new runtime dependencies: maintain the zero-dependency inline terminal architecture defined in ADR-0001 and ADR-0012.
5. Deterministic visual regression testing and interactive demo mode (`pluton --demo` / `pluton chat --demo`) that replays a failed CI build recovery without live engine or network dependencies.

## Decision

- **Dedicated `src/ui/` Presentation Layer:** Decompose the UI into modular, pure functional presentation components:
  - `src/ui/theme.ts`: UI tokens, semantic roles, RGB/256/16-color painting, Unicode/ASCII box characters, and environment capability detection (`COLORTERM`, `TERM`, `CI`, `NO_COLOR`).
  - `src/ui/brand.ts`: Hand-drawn pirate ship ASCII art mark, block font wordmark ("PLUTON"), and two-column metadata layout.
  - `src/ui/header.ts`: Adaptive top banner rendering full 6-line brand view on standard terminals (>=80x24) and single-line compact view on small/narrow viewports.
  - `src/ui/messages.ts`: Distinct visual treatments for User prompts (`👤 You` / `> You`) and Assistant replies (`⛵ PLUTON` / `[SHIP] PLUTON`).
  - `src/ui/tools.ts`: Tool execution telemetry (`ToolGroup`, `StepItem`) tracking pending, running, succeeded, and failed execution states with duration timing.
  - `src/ui/cards.ts`: Rich result cards with status badges, task checklist progress indicators, DiffBlock syntax coloring (red `-` deletions, green `+` additions, dimmed line numbers), and file path link styling.
  - `src/ui/input.ts`: Docked rounded input box with dynamic placeholder text, multiline expansion, and terminal cursor coordinate calculation.
  - `src/ui/status.ts`: Single-line status bar displaying engine/model badge, connection status, token context meter, and keybind hints.
  - `src/ui/approval.ts`: Actionable approval card pinned above composer to eliminate transcript clutter.
  - `src/ui/demo.ts`: Replayable scripted interactive scenario simulating an automated CI build failure diagnosis and remediation cycle.
- **Terminal Control Escape Sanitization (`src/tui/sanitize.ts`):** Strip harmful CSI (`\x1b[...]`), OSC (`\x1b]...`), and control characters from untrusted text before applying Markdown formatting or frame rendering. Allow safe color/style escapes while disallowing arbitrary screen clearing, cursor repositioning, and OSC 52 clipboard hijacking.
- **Engine Event and Transcript Bridge:** `src/chat/session.ts` maps live engine events (`sendPrompt()` stream) into structured message components, tool groups, and result cards, while preserving backwards compatibility with full-screen frame layout.
- **CLI Demo Mode:** Add `--demo` flag to CLI root and `chat` command, launching `runTuiDemo()` in alternate screen mode for live visual QA and demonstration.

## Alternatives Considered

### Alternative 1: Ink (React-based terminal UI)
- **Pros:** Widely used in Claude Code, declarative component model.
- **Cons:** Adds 60+ transitive dependencies (~15 MB), requires a JSX compilation step that breaks Node 24 native execution, and introduces heavy event loop overhead.
- **Why not:** Violates ADR-0001 (minimal dependencies) and ADR-0012 (zero-dependency inline renderer).

### Alternative 2: Blessed / Neo-blessed
- **Pros:** Comprehensive terminal widget library.
- **Cons:** Unmaintained, difficult TypeScript types, poor Windows ConPTY compatibility, complex internal event loop.
- **Why not:** Adds fragile legacy dependencies and fails Windows terminal stability requirements.

### Alternative 3: Ad-hoc ANSI escapes directly in `src/chat/session.ts`
- **Pros:** Quickest to write initially.
- **Cons:** Hard to unit test, tight coupling between session business logic and presentation ANSI strings, fragile terminal resize behavior.
- **Why not:** Leads to code rot, untestable visual regressions, and security exposure from unsanitized escape sequences.

## Consequences

### Positive
- Fully testable, deterministic presentation layer: 100% test coverage across unit tests and integration tests.
- High visual fidelity with purple pirate aesthetic without sacrificing terminal accessibility or graceful degradation.
- Hardened against terminal injection attacks.
- Interactive demo mode enables manual visual QA in CI and local development environments without AI API keys.
- Preserves the project's zero-dependency runtime constraint.

### Negative
- Pure ANSI string rendering and character display width calculations must be maintained and verified within the repository.
