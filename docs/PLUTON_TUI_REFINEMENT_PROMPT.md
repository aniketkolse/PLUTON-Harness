# Pluton-Harness TUI Refinement — Master Implementation Prompt

## Mission

Refine the existing Pluton-Harness terminal user interface into a polished, dense, chat-first agentic coding TUI inspired by the usability principles of Claude Code and Pi, while giving Pluton its own visual identity.

The target is a **Pluton hybrid**:

- Minimal, readable conversation as the primary experience.
- Dense but compact runtime status and tool activity.
- An optional Orchestra inspector for Muses, tasks, approvals, and recent events.
- Keyboard-first control with discoverable commands and shortcuts.
- Clear streaming output, structured tool-call visibility, and useful errors.

This is a **TUI presentation-layer upgrade only**. The existing Pluton runtime, agent execution, engine adapters, session persistence, approval records, tools, orchestration, and task lifecycle are the source of truth and must remain intact. Do not rewrite the harness or replace the backend to make the interface easier to build.

## 1. Existing state and symptoms

The current application launches a basic `Pluton Chat` TUI in Windows PowerShell/Windows Terminal, using a local project path and a Docker container execution mode. It can connect to a configured Muse and an OpenCode engine/model, start sessions, send chat messages, call tools, and surface approval requests.

Current usability problems include:

- Messages and status headings repeat awkwardly after session changes.
- Tool events appear as cryptic raw lines instead of readable activity.
- Unknown slash commands produce unhelpful errors.
- Approval requests appear as opaque IDs instead of clear approval cards.
- Runtime capability warnings appear inline as ordinary assistant prose.
- The interface has no clear transcript/composer/footer structure or optional Orchestra inspector.

Use these observations as clues, not assumptions. Inspect the source code and confirm how each feature is currently represented before modifying it.

## 2. Non-negotiable constraints

1. Preserve the current runtime. Do not replace the agent loop, engine adapters, tool bridge, session database, task scheduler, approval backend, execution process management, or Docker/WSL2 integration.
2. Inspect before editing. Identify the language, TUI library, command parser, rendering loop, input/event handling, session state, tool event schema, approval state, and tests. Write a short baseline report before significant changes.
3. Reuse the current stack. Prefer improving the current TUI framework. Only propose a library migration if the existing framework demonstrably cannot support full-screen layout, scrolling, resizing, and streaming. Do not migrate the runtime language to change the UI.
4. Use existing data. The UI renders actual runtime events and records. Do not invent tool outputs, agent states, approvals, task progress, cost, or capabilities.
5. Preserve all valid current commands and their semantics. Inspect and retain `/help`, `/status`, `/runs`, `/run <goal>`, `/approvals`, `/approve <ref>`, `/deny <ref>`, `/new`, `/exit`, and `/quit` wherever implemented.
6. No decorative-only controls. Every visible action must work or be disabled with an explicit reason.
7. Never hide failures or safety information. Missing tools, engine errors, approval requests, uncertain outcomes, and permission denials must remain discoverable.
8. Redact secrets. Never display API keys, bearer tokens, credential environment values, or sensitive environment dumps.
9. The UI must work with the existing local runtime and must not require a network connection simply to render.
10. Honor the Windows Terminal/PowerShell plus Docker/WSL2 workflow. Handle terminal resizing, ANSI capabilities, UTF-8, fallback glyphs, and Windows terminal input behavior. Do not assume native Windows has tmux.

## 3. Product experience and visual language

The application should feel like a persistent AI coding conversation, not a sequence of print statements. Conversation is primary, tool activity is inspectable, and the Orchestra panel is available when operational detail is useful.

Use a restrained dark theme:

- Deep charcoal background rather than pure black where supported.
- Muted violet as Pluton's signature accent.
- Cool cyan/blue for focus and interactive controls.
- Green for success, amber for waiting/approval, red for failure, and grey for secondary information.
- Color must reinforce labels, never replace them.
- Support no-color and limited-color terminals.
- Use consistent icons with ASCII/text fallbacks.
- Avoid excessive animation, giant headers, decorative banners, and unnecessary borders.

Build reusable presentation components for headers, messages, tool activities, approvals, composer, footer, inspector, and help.

## 4. Screen layout

On terminals at least approximately 120 columns wide and 30 rows high, use a two-column arrangement:

