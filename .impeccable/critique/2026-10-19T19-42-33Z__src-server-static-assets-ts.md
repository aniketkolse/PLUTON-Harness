---
target: PLUTON graphical workspace SPA (src/server/static-assets.ts)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
target_identity: "file:Y:\\Pluton\\src\\server\\static-assets.ts"
target_fingerprint: "sha256:47a84d95769300c8ced88575e09beb2e7b3752c5129ee1f4a726229ae77d782c"
target_path: "Y:\\Pluton\\src\\server\\static-assets.ts"
timestamp: 2026-10-19T19-42-33Z
slug: src-server-static-assets-ts
closed: true
---
# Design Critique — PLUTON Graphical Workspace

Target: `Y:\Pluton\src\server\static-assets.ts` (embedded SPA: /index.html, /app.css, /app.js)
Date: 2026-10-20

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live status strip, SSE updates, approval banner, tool status pills — but the anchor glyph is identical when idle and when working, so the only busy signal is motion. |
| 2 | Match Between System / Real World | 3 | "Muses", "Dock", "Studio", "Bridge" are domain-true, but "Add Custom AI Model" promises an action that does not exist and "Custom Ship Worker AI Model" names nothing the user can act on. |
| 3 | User Control and Freedom | 2 | Cancel/Stop and modal Cancel exist; there is no undo anywhere, no Escape-to-close on modals or popovers, and no way to dismiss a failed action. |
| 4 | Consistency and Standards | 2 | One shell, three visual languages: emoji (5 glyphs) beside inline SVG, a 12-step type ramp with a 9px floor, and ten distinct corner radii. |
| 5 | Error Prevention | 3 | Disabled mic and thinking-effort both carry explicit "not implemented" explanations; approvals gate sensitive work — but starting a supervised Build run has no confirmation. |
| 6 | Recognition Rather Than Recall | 3 | Sessions, model registry, and permissions are all browsable, but the Files pane lists clipped absolute paths instead of names, and "Context: unknown" labels a value nobody can read. |
| 7 | Flexibility and Efficiency of Use | 2 | Chat/Build split and Enter/Shift+Enter exist; there are no keyboard shortcuts, no command palette, no way to copy, re-run, or branch a message. |
| 8 | Aesthetic and Minimalist Design | 2 | The dark chrome is restrained, but the Settings pane is eight cards in 263px, the Files pane is an illegible smear, and 9px text appears in the model popover. |
| 9 | Error Recovery | 2 | Errors render in red and toasts carry the message, but "Failed to list files: <raw>" offers no retry, and a failed tool call has no re-run affordance. |
| 10 | Help and Documentation | 2 | Tooltips and two explanatory notices exist; there is no help, and the Files and Settings panes have no guidance. |
| **Total** | | **24/40** | **Acceptable (60%)** |

## Design Specificity Verdict

The surface is a well-chosen dark operator chrome wearing a thin authored skin. The maritime
commitment is real but decorative rather than structural: the ship mark, the anchor, "Dock",
"Studio", and "Muses" appear in the chrome, yet nothing about the *structure* of the interface
expresses a control plane on a vessel. The 280px navy rail, the two-pane settings column, the
model registry, the file list, and the composer are the vocabulary of any dark AI chat product
— they would transfer to a support agent, a SQL client, or a trading terminal unchanged.

Where it *is* authored: the vocabulary of Muses and Docks, the honest labelling of unimplemented
capabilities, the fail-closed approval surface, and the refusal to fake a model picker. That
last one is the strongest specificity signal in the build — the interface admits what it cannot
do.

What the specificity is missing is any place where the domain *shapes* a decision. The centrepiece
of this product is a task DAG with dependencies, states, and write leases, and it is currently a
list of cards in a sidebar tab. The one screen that could not belong to another product is
compressed into the least prominent place in the interface.

**Deterministic scan.** 27 findings on the extracted markup: 6 low-contrast, 12 undersized UI
text, 4 tiny body text, 3 chromatic glow shadows, 5 side-tab accent borders, 1 overused font
(Inter), 1 em-dash advisory.

- The detector caught what the eye could not: 12 elements of functional text below 11px, six of
  them at or under 10px, at 3.14:1 and 3.40:1 against their own backgrounds.
- **False positive:** `.badge` measured at 1.66:1 — a measurement artifact of compositing a
  12%-alpha green over the card plate, not a real failure.
- **False positive:** `.msg-body blockquote { border-left: 3px solid #3b2d63 }` is a conventional
  typographic quote rule, not a card accent. It is flagged, but it should stay.
