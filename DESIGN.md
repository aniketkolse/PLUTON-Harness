---
name: PLUTON — The Bridge
description: Quiet instrument, loud state. A local-first control plane for a team of persistent AI Ships.
colors:
  hull-black: "#09080e"
  deck-plate: "#12101b"
  card-plate: "#151221"
  inset-well: "#0e0d16"
  signal-violet: "#8b5cf6"
  lantern-violet: "#a78bfa"
  signal-cyan: "#38bdf8"
  signal-ok: "#34d399"
  signal-warn: "#fbbf24"
  signal-danger: "#f87171"
  chalk: "#f3f0fa"
  chalk-soft: "#e2e0ec"
  sea-fog: "#a49fb4"
  sea-fog-dim: "#8e8a9f"
  rivet-line: "#242036"
typography:
  display:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  headline:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  micro:
    fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.05em"
  mono:
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'SF Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.deck-plate}"
    textColor: "{colors.lantern-violet}"
    rounded: "{rounded.md}"
    padding: "6px 14px"
  button-primary-hover:
    backgroundColor: "{colors.card-plate}"
  button-secondary:
    backgroundColor: "{colors.deck-plate}"
    textColor: "{colors.chalk-soft}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  button-danger:
    backgroundColor: "#7f1d1d"
    textColor: "#fee2e2"
    rounded: "{rounded.md}"
    padding: "4px 9px"
  button-ok:
    backgroundColor: "#065f46"
    textColor: "#d1fae5"
    rounded: "{rounded.md}"
    padding: "4px 9px"
  surface-card:
    backgroundColor: "{colors.card-plate}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.lg}"
    padding: "12px"
  surface-inset:
    backgroundColor: "{colors.inset-well}"
    textColor: "{colors.chalk-soft}"
    rounded: "{rounded.lg}"
    padding: "10px"
  text-input:
    backgroundColor: "{colors.hull-black}"
    textColor: "{colors.chalk}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  tab-active:
    backgroundColor: "{colors.card-plate}"
    textColor: "{colors.lantern-violet}"
    rounded: "{rounded.md}"
    padding: "5px 6px"
  chip:
    backgroundColor: "{colors.deck-plate}"
    textColor: "{colors.chalk-soft}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge:
    backgroundColor: "{colors.deck-plate}"
    textColor: "{colors.chalk-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  message-user:
    backgroundColor: "#19132a"
    textColor: "{colors.chalk}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  message-pluton:
    backgroundColor: "#12111a"
    textColor: "{colors.chalk-soft}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
---

# Design System: PLUTON — The Bridge

## Overview

**Creative North Star: "The Bridge"**

PLUTON is the operator's station on a working vessel. The product is a control plane for a crew of
persistent AI Ships; the interface is the bridge you stand on while they work. Everything about the
visual language follows from that: instruments that are legible in low light, controls that are
within reach, and a horizon that stays visible when the work gets loud. The maritime motif in
PLUTON is not decoration — the ship mark, the anchor, the sailing crew — it is the product's
honest self-description, and this system extends it rather than restating it.

**Quiet instrument, loud state.** The interface recedes; only state changes speak. A run that
stalls, an approval that arrives, a model that changes, a tool that fails — these earn color,
weight, and motion. Everything else stays a dark panel with a hairline seam. This is a dense
operator tool, not a consumer product, so the surface area does the quiet work: layered near-black
plates, one-pixel rivet lines, monospaced data, and a single violet signal that marks identity
rather than decoration.

The system explicitly refuses: neon glow, floating glass cards, rainbow status palettes, and
anything that reads as a consumer chatbot. It also refuses ornament without meaning — a gradient
that carries no hierarchy, a shadow that expresses no elevation, an emoji that arrives from
another product's icon set.

**Key Characteristics:**

- **Flat by default, lifted on state.** Surfaces are flat at rest. Depth appears only as a
  response to state — hover, focus, an open overlay.
- **Dense and machined.** Tight rhythm, monospaced labels wherever they carry data, crisp
  one-pixel borders, small radii. It reads as an instrument panel, not a deck of cards.
- **One signal color, used sparingly.** Muted violet marks PLUTON itself. Cyan marks the machine
  speaking. Everything else is surface, text, or state.
- **State is never color alone.** Every status carries a text or shape signal as well, so the
  interface survives monochrome, low vision, and screen readers.
- **Same system, two shells.** The browser workspace and the terminal interface share this
  vocabulary, its semantic roles, and its honesty about what is running.

## Colors

A near-black violet-charcoal ground with one violet signal, one cyan instrument, and four
functional state colors that never travel together.

### Primary

