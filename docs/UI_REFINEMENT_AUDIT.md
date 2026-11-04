# PLUTON Graphical Workspace — UI/UX Refinement Audit

**Date:** November 2026  
**Document Version:** 1.0  
**Phase:** Phase 0 (UI Audit & Baseline State Analysis)  
**Target:** PLUTON Web & Desktop Embedded Single-Page Application (`src/server/static-assets.ts`, `src/ui/theme.ts`)

---

## 1. Executive Summary & Objective

The objective of this refinement is to elevate the visual quality of the PLUTON-Harness graphical interface to an out-of-distribution, production-grade developer tool standard. In accordance with the non-negotiable constraints:
- The existing three-panel layout (Left Sidebar, Center Workspace, Right Ship Activity Inspector) is strictly preserved.
- Existing component hierarchy, DOM IDs, data attributes, event bindings, and API contracts remain untouched.
- No new UI dependencies or frameworks are introduced (retaining zero-dependency SPA architecture).
- The incumbent dark-first developer aesthetic (charcoal/neutral grey surfaces with precise functional accents) is preserved and harmonized without breaking existing test assertions or introducing noisy decorative artifacts.

This audit documents the current state, identifies visual defects and inconsistencies, and defines the refinement plan for Phases 1 through 7.

---

## 2. Current Architecture & Component Hierarchy

### A. Overall Layout Shell (`.app-shell`)
- **Left Sidebar (`#leftSidebar`, `.app-sidebar`):**
  - Default width: 280px (resizable 200px–600px via `.sidebar-resizer`).
  - Collapse/Restore mechanism: `#sidebarToggleBtn` collapses to width 0; `#collapsedSidebarToggle` provides a 48px restore strip.
  - Structure:
    1. Header (`.sidebar-head`): Tab bar (`#sidebarTabSessions`, `#sidebarTabFiles`), Settings toggle (`#sidebarTabSettings`), Collapse button (`#sidebarToggleBtn`).
    2. Sessions Pane (`#paneSessions`): Action button (`#btnNewSession`), Session list (`#sessionsList`, `.session-item`, `.session-delete`).
    3. Files Pane (`#paneFiles`): Workspace metadata header (`#filesWorkspaceLabel`), Sub-tabs (`#tabFiles`, `#tabDiffs`), Search bar (`#fileSearchInput`, `#fileSearchClear`), Breadcrumbs (`#fileBreadcrumbs`), Tree view (`#filesList`), Search results (`#fileSearchResults`).
    4. Settings Pane (`#paneSettings`): Cards for Account Profile, AI Providers, Custom AI Models & Keys, Permissions & Approvals, Reasoning Effort, Agent Model Config (`#museModelList`), MCP Servers (`#mcpCardList`), Project Identity, Workspace Root.
- **Center Workspace (`.app-main`):**
  - Top Header (`.app-header`): Brand identity (Ship SVG mark, `PLUTON`, `Agentic Harness` badge), Project selector dropdown (`#projectSelectBtn`, `#projectSelectMenu`), Header tools (`#btnToggleSplitView`, `#connectionStatus`).
  - Conversation Scroll Container (`#chatScrollContainer`):
    - Scroll fade overlay (`.chat-fade`).
    - Message list (`#messagesList`): `.msg-user`, `.msg-ai`, `.msg-system`, `.msg-error`, `.msg-activity`.
    - Markdown body: Headings (h1–h4), lists, tables, blockquotes, inline code, fenced code blocks with syntax highlighting (`.tok-cm`, `.tok-st`, `.tok-kw`, `.tok-num`), streaming caret.
    - Tool activity nodes: `.tool-card`, details/summary, `.tool-name`, `.tool-status`, `.tool-card-input`, `.tool-card-body`, `.tool-spinner`.
    - QA Question cards (`.qa-card`): Option pills, Confirm & Unblock button.
  - Docked Composer Area (`.dock`):
    - Jump to latest button (`#btnJumpToLatest`).
    - Supervised build confirmation card (`#buildConfirm`).
    - Composer container (`.composer`): Textarea (`#promptInput`), Attachment tray (`#attachmentPreviewContainer`), Composer action bar (`.composer-bar`).
      - Left controls: Mode switch (`#modeChatBtn`, `#modeToggleBtn`), Attachment button (`#btnAttach`), Voice input (`#btnMic`), Ship activity badge (`#shipActivityBadgeContainer`).
      - Right controls: Primary button (`#btnPrimary` with `#actionBtnIcon` and `#actionBtnLabel`).
  - Status Strip (`.status-strip`):
    - Left items: Thinking/Run status (`#thinkingStatus`, `#thinkingIcon`, `#thinkingText`, `#queueBadge`), Workspace folder chip (`#workspaceChip`), Active Model switcher button (`#modelLabelBtn`, `#activeModelName`), Token telemetry (`#sbContext`).
    - Right items: MCP toggle button (`#mcpToggleBtn`, `#mcpCountBadge`).
  - In-place File Viewer & Editor (`#fileViewer`):
    - Tabs bar (`#fileTabsBar`, `.file-tab`).
    - Viewer header (`#fileViewerPath`, `#fileViewerLang`, `#fileViewerDirty`, `#fileViewerEdit`, `#fileViewerSave`, `#fileViewerClose`).
    - Split editor surface: Line gutter (`#codeGutter`), Highlight layer (`#codeHighlight`), Code input (`#fileEditorInput`).
