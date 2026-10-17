# Pluton-Harness Architecture Audit (Priority 0)

Date: 2026-10-17. Scope: repository structure, launcher path, chat/TUI pipeline, approval
lifecycle, tool-catalog integration. Method: source inspection + real command runs
(`npm run typecheck`, `npm run test`, `npm run build`, live bridge probe). No claims below
are based on documentation alone where a run was possible.

## 1. What the running system actually is

- TypeScript on Node.js, compiled with `tsc -p tsconfig.build.json` to `dist/`.
- Real launcher: `bin/pluton.js`, which prefers the compiled `dist/` output when present.
  Any `src/` edit therefore requires `npm run build` before the launcher sees it.
- Entry points: `src/app.ts` (CLI), `src/cli/commands/chat.ts` (chat command),
  `src/chat/session.ts` (interactive session loop), `src/tui/*` (rendering).
- Persistence: SQLite via `src/store/*` (runs, tasks, chat sessions/messages, approvals,
  events). Engine integration: ACP adapters under `src/engines/` (opencode, qwen, mock).
- Orchestration: Manager/worker Muses through a restricted tool bridge
  (`src/tools/bridge.ts`, `src/tools/operator-catalog.ts`, `src/tools/handlers.ts`).

## 2. Why the TUI looked like a line-oriented console (root cause)

Full write-up: `docs/tui-diagnosis.md`. Summary:

1. `renderFullScreenFrame()` existed but **was never called** by `ChatSession`; the session
   committed raw lines through `TerminalHost.commit()` to stdout.
2. No alternate-screen buffer was ever entered, so no full-screen layout could be painted.
3. Cursor positioning used relative movement with no atomic frame; resizes garbled output.
4. The launcher can run stale `dist/` code if `npm run build` is skipped after edits.

Fixed in this pass: `TerminalHost` enters the alternate buffer, `commit()` becomes a no-op
for stdout in alt-screen mode (transcript is kept in `ChatSession.transcriptLines`),
`renderFrame()` paints one atomic frame (hide cursor → home → content → clear → position →
show cursor), and process-level hooks (`exit`, `SIGINT`, `SIGTERM`, `uncaughtException`)
restore the terminal. Legacy non-alt-screen path is unchanged.

## 3. Why raw text like `approval pending: approval.request` appeared in chat (root cause)

Three separate contamination paths, all in the chat layer:

1. `src/cli/commands/chat.ts` poll produced notices `approval pending: <id> (<action>)` which
   `ChatSession.runPollTick()` committed into the transcript as dim prose. It was plain text,
   not actionable, and re-emitted after any session restart.
2. `runPollTick()` also committed every lifecycle event matching
   `/^(run|task|verification|approval)\./` as raw dim lines — a lifecycle-event dump in the
   middle of the conversation.
3. Engine-level `approval_request` events (emitted by the ACP adapters when the engine asks
   for permission; Pluton auto-denies fail-closed) were rendered as an *actionable* card with
   the invented label `'sensitive action'`, whose `[A]/[D]` refs could never resolve to a
   durable backend approval record.

Fixed in this pass (Priority 0):

- Approvals are now a first-class inbox in `ChatSession`: upserted by stable backend id from
  the poll's full records, rendered as **one canonical pinned card** above the composer
  (`┌ APPROVAL REQUIRED …`, Muse / Action / Reason / Scope / Ref, `[A] Approve once`,
  `[D] Deny`, `[V] View details`). Duplicate delivery and replay cannot duplicate the card.
- The card is removed only when the authoritative store record is no longer `pending`
  (`reconcileApproval` re-reads `store.getApprovalOrNull` after every decision). An
  unconfirmed decision keeps the card.
- `[V]` opens a read-only details overlay (`APPROVAL DETAILS · read-only`); `Esc` closes the
  overlay first and never decides. `[A]/[D]` call the existing backend operations
  (`decideApproval` path) and surface backend errors verbatim.
- Engine permission requests now produce exactly one honest, non-actionable notice
  (`⚠ engine permission request (auto-denied, fail-closed) [ref]`); no fake approve/deny.
- Lifecycle events feed the Orchestra inspector only. Run transitions emit exactly one
  compact system line (`run <id> → <state>`), not a per-poll dump.
