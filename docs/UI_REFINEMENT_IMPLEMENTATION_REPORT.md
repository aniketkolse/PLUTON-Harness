# PLUTON Graphical Workspace — UI/UX Refinement Implementation Report

**Date:** November 2026  
**Document Version:** 1.0  
**Status:** Completed (Phases 1 through 6)  
**Target:** PLUTON Embedded Single-Page Application (`src/server/static-assets.ts`)

---

## 1. Executive Summary

This report documents the implementation of the UI/UX refinement across the PLUTON Graphical Workspace. The objective was to achieve an IDE-grade, high-density developer aesthetic while strictly preserving the three-panel layout (Left Sidebar, Center Workspace, Right Ship Activity Inspector), all runtime event/API contracts, zero external dependencies, and dark-theme charcoal/neutral grey color invariants (`--bg-main: #111114;`, `--bg-sidebar: #17171a;`, `--bg-surface: #1e1e24;`, `--border: #2a2a30;`).

Special priority was given to resolving the critical layout defect in the Right Ship Activity Inspector, where long model identifiers collided with and overlapped the worker status badge.

---

## 2. Phase-by-Phase Implementation Details

### Phase 1: Design Consistency & System Polish
- **Color Invariants:**
  Strictly preserved root variables `--bg-main: #111114;`, `--bg-sidebar: #17171a;`, `--bg-surface: #1e1e24;`, `--border: #2a2a30;`, `--accent-purple: #71717a;`, `--accent-purple-deep: #52525b;`, and `--accent-purple-soft: #a1a1aa;`.
  Removed legacy, unreferenced, or off-palette hex codes (e.g. `#6366f1` fallback in search input, `#818cf8` in search match/dirty tab, and `#2a2838` in dropdown menu), replacing them with semantic tokens (`var(--accent-cyan)`, `var(--bg-active)`, `var(--border-strong)`).
  Confirmed 0 occurrences of all 14 forbidden legacy purple hexes.