- **True positive the eye would have called a matter of taste:** `.popover-item-engine` at 9px and
  `.muse-role` at 9.5px are unreadable on a 1x display, not merely small.

**Browser evidence.** 0 console errors, 0 failed requests, no horizontal overflow at any width
from 1920 down to 420. The 1000px breakpoint is where the layout breaks, and it breaks silently.

## Overall Impression

This is a competent, restrained rebuild that solved the previous version's worst problems (no
top nav, no right-aligned bubbles, no hardcoded data) and introduced a new one: it moved a
complete settings application into a 280px navigation rail. The single biggest opportunity is
that PLUTON's most distinctive asset — the task DAG — is invisible.

## What's Working

1. **Honesty about unimplemented capability.** The microphone is disabled with the reason in its
   tooltip; the thinking-effort card states that no such control exists in the runtime. Most AI
   UIs hide this. It is the clearest expression of product character in the build.
2. **The status strip is the right idea.** Model, workspace, context, and MCP count on one mono
   line, in the order an operator actually needs them, with a Chat/Build switch where the
   decision belongs. The structure is right; only the 11px floor and the sea-fog colour need
   lifting.
3. **The transcript is a single left-aligned column with a stable left edge.** Removing
   right-aligned bubbles made the stream readable. The measure (880px) and the card rhythm are
   sound; the problems are in what lands inside it.

## Priority Issues

### [P0] The Files pane is an illegible smear, not a tree

- **Why it matters:** `loadFilesList` renders `GET /api/files` as a flat list of absolute paths
  (`Y:\Pluton\src\server\...`), each clipped to 263px in 11px mono, 1px apart. Every row is an
  identical-looking truncated fragment. The class is named `.file-tree-item` but there is no
  tree, no filename, no directory grouping, no icon. The operator cannot locate a file, which
  makes the pane actively worse than no pane.
- **Fix:** group by directory, show the filename as the primary string with the directory as a
  secondary line, indent by depth, and give rows a real height and hover state. A collapsed
  directory tree is the right shape; the API already returns paths to build one from.
- **Suggested command:** `/impeccable layout`

### [P1] The Settings pane is a settings application inside a navigation rail

- **Why it matters:** eight cards, a model registry, per-Muse model assignment, permissions,
  approvals, MCP servers, the orchestra, and the workspace root are all rendered into 263px of
  card width. Model ids like `9router/ag/claude-opus-4-6-thinking` wrap onto two lines and
  `<select>` values clip to nothing. The only two headings are 10px uppercase micro-type at
  3.40:1. This is where an operator configures the system and it is the least readable surface
  in the product.
- **Fix:** widen the sidebar to ~440px when the Settings pane is active (the resizer already
  exists), lift the micro-labels to 11px at AA contrast, and let the model selects show the
  engine and model as two lines rather than one clipped string.
- **Suggested command:** `/impeccable layout`

### [P1] Raw Markdown tables leak into the transcript

- **Why it matters:** `renderMarkdown` handles fences, headings, rules, quotes and lists, but has
  no table branch. A GFM table falls through to the paragraph branch and renders as literal
  `| Franchise | Agent session | What it found |` text, with the `|---|---|` separator turned into
  inline-code chips by `inlineMarkdown`. In the real transcript this is the most visually broken
  element on screen, and it is exactly the shape an agent uses to report a comparison.
- **Fix:** add a table branch to `renderMarkdown` (GFM pipe tables with a separator row),
  emitting a real `<table>` with a styled header row, plus horizontal scroll for wide tables.
- **Suggested command:** `/impeccable harden`

### [P1] The type scale has a 9px floor and twelve steps

- **Why it matters:** measured at runtime, the smallest rendered text is 9px (`.caret`,
  `.popover-item-engine`) and 9.5px (`.muse-role`, `.perm-mode`, `.chip-perm`). The full ramp is
  9 / 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 13 / 13.5 / 14 / 15 / 17px — twelve steps for a UI
  that needs six. `.session-meta` (10px) measures 3.14:1 against its own background and
  `.card-sub` / `.empty-hint` measure 3.40:1, all below the 4.5:1 floor the product has set.
- **Fix:** collapse to 11 / 12 / 13 / 14 / 15 / 17px, lift `--text-dim` from `#6b6780` to at
  least `#8e8a9f` and `--text-muted` to `#a49fb4` so every step clears 4.5:1, and raise the
  floor to 11px everywhere.
- **Suggested command:** `/impeccable typeset`

### [P1] At exactly 1000px the sidebar silently covers the transcript