```text
┌ PLUTON ─ my-project ─ ~/projects/my-project ────────────────────────────────┐
│ Muse: manager · Engine: OpenCode · Model: provider/model · Run: running     │
├───────────────────────────────────────────────────────┬─────────────────────┤
│ CHAT                                                  │ ORCHESTRA           │
│                                                       │                     │
│ You                                                   │ Muses               │
│ Inspect auth, fix the expiry bug, and run tests.      │ ● manager working   │
│                                                       │ ✓ researcher done   │
│ Manager Muse                                          │ ● worker-a running  │
│ I'll inspect the cause, implement the fix and verify. │ ○ worker-b idle     │
│                                                       │                     │
│ ✓ Researcher — inspected 4 files                      │ Task graph          │
│ ▾ Worker A — running targeted tests                   │ ├─ research ✓       │
│   $ pnpm test auth                                    │ ├─ implement ●      │
│   FAIL auth-expiry.test.ts                            │ └─ review waiting   │
│                                                       │                     │
│                                                       │ Pending approvals   │
│                                                       │ 1 · inspect         │
├───────────────────────────────────────────────────────┴─────────────────────┤
│ ❯ Ask Pluton to plan, delegate, or implement…                               │
│ Enter send · Shift+Enter newline · / commands · Ctrl+P palette · Esc stop   │
├─────────────────────────────────────────────────────────────────────────────┤
│ RUNNING · 3 Muses · 1 approval pending · OpenCode manager · /help            │
└─────────────────────────────────────────────────────────────────────────────┘
```

This is a layout contract, not pixel-perfect ASCII art. Compute positions from actual terminal dimensions. Never wrap border characters incorrectly.

### Pane proportions

- Main transcript: approximately 70–76% of the available width.
- Orchestra inspector: approximately 24–30%.
- Header: compact, one or two rows plus a divider at most.
- Composer: two to five rows, expanding to a configured maximum and then scrolling internally.
- Footer: one or two rows with the actual runtime state and useful shortcuts.
- Inspector scrolls independently when supported.
- Focus is always visually obvious.

### Narrow-terminal behavior

Below approximately 120 columns, collapse the inspector by default and use almost the entire width for conversation. Let users toggle a compact inspector view.

At very narrow widths, hide nonessential metadata instead of forcing body text into an unreadable column.

Below roughly 24 rows, simplify header/footer content, cap the composer, and prioritize the last activity and user input. If the terminal is too small to operate, show a concise resize hint rather than corrupting the screen.

Handle terminal resize during active streaming without restarting a request or duplicating content.

## 5. Header

Show:

- Pluton name/mark.
- Project name and abbreviated working directory.
- Selected Muse.
- Actual engine and selected model, abbreviated if necessary.
- Current run/session state: ready, running, awaiting approval, interrupted, failed, or completed.

Do not display dummy data. Allow a user to inspect full paths/model identifiers through status or an inspector. Do not repeat the complete header for every message.

## 6. Conversation transcript

Render distinct styles for:

- User messages.
- Assistant/Muse responses.
- System notices and lifecycle events.
- Tool activities and expandable results.
- Approval requests.
- Warnings and errors.
- Final run summaries.

Provide Markdown rendering for common elements: headings, paragraphs, bold, italic, inline code, fenced code blocks, lists, tables where feasible, and readable links.

Requirements:

- Correct wrapping for Unicode, emoji, ANSI escape codes, wide characters, Windows paths, and long URLs.
- Preserve message roles and boundaries.
- Make code blocks readable, with plain-text fallback if syntax highlighting is unavailable.
- Support scrollback and navigation to recent activity.
- Preserve the current draft while users inspect history or panels.
- Update streamed text incrementally without flicker, duplicate chunks, dropped characters, or cursor jumps.
- Do not execute commands or call agents as a side effect of rendering.
- Show a thinking/typing indicator only while the engine reports an active state. Stop it on completion, waiting, failure, interruption, or cancellation.
- Never display raw provider protocol traffic as conversational text.

## 7. Tool activity

Replace cryptic raw tool output with compact, expandable rows such as:

```text
▸ Searching the web                                     RUNNING
✓ Read 4 files                                          1.2s
✓ Inspected Git diff                                    18 files
▾ Run auth tests                                        FAILED
  $ pnpm test auth
  FAIL auth-expiry.test.ts
  Expected expiry to be rejected; received accepted
  [Open details] [Copy output]
```