- **Right Ship Activity Inspector (`#rightInspector`, `.right-inspector`):**
  - Width: 440px fixed desktop width.
  - Header (`.right-inspector-head`): Brand mark, Title "Ship Activity Inspector", Active count tag (`#rightInspectorCount`), Close button (`#rightInspectorClose`).
  - Worker Partitions Grid (`#rightInspectorGrid`):
    - Equal-height partitions (`.worker-partition`) with flex layout (`flex: 1 1 0; min-height: 0;`).
    - Partition Header (`.worker-partition-head`): Ship display name / role (`.worker-partition-name`), Task ID (`.worker-partition-task`), Model identifier (`.worker-partition-model`), Status badge (`.worker-badge-status`).
    - Workspace line (`.worker-partition-workspace-line`).
    - Activity stream (`.worker-stream`, `.worker-stream-entry`).
    - Empty state (`.worker-empty`, `.worker-empty-title`, `.worker-empty-hint`).
- **Modals and Overlays:**
  - Searchable Model Select Dialog (`#modelSelectModal`).
  - Worker Detail Modal (`#workerDetailModal`).
  - Add Provider Dialog (`#providerAddModal`).
  - Set Provider Key Dialog (`#providerKeyModal`).
  - Attach Workspace File Dialog (`#attachModal`).
  - New Session Dialog (`#newSessionModal`).
  - MCP Popover (`#mcpPopover`).
  - Pluton Dialog (`#plutonDialog`).
  - Toast Notifications (`#toastHost`, `.toast`).

---

## 3. Visual & Usability Audit (Discovered Flaws & Inconsistencies)

### A. Left Sidebar Audit
1. **Header & Tabs Alignment:**
   - The `.sidebar-tabs` container and the two icon buttons (`#sidebarTabSettings`, `#sidebarToggleBtn`) have mismatched heights and borders.
   - The tab button active state uses `--bg-active` without crisp contrast against the sidebar background.
2. **File Explorer & Tree Hierarchy:**
   - Indentation in nested folder levels (`.file-children { padding-left: 12px; }`) lacks a subtle guide line to orient deep nesting.
   - Folder chevrons (`.file-chevron`) are small and low-contrast, making it harder to distinguish open vs. closed states at a glance.
   - Hover and selected states (`.file-row:hover`, `.file-row.is-active`) have hard edges and inconsistent padding with delete action triggers.
   - Search bar input (`.file-search-input`) has loose margins, rough focus ring, and clear button alignment issues.
3. **Sessions Pane:**
   - The `+ New Session` button (`.btn-new`) is a heavy block with inconsistent border styling relative to secondary buttons elsewhere in the app.
   - Active session item (`.session-item.is-active`) has high contrast text but no crisp accent bar or subtle marker.
4. **Settings Pane:**
   - Card components (`.card`) have inconsistent padding and cluttered headers.
   - "Add Custom AI Model" notice (`.notice-danger`) uses a stark red border-left that clashes with the restrained instrument aesthetic.
   - Form inputs (`.input-text`, `.mini-select`, `.select-box`) have varying border radii and focus indicators.

### B. Center Workspace Audit
1. **Header Alignment & Hierarchy:**
   - Brand mark, wordmark, and badge lack micro-spacing alignment with project selector dropdown.
   - "Sub-Agents Split View" button has uneven vertical padding compared to other header controls.
2. **Message Typography & Spacing:**
   - Paragraph margins (`margin: 0 0 8px;`) and list item margins (`margin-bottom: 3px;`) feel slightly compressed in dense multi-step plans.
   - Inline code (`.msg-body code`) has a slightly heavy 1px border and boxy padding (`1px 5px`).
   - Code blocks (`pre.code-block`) lack a subtle header bar showing syntax or language name.
   - User message (`.msg-user`) and assistant message (`.msg-ai`) need clearer typographic pacing and subtle visual separation without resorting to heavy card bubbles.
3. **Tool Activity Rows:**
   - Tool card summary text (`.tool-summary-chip`) has no subtle background pill and sometimes blends too much into the background.
   - Expand/collapse chevrons have loose vertical alignment with monospace tool names.
