# PLUTON — Critical Runtime Reliability Investigation Report (Part 1: Baseline)

**Date:** Sat Oct 31 2026
**Repository:** Y:\Pluton
**Branch:** main
**Commit:** a7bf741 (plus uncommitted PLUTON 3.2 changes)

---

## A. Working Tree State

**Modified files (tracked):**
- `src/bootstrap.ts`
- `src/cli/commands/ship.ts`
- `src/config/schema.ts`
- `src/engines/contract/types.ts`
- `src/orchestrator/service.ts`
- `src/orchestrator/supervisor.ts`

**New files (untracked):**
- `docs/MODEL_INTELLIGENCE_DESIGN.md`
- `docs/PLUTON_3.2_RELEASE_READINESS.md`
- `docs/PLUTON_3.3_LIVE_VALIDATION_REPORT.md`
- `src/config/model-config.ts`
- `src/engines/model-discovery.ts`
- `src/engines/model-fallback.ts`
- `src/engines/model-health.ts`
- `src/engines/model-registry.ts`
- `src/engines/model-selection.ts`
- `tests/unit/model-config.test.ts`
- `tests/unit/model-discovery.test.ts`
- `tests/unit/model-health.test.ts`
- `tests/unit/model-registry.test.ts`
- `tests/unit/model-selection.test.ts`
- `tests/unit/supervisor-model-selection.test.ts`

No commits or pushes have been made.

---

## B. Architecture Overview (from code inspection)

### Execution path

1. CLI `pluton run` → `src/orchestrator/service.ts:startRunInBackground()` → `createRunSupervisor()` → `RunSupervisor.runToCompletion()`
2. `runToCompletion()` claims run ownership, starts manager session, then enters dispatch loop
3. Dispatch loop calls `dispatchReadyTasks()` → `executeTask()` per ready task (keyed mutex per task)
4. `executeTask()` resolves model, starts engine session, runs prompt via `runPrompt()`, handles outcome
5. Manager session runs concurrently via `runManagerSession()`, decomposes work via tool bridge (task.create)

### Key components and their relationships

| Component | File | Role |
|-----------|------|------|
| RunSupervisor | supervisor.ts | Drive run, dispatch tasks, manage sessions |
| ModelRegistry | model-registry.ts | Discovered model inventory (composite key: engineKind+modelId) |
| ModelDiscoveryService | model-discovery.ts | Polls adapters for model lists |
| ModelCapabilityEvaluator + TaskModelSelector | model-selection.ts | Score/rank models against task requirements |
| ModelHealthMonitor | model-health.ts | Classify errors, track health state, cooldowns |
| ModelFallbackEngine (decideFallback) | model-fallback.ts | Decide retry/switch/exhausted |
| OpenCodeEngineAdapter | opencode/adapter.ts | OpenCode ACP adapter, listModels, startSession, applyModel |
| OpenCodeEngineSession | opencode/adapter.ts | ACP session, sendPrompt with inline fallback |
| AcpEngineSessionBase | acp/session-base.ts | Shared turn lifecycle, stream handling, timeout/poison |

---

## C. Critical Findings: Root Causes of Unreliability

### RC-1: Fallback engine is NEVER called from production code (CRITICAL)

`decideFallback()` in `src/engines/model-fallback.ts` (line 107) is **never invoked** from any production code path. grep confirms it appears only in:
- Its own definition (model-fallback.ts:107)
- Tests (tests/unit/model-fallback.test.ts)

`createRunSupervisor()` (service.ts:345) instantiates `ModelRegistry` and `ModelDiscoveryService` but does **NOT** instantiate `ModelHealthMonitor` or wire `decideFallback`.

**Consequence:** When a model hits a usage limit or becomes unavailable during task execution, the system never classifies the error, never updates health state, never selects a replacement model from the registry, and never switches. The task either retries with the same (exhausted) model or fails outright.

### RC-2: Two competing, incompatible fallback mechanisms

**Mechanism A (adapter-level, active):** `OpenCodeEngineSession.sendPrompt()` (adapter.ts:242-316) has inline fallback:
- Detects `isModelLimitError()` (regex-based, adapter.ts:154-157)
- Calls `selectFallbackModel()` which uses a **hardcoded preferred-order list** (adapter.ts:202-222): `opencode/flint-40b-free`, `opencode/beam-free`, `opencode/nemotron-3.5-lightning-free`, etc.
- Switches models within the SAME session via `switchModel()` → `applyModel()` → `session/set_config_option`
- Re-sends `initialInstructions` but does NOT preserve conversation/tool context
- If no candidate or switch fails, yields buffered events and returns (treated as failure by supervisor)

**Mechanism B (Phase 5, unused):** `decideFallback()` (model-fallback.ts:107) is a proper bounded state machine with health monitor integration, but is **never called** from production code.

**Consequence:** The active mechanism (A) uses hardcoded model names (violating the core design principle) and doesn't update health state. The proper mechanism (B) is completely disconnected.

### RC-3: No dynamic model selection after failure

In `executeTask()` (supervisor.ts:1078-1333), when `out.outcome === 'failure'`:
- Line 1247: `this.circuitBreaker.recordFailure(task.id, resultPayload)` — retries with the SAME model
- Line 1270: `this.failTask(task.id, ...)` — terminal failure