Use real tool names/descriptions from the registered catalog. If a friendly description is unavailable, show a sanitized tool name rather than inventing what it did.

Where the runtime exposes them, show status, timing, input/result previews, expand/collapse, copy output, and explicit truncation indicators.

Support queued, running, succeeded, failed, cancelled, denied, and unknown/uncertain states where backed by actual event data.

Large logs should not flood the transcript or freeze rendering. Show a compact summary and a way to inspect details. Preserve secret redaction.

## 8. Composer

Implement a genuine multiline prompt composer.

Requirements:

- Enter sends a non-empty draft.
- Shift+Enter inserts a newline.
- If the current terminal framework cannot reliably distinguish these keys, choose one consistent, documented alternative.
- Support cursor movement, Home/End, delete/backspace, useful text-selection/editing behavior where the framework permits it, input history, and multiline paste without accidental dispatch.
- Preserve the draft when scrolling, changing panels, or handling a failed request.
- Show focus and caret clearly.
- Show a compact contextual hint for the active Muse/mode.
- Typing `/` opens command suggestions; further text filters them. Tab/Up/Down/Enter selection behavior must be documented.
- Suggestions must be sourced from actual registered commands, not a stale list.
- Empty prompts must not dispatch work.
- While a turn is active, follow actual runtime support for queue, steer, or refuse. Never claim a message was steered if the engine does not support steering.
- On submission failure, retain the draft and display the real error.

## 9. Orchestra inspector

Use existing Pluton runtime state wherever available.

### Muses

Show Muse name/ID, role, engine/model, state, active task, and recent activity. Use actual states such as idle, planning, working, waiting, needs approval, succeeded, failed, interrupted, or unavailable.

Keep the concepts of Muse, task run and sandbox distinct.

### Task graph

Show a compact dependency tree/list, owner, blocker and actual status. If the scheduler does not expose task graph data, show an honestly labeled empty/unsupported state rather than fabricated tasks.

### Approvals

Show the number of pending approvals and selected approval details: action, target/resource, reason, risk boundary, and available decisions returned by the backend.

Opening details is not approval.

### Recent events

Show compact recent lifecycle/tool/task events, avoiding duplicate copies of chat messages.

The inspector must be collapsible. Toggling it must not alter agent execution or lose the draft. Preserve independent scroll and focus state where practical.

## 10. Approval cards

Never present an approval only as an opaque ID line.

Render a card similar to:

```text
┌ ACTION NEEDS YOUR APPROVAL ───────────────────────┐
│ Muse: worker-a                                    │
│ Action: run shell command                         │
│ Target: project workspace                         │
│ Reason: command requests an operation outside its │
│ normal allowed scope.                             │
│                                                   │
│ [A] Approve once   [D] Deny   [V] View details    │
└───────────────────────────────────────────────────┘
```

The real action, target, reason, permissions, and choices must come from backend state. Never infer additional risk details beyond the data available.

Approval and denial must invoke existing operations using the correct approval reference. Do not silently turn a one-time approval into a persistent grant. Require deliberate confirmation for broad/persistent permissions if supported by the existing security model.

## 11. Footer, help and command palette

Show contextual shortcuts rather than advertising unavailable actions.

Examples:

Idle:
`READY · Muse: manager · OpenCode · Enter send · / commands · Ctrl+P palette · ? help`

Running:
`RUNNING · 3 Muses · Esc interrupt · Ctrl+P palette · Tab inspector`

Awaiting approval:
`APPROVAL REQUIRED · A approve once · D deny · V details`

Help must cover chat, navigation, runs/sessions, approvals, Muses/orchestration, terminal behavior, accessibility and fallback modes.

Provide a command palette with filtered search if supported by the current framework. Destructive actions must be clearly identified.

## 12. Keyboard interaction contract

Use a coherent, mode-aware key map. Inspect existing behavior and avoid conflicts.