4. **Composer & Dock:**
   - The mode switch (`.mode-switch`) contains flat buttons with inconsistent active shadows.
   - Action buttons (`#btnAttach`, `#btnMic`) have mismatched dimensions and icon vertical centering.
   - `#btnPrimary` (Send / Stop) has an icon (`.stop-square`) with 2px radius and slight baseline misalignment.
   - Jump to latest button (`#btnJumpToLatest`) has a generic dark pill look that looks detached from the dock.
5. **Status Strip:**
   - Divider characters (`|` and `·`) are raw text with uneven baseline heights.
   - Long model names (`opencode/deepseek-v4.1-flash-free`) in `#modelLabelBtn` can truncate abruptly or crowd neighboring items.
   - Workspace chip has loose alignment between folder SVG, workspace name, separator, and path.

### C. Right Ship Activity Inspector Audit
1. **Worker Partition Header Collision (Critical Defect):**
   - As observed in `docs/audit-1200px.png`, long model identifiers (e.g. `opencode/deepseek-v4.1-flash-free`) flex without bounds, causing the model name text to collide directly with the status badge (e.g., `opencode/deepseek-v4.1-fl COMPLETED`).
   - `.worker-partition-title` lacks flex shrinkage and truncation safeguards.
2. **Worker Identity Presentation:**
   - The worker role/name (`CODER`, `TESTER`) is unstyled text rather than an identifiable, crisp micro-badge.
   - The task ID and model identifier lack clear typographic hierarchy and subtle contrast separation.
   - The workspace path row (`.worker-partition-workspace-line`) sits as raw unformatted text across the partition.
3. **Stream Activity & Log Readability:**
   - Worker log stream (`.worker-stream`) has minimal line-height and monochromatic entries.
   - Error entries (`.is-err`) and tool entries (`.is-tool`) need sharper, refined typographic distinction.
4. **Empty State:**
   - `.worker-empty` text is plain and lacks the maritime/anchor visual restraint of PLUTON.

### D. Shared Tokens & Microinteractions Audit
1. **Transitions:**
   - Buttons, list items, and tabs have varying transition durations (90ms, 120ms, 140ms, 150ms).
   - Standardize to a unified scale: 120ms ease for micro-hovers, 180ms ease-out for panel expansions/drawers.
2. **Focus Indicators:**
   - `:focus-visible` outline is cyan on some elements and custom border-color on others.
   - Standardize visible, accessible focus rings that honor WCAG 2.2 AA.

---

## 4. Preservation & Safety Register

The following assets, attributes, and contracts must remain strictly preserved to guarantee 100% test passing and runtime integrity:
- Root CSS variables: `--bg-main: #111114;`, `--bg-sidebar: #17171a;`, `--bg-surface: #1e1e24;`, `--border: #2a2a30;`, `--accent-purple: #71717a;`, `--accent-purple-deep: #52525b;`, `--accent-purple-soft: #a1a1aa;`.
- Absolute avoidance of forbidden legacy purple hexes: `#7c3aed`, `#6d28d9`, `#8b5cf6`, `#a855f7`, `#3b2d63`, `#2f2749`, `#1b172a`, `#14121f`, `#31274f`, `#161422`, `#2a263d`, `#b5b1c9`, `#241e38`, `#181625`.
- Layout structure: 440px width inspector, full-width messages/composer, responsive breakpoints (`@media (max-width: 1000px)`, `@media (max-width: 720px)`, `@media (max-width: 480px)`).
- All DOM IDs (`#app`, `#leftSidebar`, `#rightInspector`, `#chatScrollContainer`, `#messagesList`, `#promptInput`, `#btnPrimary`, `#btnAttach`, `#btnMic`, `#modeChatBtn`, `#modeToggleBtn`, `#btnJumpToLatest`, `#thinkingStatus`, `#workspaceChip`, `#modelLabelBtn`, `#mcpToggleBtn`, `#workerDetailModal`, etc.).
- All API and SSE event handling in `/app.js`.

---

## 5. Phase Plan for Execution

- **Phase 1 (Design Consistency):** Standardize typography rhythm, spacing scale, border treatment, scrollbar polish, and focus rings.
- **Phase 2 (Left Sidebar):** Polish tabs header, file tree hierarchy, icons, hover/active selection states, search bar, and sessions list.
- **Phase 3 (Center Workspace):** Polish chat typography, code blocks, lists, tool activity nodes, composer inputs, mode switch, and status bar.
- **Phase 4 (Ship Activity Inspector):** Fix worker partition header collision, refine worker role badges, model tags, workspace line, and stream typography.
- **Phase 5 (Interactions & States):** Standardize buttons, modals, popovers, QA cards, tooltips, loading spinners, and empty states.
- **Phase 6 (Responsive & Accessibility):** Verify mobile/tablet breakpoints, overflow behaviors, keyboard focus navigation, and reduced motion.
- **Phase 7 (Final Polish & Verification):** Live execution test, screenshot inspection, full automated test suite validation, and final acceptance reporting.
