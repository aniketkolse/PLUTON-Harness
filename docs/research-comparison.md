# Research Comparison — Pluton vs OpenCode / Claude Code / Pi

Date: 2026-10-17. Sources fetched and read during this session:
OpenCode TUI docs (https://opencode.ai/docs/tui/), Claude Code interactive-mode docs
(https://code.claude.com/docs/en/interactive-mode), Pi repository README
(https://github.com/earendil-works/pi — the `badlogic/pi-mono` project, now
`earendil-works/pi`). Items marked ✓ were verified in those pages during this session;
"—" means not verified here, not that the feature is absent. No undocumented internals are
claimed.

Categories: **[P]** already a Pluton capability · **[A]** adaptable from a documented public
interface · **[N]** requires new Pluton engineering.

| Feature | OpenCode | Claude Code | Pi | Pluton |
| --- | --- | --- | --- | --- |
| Interactive TUI | ✓ full TUI, theming `tui.json` | ✓ fullscreen + classic renderers | ✓ TUI package (`@earendil-works/pi-tui`, differential rendering) | [P] implemented this pass: alt-buffer full-screen frame, pinned composer, header/footer |
| Slash commands | ✓ `/help /new /models /sessions /compact /thinking /undo /redo …` | ✓ `/` menu incl. skills/plugins; command reference | ✓ (docs list; verified via README pointing to docs) | [P] `/help /status /runs /run /approvals /approve /deny /new /exit /quit` preserved; autocomplete implemented; more commands [N] |
| Command palette | ✓ `ctrl+p` | ✓ (`Ctrl+R` reverse search; `?` help panel) | — | [P] `Ctrl+P` palette overlay implemented |
| Plan mode | ✓ agent "plan" mode documented under agents | ✓ permission mode `plan` cycles with Shift+Tab | ✗ README states Pi skips plan mode by default | [N] roadmap (explicit state machine, no fake prompt prefix) |
| Token/context usage | ✓ (details/usage surfaces in TUI; exact fields vary by provider) | ✓ usage limits + cost surfaces documented | — | [P] footer shows real token counts only when the provider reports them; no estimates |
| Permissions / approvals | ✓ permission model + policies docs | ✓ permission modes incl. acceptEdits/bypassPermissions; per-prompt answers | ✗ no built-in permission system; containerize (README) | [P] permission-gated tool bridge + durable approvals; canonical card implemented this pass; engine-level prompts auto-deny fail-closed (no interactive channel yet) [N] |
| Sessions: new/resume | ✓ `/sessions` (aliases `/resume`, `/continue`), `/new` | ✓ resume + per-directory history | ✓ durable conversation runtime (`pi-durable`) | [P] durable SQLite sessions; `/new` implemented; browser/resume UX [N] |
| Subagents / orchestration | ✓ agents + subagent concepts in docs | ✓ background subagents, task checklist | ✗ README: skips sub-agents by default (extensible) | [P] Manager/worker Muses, task graph, docker isolation, approvals |
| Tools / MCP / extensions | ✓ MCP servers, custom tools, skills, plugins | ✓ MCP prompts as commands, plugins, skills | ✓ extensions, skills, prompt templates, packages | [P] restricted tool bridge (permission-gated operator catalog) + MCP servers; empty-catalog root cause fixed this pass |
| Diffs / change review | ✓ diff rendering `diff_style` in TUI config | ✓ `/diff` panel; transcript viewer `Ctrl+O` | — | [P] changed-file summaries + integrate/verify pipeline (CLI); in-TUI diff viewer [N] |
| Queued input while busy | ✓ (TUI behavior) | ✓ documented queue + "send now" key | — | [P] queued prompts implemented in `ChatSession` |
| Interrupt/cancel | ✓ Esc-style interrupt | ✓ Esc interrupt; keeps work so far | ✓ (agent runtime) | [P] Esc interrupt; truthful `[interrupted]` marker |
| Attention/notifications | ✓ `attention` config (desktop + sound) | ✓ (terminal-mediated notifications) | — | [N] not implemented |
| Themes | ✓ `/themes` | ✓ `/theme` | ✓ themes (README) | [P] fixed Pluton palette (charcoal/violet/cyan); theme switching [N] |
| Hooks/lifecycle events | ✓ plugins | ✓ hooks system | ✓ extensions; `chord` typed plugin runtime | [P] process lifecycle hooks (terminal restore); automation hooks [N] |
| Sandboxing/boundaries | ✓ permissions + policies; provider network config | ✓ sandboxing doc; shell mode runs outside sandbox | ✗ containerize externally (README) | [P] Docker containers per Muse, workspace policies; WSL2 [N] |

## How Pluton maps to the three categories

- **[P] Directly supported today** (kept intact in this pass): full-screen TUI, chat sessions
  (new/continue/interrupt/queue), durable approvals with fail-closed expiry, permission-gated
  tool bridge, MCP servers, Manager/worker orchestration with Docker isolation, verification
  pipeline, CLI `approve/deny/status/task/graph/verify/integrate`.
- **[A] Adaptable from documented public interfaces**: richer slash-command registry entries
  (`/sessions`, `/models`, `/compact`, `/permissions`, `/doctor`) modeled on OpenCode's TUI
  command list; command palette keybind conventions; per-prompt permission answers modeled on
  Claude Code's permission-mode cycling. None of these require replacing the runtime.
- **[N] Pluton-specific engineering**: plan mode as a real state machine with approval gate;
  an interactive channel for engine-level permission prompts (today: fail-closed auto-deny);
  usage/cost ledger when providers report it; in-TUI diff review; desktop attention signals;
  plugin/hook extension surface.

## Explicit non-claims

- Pi states in its own README that it *skips* sub-agents and plan mode by default; Pluton does
  not claim parity with Pi extension packages.
- Claude Code's plan/permission mode names and OpenCode's config schema are product-specific;
  Pluton implements its own equivalents and does not claim configuration compatibility.
- No cost figures are displayed by Pluton unless a provider reports them; nothing is estimated
  from token counts.