| Key | Intended action | Requirement |
|---|---|---|
| Enter | Send draft | Only in composer; never submit from list selection |
| Shift+Enter | Insert newline | If unsupported, document a consistent alternative |
| Esc | Contextual cancel/interrupt | First dismiss overlays; otherwise request the existing interrupt when appropriate |
| Ctrl+C | Graceful interruption/exit | Provide clear feedback; never silently lose a draft |
| Ctrl+P | Command palette | Esc closes it without side effects |
| Tab | Cycle main focus/panels | Must not unexpectedly disrupt composer editing |
| ? or F1 | Help overlay | Must not capture normal typed text unexpectedly |
| Ctrl+L | Redraw | Never delete saved history/runtime state |
| PageUp/PageDown | Scroll focused view | Panel scrolling should be independent where feasible |
| Home/End | Move within draft/transcript | Behavior depends on focus and must be documented |
| Up/Down | History or suggestions | Do not unexpectedly break multiline cursor motion |
| A/D/V | Approval actions/details | Active only when relevant approval is selected |
| / | Begin command suggestions | Only in composer |

Do not reserve printable keys globally while users are typing a prompt.

## 13. Command correctness

Inspect the current command implementation and preserve valid functionality for:

- `/help`
- `/status`
- `/runs`
- `/run <goal>`
- `/approvals`
- `/approve <ref>`
- `/deny <ref>`
- `/new`
- `/exit`
- `/quit`

Add commands such as `/sessions`, `/muses`, `/tasks`, `/models`, `/attach <muse>`, `/inspect`, or `/settings` only when they map to real runtime capabilities.

Centralize command metadata if the current implementation duplicates it. Each definition should contain a name, aliases, syntax, description, argument hints, availability conditions, and real handler mapping where supported.

For unknown commands:

- Show `Unknown command: /session`.
- Offer up to three valid suggestions if they exist.
- Always provide `/help` as the fallback.
- Never start a new session, send the unknown command to the model, or mutate state because parsing failed.

Use the existing command/application layer instead of implementing a divergent parser inside the TUI.

## 14. UI architecture

Create a clean presentation boundary over the current harness. Adapt the following responsibilities to the existing language and conventions:

- **AppController:** maps user actions to existing application/service commands and consumes events.
- **AppState:** selected session/Muse, run status, transcript viewport, draft, overlays, selected inspector panel, and display preferences.
- **EventAdapter:** normalizes existing runtime events only where needed, preserving source event IDs.
- **Layout:** computes rectangles from terminal dimensions and focus state.
- **TranscriptView:** renders messages and tool activities.
- **ComposerView:** input editing, draft, history and suggestions.
- **OrchestraView:** Muses, tasks, approvals and recent events.
- **ApprovalView:** details and existing approval operations.
- **StatusBar, HelpOverlay and CommandPalette.**

These are conceptual responsibilities, not a mandate to create excessive files.

Key rules:

- Rendering should be a pure presentation operation wherever practical.
- Route actions through existing application/service APIs.
- Use stable event/request IDs to prevent duplicate messages on redraw or replay.
- Never block the event loop while an agent runs.
- Use bounded display buffers and clear truncation indications.
- Keep the durable runtime history as the source of truth.
- Restore cursor, echo, alternate-screen and terminal settings on normal and error exits.
- Degrade to a simpler readable mode if terminal capabilities are unavailable.

## 15. Truthful state reporting

Map actual runtime lifecycle states into a consistent presentation vocabulary:

- idle/ready
- planning/working
- waiting for a tool or child task
- awaiting user input/approval
- completed
- failed
- interrupted/cancelled
- uncertain after crash/restart
- unavailable due to missing engine/tool/configuration

Do not equate process exit with task success. Do not equate an assistant saying “done” with verification passing. Never hide uncertain outcomes. If task/Muse information is unavailable, show only what exists and label missing capabilities honestly.

## 16. Streaming, performance and security

- Use event-driven rendering and coalesce high-volume updates where necessary.
- Avoid repainting the whole screen for every token if the framework supports partial updates.
- Preserve event ordering, role boundaries, tool IDs and final statuses.
- Resize during streaming without restarting or duplicating execution.
- Do not allow large tool output to freeze input.
- Use a bounded presentation buffer; mark truncated display output explicitly.
- Prevent untrusted ANSI escape sequences in tool output from altering the TUI or spoofing controls.
- Make clipboard features optional and platform-aware.
- On shutdown, request the existing graceful runtime shutdown and restore terminal state even if an error occurs.

## 17. Implementation phases

### Phase 0 — Audit and baseline