- **Signal Violet** (#8b5cf6): PLUTON's identity. Active tab, primary button fill, the PLUTON
  label in a transcript, the modal dot, the current-model marker. Used for identity and selection,
  never for decoration.
- **Lantern Violet** (#a78bfa): the lit form of the same signal. Used where violet sits *on* a
  surface as text or a light tint — active tab text, link hover, notice text, "current" rows.

### Secondary

- **Signal Cyan** (#38bdf8): the machine speaking. PLUTON transcript labels, file previews, links
  inside messages, tool names, the streaming caret. Cyan means "output from the system," never
  "click me."

### Tertiary

- **Signal Ok** (#34d399): a check passed, a task completed, the runtime is connected.
- **Signal Warn** (#fbbf24): an approval is waiting, a task is verifying, a limit is near.
- **Signal Danger** (#f87171): a check failed, a task failed, a control is unavailable.

### Neutral

- **Hull Black** (#09080e): the main ground — the column behind the transcript.
- **Deck Plate** (#12101b): the working surface — cards, sidebars, popovers, code wells.
- **Card Plate** (#151221): one step above a deck plate, for cards that sit on a deck plate.
- **Inset Well** (#0e0d16): a recess — the composer interior, code blocks, the file preview body.
- **Rivet Line** (#242036): the one-pixel seam that separates one surface from another. Softer
  variants (#1d1b2b, #1a1826) are used for the least important seams.
- **Chalk** (#f3f0fa): primary text. 16.4:1 on deck plate.
- **Chalk Soft** (#e2e0ec): body and message text.
- **Sea Fog** (#a49fb4): secondary text and labels. 7.2:1 on deck plate.
- **Sea Fog Dim** (#8e8a9f): meta text, timestamps, section labels. 5.5:1 on deck plate — the
  darkest step still allowed to carry text.

### The Terminal Is The Same System

The terminal interface is a sibling of the browser workspace, not a second design system. Both
resolve their colours through one palette (`src/ui/theme.ts`), and the terminal keeps its own
role vocabulary — `warn`, `dim`, `tool` — which maps onto the shared roles. A truecolor terminal
therefore shows the *same* Signal Violet, Lantern Violet, cool cyan and text ramp as the browser;
it is not a 256-colour approximation of a different palette.

Three degradation levels, one source:

- **Truecolor** (24-bit): the exact hex values above.
- **256-colour:** a fixed table — Signal Violet 141, Lantern Violet 147, cool cyan 75, Signal Ok
  78, Signal Warn 215, Signal Danger 203, tool indigo 111, Chalk 254, Sea Fog 246, Sea Fog Dim 243.
- **16-colour:** magenta for the accent, bright magenta for the lit accent, bright cyan for
  focus, yellow for approval, bold yellow and bold red where the role must be emphatic.

Below that, `NO_COLOR` and non-terminal sessions get plain text and the ASCII mark set
(`[v]`, `[x]`, `*`, `..`, `o`, `>`, `v`). The ASCII set is a real fallback, not a stub: the
terminal tests render against it, so every state that relies on a glyph has a plain-text
equivalent.

### Named Rules

**The One Signal Rule.** Signal Violet marks PLUTON itself and nothing else. If a violet element
is not the product, the current selection, or the current Ship, it does not exist. Status colors
carry state; they never carry identity.

**The Luminous Floor Rule.** The darkest text allowed anywhere is Sea Fog Dim (#8e8a9f) on the
darkest plate it ever sits on, and only at 11px or larger. No functional text drops below 4.5:1
against its own background.

**The No-Glow Rule.** No chromatic halo, no zero-offset colored shadow, no blurred color bloom.
A live state is announced by a solid mark and a word, not by a glow.

## Typography

**Display Font:** Inter (with "Segoe UI", system-ui fallbacks)
**Body Font:** Inter (with "Segoe UI", system-ui fallbacks)
**Label/Mono Font:** JetBrains Mono (with "Cascadia Code", Consolas, "SF Mono" fallbacks)

**Character:** Inter is deliberately ordinary — it is the chassis, not the voice. It is used
because a dense operator UI needs a neutral, well-hinted grotesque that renders identically on
Windows, macOS, and Linux with no webfont fetch, which PLUTON's offline-first, zero-dependency
constraint makes non-negotiable. All personality in the typography comes from the mono face, which
carries every value, path, model id, and status word. Mono is a second voice, not a fallback:
when a string is machine-produced it is set in mono, and when a human produced it, it is set in
Inter. That split is what makes the interface feel like an instrument rather than a document.

### Hierarchy

- **Display** (700, 17px/1.3): the `h1` inside a transcript, and nothing else. Rare by design.
- **Headline** (700, 15px/1.3): the `h2` inside a transcript; modal titles.
- **Title** (600, 14px): `h3` and `h4` in a transcript; form input text; the composer.
- **Body** (400, 13px/1.6): message prose, list items, field values.
- **Label** (500, 12px): button labels, tab labels, card titles, field labels, key-value keys.
- **Micro** (500, 11px, +0.05em, uppercase for section labels): tags, badges, timestamps, section
  headings, meta rows, tool status.
- **Mono** (400, 12px/1.45): every machine-produced string — model ids, paths, file names, session
  ids, counts, permissions, and the whole status strip.

### Named Rules

**The Six-Step Ramp Rule.** The system has exactly six text sizes (11, 12, 13, 14, 15, 17px) and
one mono size (12px). Nothing sits between two steps, and nothing sits below 11px. A twelve-step
ramp of near-identical sizes is how an interface ends up with 9px text nobody can read.

**The Mono Means Machine Rule.** If a string came out of the runtime, it is set in mono. If a
human wrote it, it is set in Inter. The exception is a full sentence of machine output rendered
as a paragraph, which stays in Inter for readability.

## Layout

The workspace is a two-column shell: a fixed **sidebar** (280px, resizable by dragging its right
edge, collapsible to zero) and a **main column** that takes the remaining width. The shell fills
the viewport exactly and never scrolls; only the sidebar panes and the transcript scroll.

**Sidebar** carries three panes behind a tab strip: Sessions, Files, and Settings. The Settings
pane needs more room than a navigation rail allows, so opening it widens the sidebar to 440px
rather than squeezing configuration into 280px. The resize handle stays available in every state.

**Main column** is a vertical stack of four bands, each a fixed role: a 52px header (brand and
runtime connection), an optional approval banner, the scrolling transcript, and the dock
(composer plus status strip). The transcript is capped at 880px and left-aligned rather than
centered, so the eye has a single stable left edge for reading.

**Responsive behavior** has two breakpoints. At **1000px** the sidebar stops occupying layout
space and becomes an off-canvas drawer that slides over the main column with a scrim; it starts
closed so the transcript is never covered, and the toggle in the sidebar header opens it. The
CSS and the JavaScript agree on that threshold exactly — a one-pixel disagreement is what let
the drawer silently cover the transcript. At **720px** the dock and transcript padding compress,
the brand badge hides, toolbar button labels collapse to icons, and the status strip wraps. The
layout never scrolls horizontally at any width.

**Spacing** follows a 4px rhythm with 2px and 3px half-steps at control scale: 4, 6, 8, 12, 16,
20, 24. Vertical rhythm inside the transcript is 14px between messages; inside a card, 10px
between blocks and 12px of padding.

## Elevation & Depth

**Flat by default, lifted on state.** PLUTON does not use a shadow stack. Depth is expressed
through surface tone: Hull Black is the ground, Deck Plate is one step up, Card Plate is two, and
Inset Well is a recess. A hairline Rivet Line separates planes that tone alone cannot.

Elevation appears in exactly three places, and only while a state is active: a popover or modal
floating above the page (a large, neutral, offset shadow, plus a scrim), a hovered control (a
background step, no shadow), and a focused control (a visible ring, no shadow). A shadow that
exists at rest is decoration, and decoration is the thing this system refuses.

### Shadow Vocabulary

- **Overlay** (`0 18px 44px rgba(0,0,0,0.55)`): popovers, modals, and toasts only. Neutral,
  offset, and only while the overlay is open.
- **Modal** (`0 24px 60px rgba(0,0,0,0.6)`): the modal card inside its scrim.
- **Control Press** (`0 1px 2px rgba(0,0,0,0.4)`): the selected segment of a switch, to lift it
  one step off its track.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. If a component needs to float to be
understood, it is not resting — it is an overlay, and overlays are the only things that float.

**The No-Chromatic-Shadow Rule.** Shadows are neutral black, never violet, cyan, green, or red,
and never zero-offset. A colored halo is a glow, and a glow is a lie about the surface.

## Shapes

Radii are small and consistent: **4px** for inline code, permission chips, and tool-status pills;
**6px** for buttons, inputs, tabs, and list items; **10px** for cards, the composer, popovers, and
modals; **999px** for badges and the brand badge. The system does not use 16px+ radii; a control
panel is not a consumer card.

Corners are rounded, but never fully. Borders are one pixel and use Rivet Line or a softer
variant, except on user messages, which use a slightly lighter violet seam (#332656) so the
operator's own prompts are findable by eye in a long transcript.

## Components

### Buttons

- **Shape:** 6px radius, 1px border, 5–6px vertical / 9–14px horizontal padding, label at 12px/600.
- **Primary:** Deck Plate background (#1b172a) with Lantern Violet text (#c4b5fd) and a
  #3b2d63 border. It is a raised dark plate, not a saturated fill — a saturated violet button
  would out-shout the state it triggers.
- **Primary hover:** one step up in tone (#252038). Active: `scale(0.97)`.
- **Secondary:** Deck Plate background, Chalk Soft text, a Rivet Line border.
- **Filled (approval banner only):** Signal Violet #7c3aed with white text, which holds 5.7:1.
  Signal Violet at #8b5cf6 does not clear 4.5:1 against white, so it is not used as a fill.
- **Danger / Ok:** solid #7f1d1d and #065f46 with their light text equivalents.

### Chips

- **Style:** 6px radius, Deck Plate background, 1px #252238 border, Chalk Soft text at 12px.
- **State:** a chip is a container for a value (workspace, model, context); a badge is a
  container for a status. Never both.

### Cards / Containers

- **Corner Style:** 10px radius.
- **Background:** Card Plate (#151221) over the sidebar's #0c0b12, with a #2f2749 border.
- **Shadow Strategy:** none at rest (see Elevation).
- **Border:** 1px, #2f2749 on cards, Rivet Line on quieter containers.
- **Internal Padding:** 12px, 10px between blocks.

### Inputs / Fields

- **Style:** Hull Black background, 1px border, 10px radius, 13px Inter text, 8px/10px padding.
- **Focus:** the border shifts to Signal Violet *and* a 2px violet focus ring appears. Border
  color alone is not a focus indicator.
- **Composer:** a recessed well (Inset Well) with a 12px radius; focus shifts the border to
  #4c3575 plus a visible ring.
- **Error / Disabled:** a disabled control is dimmed to 45% and marked `aria-disabled`.

### Navigation

- **Style:** the sidebar header holds a two-segment tab strip (Session, Files) and two icon
  buttons (Settings, collapse). Active tabs carry Card Plate background, Lantern Violet text, and
  a violet-tinted border. All navigation is labelled in text — no icon-only destination.
- **Sidebar:** 280px, resizable, collapsible to zero. Settings widens it to 440px.
- **Small screens:** the sidebar becomes an off-canvas drawer behind a scrim, closed by default.

### Messages

The transcript is one left-aligned column. Every message is a card with a 10px radius, 1px
border, and a 4px gap to its label row. AI messages use #12111a; user messages use #19132a with
a violet seam. The label row carries a 16px SVG mark and a 12px name: "You" in violet, "PLUTON"
in cyan.

User messages shrink to their content — a two-word prompt is a short card, not a full-width slab —
while AI messages fill the 880px measure. Tool calls render as a separate card: a header with the
tool name in mono and a status pill, over a monospace body.

### File Tree

The Files pane is a tree, not a path list. Directories are rows with a chevron, a violet folder
mark, the directory name, and a right-aligned file count; files are rows with a neutral document
mark and the filename only. Depth is expressed by indentation, not by truncation. The path
appears in the row's tooltip and in the preview header, where it belongs. A directory row toggles
its children; the chevron rotates 90° when open. A selected file keeps a violet wash.

### Markdown Tables

A GFM pipe table in a Ship's reply renders as a real table: a 11px uppercase header row on a
faint violet wash, 1px `border-soft` row rules, and 12px cell text. The table sits in a
horizontally scrollable wrapper so a wide comparison never breaks the reading column. Code
fences and tables are the two things allowed to exceed the 74ch prose measure, because they are
machine output and the reader wants the whole row.

### Status Strip

A single monospace row under the composer carrying: the execution state with the anchor mark, the
workspace chip, the active model, and the context indicator on the left; the MCP button and live
count on the right. It is 12px mono at Sea Fog — legible, never competing with the transcript.

## Do's and Don'ts

### Do:

- **Do** keep the violet signal scarce: identity, current selection, and the PLUTON mark only.
- **Do** announce state with a word and a mark together, never with color alone.
- **Do** set machine-produced strings in mono and human-written strings in Inter.
- **Do** keep functional text at 11px or larger, and body text at 13px or larger.
- **Do** let overlays be the only floating things on screen.
- **Do** honour `prefers-reduced-motion`: the anchor bob and the streaming caret stop.
- **Do** draw icons as inline SVG in a single 2px-stroke style, at 14–16px.

### Don't:

- **Don't** use a chromatic glow, a zero-offset colored shadow, or a colored blur. The connection
  dot is a solid mark, not a bloom.
- **Don't** use emoji as interface icons. The anchor, the folder, the ship, and the warning are
  SVG marks drawn in the same stroke style as everything else.
- **Don't** put a thick colored bar on the side of a card. A task's state is named in text and
  shown with a 1px tinted border plus a status word.
- **Don't** run text below 11px, and don't ship a size ramp with more than six steps.
- **Don't** fill a button with Signal Violet at #8b5cf6 and white text; it fails contrast.
- **Don't** let the sidebar cover the transcript at narrow widths. It is off-canvas there.
- **Don't** center the transcript. It is a left-aligned reading column with one stable edge.