There is **no call** to `selectModel()` or `decideFallback()` to find a replacement model. Even if the registry has eligible models, they are never considered after a failure.

### RC-4: Context not preserved across model switches

The adapter's `switchModel()` (adapter.ts:224-239) switches the model config within the same session via `session/set_config_option`, then calls `this.setPendingInstructions(this.initialInstructions)` (line 306). This:
- Re-sends only the initial system instructions
- Does NOT preserve previous conversation turns, tool calls, tool results, or reasoning context
- The engine starts fresh with only the system prompt + new user prompt

If a replacement session were needed (e.g., adapter fallback exhausted), there is no mechanism to transfer prior context.

### RC-5: Session poisoning blocks recovery

`AcpEngineSessionBase` (session-base.ts:69) has a `poisoned` state. Once poisoned (timeout without cancel acknowledgment, buffer overflow):
- `sendPrompt()` throws `this.poisoned` immediately (line 128)
- Session cannot be reused for any further prompts
- No mechanism to create a replacement session with a different model

The supervisor's `executeTask()` does not handle poisoned sessions by creating a new session with a different model.

### RC-6: Retry uses same model, not model rotation

The circuit breaker (supervisor.ts:1247-1268) retries failed tasks with `task.attempt + 1` but passes the **same** `ship.model` / `resolvedModel` to `executeTask()` on retry. No model rotation occurs on repeated failures.

### RC-7: Health monitor and error classification exist but are unused

`ModelHealthMonitor` class (model-health.ts:263) and `classifyModelError()` (model-health.ts:201) are fully implemented but:
- `ModelHealthMonitor` is never instantiated in production code
- `classifyModelError` is never called during task execution
- `recordFailure()` is never called during task execution
- Health state never influences model selection

---

## D. Execution Lifecycle Findings

### Normal path (no failure)
1. `executeTask()` resolves model via `resolveTaskModel()` → `selectModel()` or pin
2. Session starts with `resolvedModel`
3. `runPrompt()` streams events, collects result
4. On success: task → `verifying` → `completed`
5. Session closed in finally block

### Failure path (current, broken)
1. `executeTask()` starts session with `resolvedModel`
2. `runPrompt()` returns `outcome: 'failure'` (e.g., usage limit from adapter's inline fallback exhaustion)
3. `executeTask()` calls `circuitBreaker.recordFailure()` → retries with SAME model
4. After max retries: `failTask()` → terminal `failed` state
5. **No health update, no classification, no replacement model selection, no fallback**

### Model switch path (adapter-level only)
1. Adapter's `sendPrompt()` detects `isModelLimitError()`
2. Calls `selectFallbackModel()` with hardcoded preferred list
3. If candidate found and `approvalPolicy === 'interactive'`, requests operator approval
4. If approved, calls `switchModel()` → `applyModel()` → `session/set_config_option`
5. Re-sends `initialInstructions`, continues prompt loop
6. If no candidate or switch fails or denied: returns buffered events as failure

---

## E. What Existing Tests Miss

| Test file | What it tests | What it MISSES |
|-----------|--------------|----------------|
| model-registry.test.ts | Registry add/update/remove/lookup | Integration with selection/fallback |
| model-discovery.test.ts | Discovery from adapters, failure isolation | Integration with supervisor execution |
| model-selection.test.ts | selectModel() scoring/filtering | Integration with health/fallback during execution |
| model-health.test.ts | classifyModelError, health state transitions | Integration with execution path (never called) |
| model-fallback.test.ts | decideFallback() logic | That decideFallback is never called in production |
| supervisor-model-selection.test.ts | resolveTaskModelFor() | That fallback never triggers during executeTask |
| opencode-model-fallback.test.ts | Adapter's inline fallback with hardcoded list | That hardcoded list violates design; adapter fallback not integrated with health monitor |
| supervisor.test.ts | Full run execution with mock adapters | That fallback engine is disconnected; model switching reliability |

---

## F. Initial Hypotheses for Reported Problems

| Reported problem | Likely root cause |
|-----------------|-------------------|
| Project-building tasks stop before completion | RC-1, RC-3: No fallback → task fails instead of switching models |
| Agent execution stops midway | RC-5: Session poisoned after timeout/error; no replacement session |
| Model switching doesn't happen smoothly | RC-1, RC-2: decideFallback never called; adapter fallback is hardcoded and disconnected |
| Fallback behavior unreliable | RC-2: Two competing mechanisms; only hardcoded adapter one is active |
| Component tests pass but production unreliable | RC-1: All fallback/health/component tests pass in isolation, but nothing wires them into executeTask |

---

## G. Plan for Part 2

Create an isolated temporary test workspace and run a bounded multi-step project-building task through the real `RunSupervisor` execution path, observing:
1. Task creation and dispatch
2. Worker session startup
3. Model selection and assignment
4. Execution events and tool call completion
5. Point of failure (where execution stops)
6. Whether fallback/health/failure classification ever triggers

Then proceed to Part 3 (trace termination paths) and Part 4 (repair model switching).

---

**Status:** Baseline established. Ready for Part 2 reproduction.