- **Typography & Font Smoothing:**
  Standardized typographic hierarchy between system sans-serif (`Inter`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`) and monospace (`JetBrains Mono`, `Cascadia Code`, `Consolas`, `SF Mono`).
- **Scrollbar & Focus Polish:**
  Unified custom webkit and Firefox scrollbars (8px width, `#27272a` thumb, hover `#3f3f46`, border-radius 999px).
  Unified `:focus-visible` ring across interactive controls with 2px solid `var(--accent-cyan)` and 2px offset.

### Phase 2: Left Sidebar Refinements
- **Sidebar Tabs & Action Buttons:**
  Aligned height and padding for `.sidebar-tabs` and accompanying icon buttons (`#sidebarTabSettings`, `#sidebarToggleBtn`).
  Set active tab button styling with subtle elevation and contrast (`background: var(--bg-active); color: var(--text); border-color: var(--border-strong);`).
- **File Explorer & Tree Hierarchy:**
  Added subtle vertical indentation guide lines to nested directories (`.file-children { display: flex; flex-direction: column; padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, 0.05); margin-left: 8px; }`), enhancing visual orientation in deep directory structures.
  Cleaned search bar input with focused cyan ring (`border-color: var(--accent-cyan);`), aligned search icon, and clear trigger.
  Replaced search highlight match color with `var(--accent-cyan)`.
- **Sessions Pane:**
  Preserved session deletion hover transition (`.session-delete:hover { color: var(--text-soft) }`) while maintaining clean item states and metadata formatting.

### Phase 3: Center Workspace Refinements
- **App Header & Project Selector:**
  Aligned brand mark, wordmark, and "Agentic Harness" badge with project dropdown selector.
  Cleaned project dropdown menu hover (`var(--bg-hover)`) and active items (`var(--bg-active); border: 1px solid var(--border-strong);`).
  Preserved split view button and header tools.
- **Conversation Stream:**
  Strictly preserved full-width message contract:
  `.messages { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 100%; box-sizing: border-box; }`
  `.msg-user { align-self: stretch; width: 100%; }`
  `.msg-ai { align-self: stretch; width: 100%; }`
  Markdown typography maintains balanced 1.6 line-height, clean paragraph spacing (8px), blockquote accents, and crisp table styling.
  Syntax highlighting tokens (`.tok-cm`, `.tok-st`, `.tok-kw`, `.tok-num`) and caret animation preserved verbatim.
  Tool activity cards maintain borderless transparent design with correlated ID lifecycles.
- **Dock & Composer:**
  Preserved `.dock { position: relative; }` and jump-to-latest button anchored at `bottom: calc(100% + 8px);`.
  Preserved `.composer { width: 100%; box-sizing: border-box; }` and textarea outline none with focus-within container rings.
  Polished mode switch (`#modeChatBtn`, `#modeToggleBtn`) and primary send/stop button.

### Phase 4: Right Ship Activity Inspector (Worker Partition Header Fix)
- **Defect Analysis & Root Cause:**
  In the worker partition header (`.worker-partition-head`), long model identifiers (such as `opencode/deepseek-v4.1-flash-free`) flexed without width boundaries. Because `.worker-partition-title` lacked `min-width: 0` and flex shrink boundaries, and `.worker-partition-model` had no truncation styling (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`), the title expanded horizontally until it directly collided with and covered `.worker-partition-meta` (the worker status badge).
- **CSS Flex Solution:**
  1. Updated `.worker-partition-head`:
     Added `gap: 8px; min-width: 0;` ensuring spacing is always maintained between title and status badge.
  2. Updated `.worker-partition-title`:
     Added `flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` so the title container respects the parent boundary and can shrink.
  3. Updated `.worker-partition-name`:
     Added `flex-shrink: 0; min-width: 0; font-weight: 600;` to ensure the Ship identity (e.g. `CODER`) is never squished before the model.
  4. Updated `.worker-partition-task`:
     Added `flex-shrink: 0;` to maintain task ID visibility.
  5. Updated `.worker-partition-model`:
     Set `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1;` with a subtle chip background (`background: rgba(255, 255, 255, 0.04); padding: 1px 5px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft);`). When space is constrained, the model identifier truncates with an ellipsis (`opencode/deepseek-v4.1-...`) without ever touching the status badge.
  6. Updated `.worker-partition-meta`:
     Added `flex-shrink: 0; margin-left: auto;` ensuring the status badge always remains fully visible and anchored to the right.
  7. Updated `/app.js`:
     Added `title` attribute containing the full unclipped model identifier (`title="' + escapeHtml(worker.model) + '"`) both on partition creation and on element updates, allowing operators to view the full model identifier on hover.
  8. Refined `.worker-partition-workspace-line`:
     Gave subtle dark background (`rgba(0, 0, 0, 0.15)`) with monospace letter-spacing.
  9. Refined `.worker-partition`:
     Added divider border (`border-bottom: 1px solid var(--border-soft);`) between equal-height partitions.

### Phase 5: Interactions, Modals & States
- **Modals & Overlays:**
  Preserved `.modal`, `.modal-card`, and `#workerDetailModal` layout and structure.
  Maintained accessible input styling inside `.worker-detail-compose input { background: var(--bg-inset); }`.
  Maintained Pluton-owned dialog system (`#plutonDialog`).
- **Interactive QA Question Cards:**
  Preserved `.qa-card`, `.qa-badge`, `.qa-option-btn`, and `.qa-confirm-btn` contracts.
  Options feature crisp selection states with focused outlines.

### Phase 6: Responsive & Accessibility Compliance
- **Breakpoints:**
  Verified `@media (max-width: 1000px)`, `@media (max-width: 720px)`, and `@media (max-width: 480px)` styles.
  Sidebar and inspector slide gracefully over workspace on narrower viewports with appropriate scrim overlay (`.sidebar-scrim`).
- **Reduced Motion:**
  Preserved `@media (prefers-reduced-motion: reduce)` disabling continuous animations (such as `.boat` or caret blinking) for users requesting reduced motion.
- **Keyboard Navigation:**
  Worker partition headers and modal buttons maintain `role="button"`, `tabindex="0"`, and visible focus outlines.

---

## 3. Verification & Compliance Matrix

| Component / Requirement | Contract Specification | Status |
|-------------------------|------------------------|--------|
| Three-Panel Architecture | Left Sidebar + Center + 440px Inspector | VERIFIED PASS |
| Neutral Grey Palette | Charcoal dark-theme (`#111114`, `#17171a`, `#1e1e24`, `#2a2a30`) | VERIFIED PASS |
| Forbidden Purple Guard | 0 occurrences of 14 forbidden hex codes | VERIFIED PASS |
| Inspector Header Fix | Model truncation + flex bounds + status clearance | VERIFIED PASS |
| Full-Width Messages | 100% width, no right alignment on user messages | VERIFIED PASS |
| Dock & Jump Button | Relative dock, `bottom: calc(100% + 8px);` | VERIFIED PASS |
| File Explorer Guide | Subtle indentation border on `.file-children` | VERIFIED PASS |
| Automated UI Tests | 87/87 tests passing across 14 test suites | VERIFIED PASS |
| Assets Verification | `npm run verify:assets` (77 checks passed) | VERIFIED PASS |
| TypeScript Build | `npm run build` & `npm run typecheck` cleanly passed | VERIFIED PASS |

---

## 4. Conclusion

All six implementation phases have been successfully executed without introducing new dependencies or breaking any existing runtime or test contracts. The PLUTON graphical interface now reflects a clean, disciplined, IDE-grade developer environment with zero text collisions and robust responsive behavior.