- Raw `approval pending:` text is gone from the codebase.

## 4. Why the Manager saw an empty Pluton tool catalog (root cause)

`toolBridge` exposure is permission-gated: `project.status`, `run.list`, `run.inspect`,
`run.start`, `approvals.list` (see `src/tools/operator-catalog.ts`). The Manager's Muse spec
in several configs omitted `permissions`, and `museSpecs()` in `src/bootstrap.ts` did not
default them, so the bridge legitimately exposed zero tools — with no explanation in the UI.

Fixed:

- `museSpecs()` falls back to `ROLE_DEFAULT_PERMISSIONS[muse.role]` when config omits
  permissions (supervisor default includes the operator catalog permissions).
- Operator permissions added to `templates/teams/full-stack.yaml`, `bugfix.yaml`,
  `repository-analysis.yaml` and the smoke/root `pluton.yaml` configs.
- `chat.ts` counts the bridge's exposed tools at startup and emits an explicit warning
  notice naming the missing permissions instead of showing a silent empty catalog.
- Deterministic proof: `tests/unit/tool-bridge-operator.test.ts` (authorized Muse sees the
  five operator tools; unauthorized Muse sees none).

## 5. Compact UI pass (same Priority 0 slice)

- One-row header: ` ⛵ PLUTON  <project>          <muse> · <engine>` with the rule below it;
  the pirate-ship mark falls back to `~^~` without Unicode. No box borders in the header.
- Composer placeholder (`Ask Pluton to plan, implement, investigate…`), pinned composer.
- Contextual footer: status badge (`READY` / `RUNNING` / `APPROVAL REQUIRED (n)`), contextual
  key hints, model, enabled-Muse count, and token counts **only when real data exists**.
- Turn labels `You` / `PLUTON` replace the old `> prompt` echo; live streaming keeps a `▌`
  indicator; in-flight tools render with running/completed status.
- Approval card and details overlays have dedicated layout regions
  (`computeLayout` – `approval`, `details` rects) and never overlap the pinned composer.

## 6. Verification evidence (actual runs)

| Command | Result |
| --- | --- |
| `npm run typecheck` | 0 errors |
| `npm run test` (via `npm run check`) | 646 passed / 646, 60 files |
| `npm run build` | clean (dist refreshed) |
| Live bridge probe (smoke project) | exposed tools: `project.status, run.list, run.get, run.start, approvals.list` |
| `tests/integration/approval-lifecycle.test.ts` | 6/6: one canonical card; no transcript leak; duplicate delivery safe; approve/deny confirmation-gated; details never decides; engine request non-actionable |

New/changed tests are listed in section 7. UI behavior is additionally verified by the new
integration suites rendering real `ChatSession` frames through a scripted IO stub.

## 7. Files touched in this slice

- Core: `src/tui/terminal.ts`, `src/tui/layout.ts`, `src/tui/render.ts`, `src/tui/approval.ts`,
  `src/tui/theme.ts`, `src/chat/session.ts`, `src/cli/commands/chat.ts`, `src/bootstrap.ts`
- Configs: `templates/teams/*.yaml`, root `pluton.yaml` (smoke config under `.pluton-tmp/`,
  gitignored)
- Tests: new `tests/integration/approval-lifecycle.test.ts`,
  `tests/integration/chat-session-fullscreen.test.ts`,
  `tests/unit/tool-bridge-operator.test.ts`; updated `tests/unit/tui-terminal.test.ts`,
  `tests/unit/tui-layout.test.ts`, `tests/unit/tui-approval.test.ts`,
  `tests/integration/chat-session.test.ts`, `tests/integration/cli-chat.test.ts`

## 8. Known limitations (not yet implemented, stated honestly)

- Engine-level permission prompts still have no interactive approve path in this build; the
  adapters deny fail-closed and the UI reports that truthfully.
- Token/cost telemetry depends on what the provider reports; the footer hides those fields
  when no real data is available. No cost figures are estimated.
- Plan mode, session browser, `/model`, `/compact` etc. remain on the roadmap
  (see `docs/research-comparison.md` for status), not claimed as implemented.