- **Why it matters:** the CSS switches the sidebar to `position: absolute` at
  `max-width: 1000px`; the JavaScript collapses it at `innerWidth < 1000`. At exactly 1000px the
  CSS has already made it an overlay while the JavaScript still believes the window is wide, so
  the sidebar sits open at 280px over the message column with no scrim. Measured: `msgLeft: 20`,
  `sidebarCoversText: true`, and the PLUTON brand mark is hidden behind it. The 900px and 720px
  states are correct, so the bug only appears in a one-pixel band — but it is the band an
  operator lands in when they drag a window.
- **Fix:** align the two thresholds to a single source of truth, and give the narrow-width
  overlay a scrim and a focus trap so an open drawer never reads as "the app is broken".
- **Suggested command:** `/impeccable adapt`

## Persona Red Flags

### Alex (Impatient Power User)

- The whole interface is mouse-driven. There is not one keyboard shortcut in the build — no
  `/` command palette, no `Cmd/Ctrl+K`, no Escape-to-close on the model or MCP popovers (the
  popovers are `position: fixed` divs with `role="dialog"` and no key handling).
- There is no way to copy a message, re-run a prompt, or branch a conversation. A transcript
  with fifteen turns has no affordance for re-using any of it.
- The model popover is the only fast path, and it is a hover-free click on a 12px mono link.

### Sam (Accessibility-Dependent User)

- The composer textarea sets `outline: none` and signals focus with a 1px border change from
  `#232036` to `#4c3575` — roughly a 1.2:1 luminance shift. The text inputs do the same
  (`.field input:focus { outline: none }`). Every button relies on the UA default ring, so
  focus indication is inconsistent between the two families of control.
- 15 rendered elements carry functional text at 9.5px or smaller, several of them in the model
  registry and permission chips that Sam needs to read to know what the agent is allowed to do.
- Task state in the DAG is carried by a coloured left border. There is no state word on the
  card, so "needs approval" and "running" are the same shape in a monochrome rendering.
- The transcript has no `aria-live` region, so a streamed reply is not announced.

### Jordan (Confused First-Timer)

- The first screen shows a "Conversations"-free Sessions pane with twelve entries named
  "Untitled Session" and no description of what a session is or what starting one does. The
  single "+ New Session" button opens a modal asking for a name with a placeholder
  ("e.g. Code Refactor & Bugfix") and no guidance about what happens after.
- The Files tab opens to a smear of clipped paths, and the Settings tab opens to eight cards
  with no ordering logic and no explanation of which one matters.
- "Custom Ship Worker AI Model" is not a phrase that tells a newcomer anything. Neither is
  "Reasoning & Thinking Effort" — a card that exists to say the feature is missing.

## Minor Observations

- The sidebar tab reads "Session" (singular) above a list of many.
- "Add Custom AI Model" heads a card whose body explains that models come from the engine and
  cannot be added. The title promises an action the card explicitly refuses.
- The anchor glyph is used for both "idle" and "working" in the status strip. The only difference
  is the bob animation — so the state is communicated by motion alone.
- `.mode-btn.is-active` uses `#60a5fa`, a blue that exists nowhere else in the palette.
- Emoji used as interface icons in five places: `📁` (workspace chip), `⚓` (status), `🚢` (twice,
  in the Settings pane), `⚠` (approval banner) — sitting directly beside a consistent set of
  inline SVG marks.
- `.conn-dot` carries a zero-offset green glow (`0 0 6px rgba(52,211,153,0.8)`) — the single
  most recognisable "AI-generated UI" tell in the build.
- No `prefers-reduced-motion` block exists, while the anchor bob and the caret blink both run
  indefinitely.
- The transcript has no top fade; the first message is cut mid-line by the header.
- 12 em-dashes in the body copy of the sample transcript.
- The status strip's "Model:" and "Context:" labels are 11px while the value beside them is
  also 11px, so the label and the value carry identical weight.

## Questions to Consider

- If the task DAG is the product, why does it live in the last card of the Settings tab? What
  would the bridge look like if the live run were the centre of the screen and the conversation
  sat beside it?
- Should Settings be a drawer over the workspace rather than a pane inside the rail? The
  distinction between "navigate" and "configure" is being paid for in 263px.
- What would the maritime motif look like if it were structural rather than decorative — a hull
  plate for the ground, rivet seams between surfaces, a lamp-lit accent for live state — instead
  of three emoji and a boat glyph?
- The terminal and the web app are two renderings of one system. Should they read from a single
  token source, so that a change to the violet moves both at once?