1. Inspect repository instructions, working tree and existing uncommitted changes. Do not discard work.
2. Identify language, TUI framework, executable entry point, chat loop, command parser, event types, streaming, approval operations, session APIs and tests.
3. Run the existing build, lint and tests. Record exact results and environment blockers.
4. Trace one successful chat request, one tool call, one approval, one unknown command and one session transition.
5. Write `docs/tui-audit.md` (or equivalent) describing the current architecture, baseline, observed problems and chosen implementation path.
6. Do not begin a broad refactor until the UI boundary is understood.

### Phase 1 — Layout foundation

1. Implement a full-screen layout and proper terminal lifecycle if supported.
2. Add responsive header, transcript, composer, footer and optional inspector.
3. Implement wrapping, scrolling, resize handling, theme tokens and no-color fallback.
4. Ensure clean startup/shutdown and recoverable rendering errors.

### Phase 2 — Chat quality

1. Improve roles, Markdown/code formatting and streaming.
2. Implement multiline input and history.
3. Add command autocomplete and useful unknown-command suggestions.
4. Eliminate duplicate headers/session transition noise.
5. Ensure scrolling does not lose the draft or cause unexpected jumps.

### Phase 3 — Activity and approvals

1. Render actual tool events as expandable activity rows.
2. Correlate starts/results through existing IDs.
3. Implement real approval cards.
4. Present missing capability/configuration warnings as distinct notices.
5. Show final summaries and run state truthfully.

### Phase 4 — Orchestra inspector

1. Show real Muse and engine/model/status information.
2. Add task graph/list only when backed by real scheduler data.
3. Add pending approvals and recent events.
4. Add focus navigation and independent scrolling.
5. Validate narrow and short terminal behavior.

### Phase 5 — Validation and polish

1. Test with real runtime events and a deterministic fake/test event source if available.
2. Validate the Windows Terminal/PowerShell and WSL2/Docker workflow.
3. Run build, lint, unit, integration and existing end-to-end tests.
4. Manually test streaming, approvals, tool failures, large output, reconnect, resize, interrupt and exit.
5. Fix regressions before adding optional visual effects.

Do not declare a phase complete merely because it compiles.

## 18. Acceptance tests

### Layout and terminal

- Wide terminal shows aligned chat and Orchestra panes.
- Narrow terminal collapses the inspector and preserves readable text.
- Short terminal preserves input and presents a resize hint when necessary.
- Resize during streaming does not restart work or duplicate content.
- Exit restores terminal modes/cursor, including after errors.
- No-color mode communicates states through text as well as color.

### Chat and composer

- Send a prompt and receive streamed output.
- Compose multiline input and paste it without accidental submission.
- Scroll history and return to the latest message without losing the draft.
- Preserve a draft when submission fails.
- Markdown, code, Unicode and Windows paths wrap correctly.
- Large tool output does not freeze the UI.

### Commands and events

- Current valid slash commands preserve their semantics.
- Unknown commands offer suggestions without side effects.
- Each tool call appears once with its correlated result.
- Success, failure, cancellation and waiting states are truthful.
- Redraw, scrolling and layout changes never trigger runtime operations.
- Capability warnings are visible and accurate.

### Approvals and Orchestra

- Pending approval renders a recognizable card with backend-provided details.
- Approve/deny invokes the real operation with the correct reference.
- Opening approval details does not approve the request.
- Failed/uncertain runs are never presented as completed.
- Unsupported data is labeled honestly.
- Toggling the inspector does not disrupt active execution, focus or draft content.

## 19. Deliverables

1. Working refined TUI integrated into the existing Pluton executable.
2. Audit document explaining the current UI architecture and baseline.
3. Updated help and shortcut documentation.
4. Tests for layout, command suggestions, event rendering, approvals, streaming and resize behavior, following current project conventions.
5. Implementation report covering files changed, supported behaviors, tests run/results, known limitations and manual smoke-test steps.
6. Screenshots or terminal recordings if the environment permits; never fabricate evidence.

## Final instruction

Start by auditing the repository and running the current tests. Then implement the smallest complete vertical slice:

**Full-screen layout + readable streaming chat + multiline composer + truthful tool activity + real approval card + working current commands.**

Validate this before adding the inspector. Then add the responsive Orchestra inspector and polish keyboard interactions.

Preserve Pluton's existing runtime and product behavior. Do not invent unsupported commands, replace working execution logic, use fake production data or stop after writing a plan. Implement, test, report evidence, and clearly identify anything you could not verify.
