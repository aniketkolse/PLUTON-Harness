# TDD Evidence Report: TUI Refinement, Run Supervision, Model Switching & Tool Activity

## 1. Summary
Implemented comprehensive refinement across Pluton TUI:
- Elimination of repetitive `tool — tool` rendering, aggressive ellipses, and raw JSON blobs.
- Correlated tool lifecycles by `callId` with sanitized expandable JSON output.
- Real model listing and switching (`/models`, `/model [id]`) backed by engine capabilities, persisted in Store, with dynamic session engine switching.
- Automatic run supervision with internal `runId` tracking, milestone transcript notifications, and run cancellation (`/cancel [runId]`).
- Orchestra inspector enhancements displaying task dependencies (`needs: <id>`) and real Muse states (`idle`, `working`, `waiting`, `failed`, `done`) driven by assigned task states.

## 2. User Journeys Tested
1. **Model Switching**: Operator lists supported models via `/models` and switches default model via `/model <id>`. Persists in Store, switches live engine session, and updates header without losing history.
2. **Run Supervision & Cancellation**: Starts a supervised run, tracks progress automatically via poller, emits deduped milestone notices (`task.*`, `verification.*`, `run.*`), and permits abortion via `/cancel`.
3. **Tool Activity Formatting**: Formats tool events uniquely by `callId`, resolves readable summaries from file paths or arguments, prevents `name — name` duplication, and formats JSON outputs legibly.
4. **Orchestra Task Graph**: Renders assigned Muses with real task-driven states and displays task dependencies cleanly.

## 3. Test Specification & Guarantees

| # | Guarantee | Test File | Type | Result |
|---|-----------|-----------|------|--------|
| 1 | Slash commands `/models`, `/model`, `/cancel` route to context | `tests/unit/chat-commands-model.test.ts` | Unit | PASS |
| 2 | Store persists model updates via `updateMuseModel` | `tests/unit/store.test.ts` | Unit | PASS |
| 3 | Tool activity avoids `name — name` duplicates and formats JSON | `tests/unit/tui-activity-refinement.test.ts` | Unit | PASS |
| 4 | ACP normalization extracts `callId`, tool name, and formatted content | `tests/unit/acp-normalize-tool.test.ts` | Unit | PASS |
| 5 | Orchestra inspector renders task dependencies (`needs: ...`) | `tests/unit/tui-orchestra-dependencies.test.ts` | Unit | PASS |
| 6 | Chat session dynamically switches engine model and updates store | `tests/unit/chat-session-switch-model.test.ts` | Unit | PASS |
| 7 | Full CLI chat session executes `/models`, `/model`, `/cancel` end-to-end | `tests/integration/cli-chat-model-slash.test.ts` | Integration | PASS |

## 4. Verification Commands & Results
- Typecheck: `npm run typecheck` → 0 errors.
- Test Suite: `npm run check` (vitest) → 66/66 test files passed, 661/661 tests passed.
- Compilation: `npm run build` → compiled to `dist/`.
- Entrypoint: `node bin/pluton.js chat --json` → resolved chat plan with Docker container and model.
