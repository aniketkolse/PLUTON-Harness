# ADR-0018 — Approval Model and Default Mode

- Status: Accepted (2026-10-25)
- Deciders: Core Architecture Team
- References: ADR-0006 (Task Persistence), ADR-0007 (Delegation), ADR-0009 (Integration), ADR-0016 (Static Composition), ADR-0017 (Session Log Query)

## Context

The Phase 1 audit recorded two related gaps:

- **O2** — no dedicated decision for Pluton's approval vocabulary, default mode, fail-closed
  resolution, or elevation journal; approvals existed only as rules scattered across ADR-0006/0007/0009.
- **R7** — OpenMausBot's five-mode enum defaults to `full` (blanket permission). That default is
  explicitly rejected for a local-first control plane.

Since the audit, the engine permission channel shipped (`src/engines/interactive-approval.ts`), the
operator surfaces (`pluton approvals`, the TUI card, `POST /api/approvals/:id/decide`) all funnel
through one durable approval lifecycle, and the delivery attempt was fixed end-to-end: a Ship's
recorded mode is now mapped into engine session construction instead of an adapter default
(`src/engines/approval.ts`). The remaining gap is the **decision record**, not missing behaviour.

The reference's modes are not a safety model: they assume the agent asks, and default to the widest
grant. PLUTON's boundary is different — the mode can only narrow what an engine may do; it never
creates consent the operator did not give.

## Decision

### 1. Mode vocabulary and default

Exactly three modes, defined once in `src/domain/models.ts`:

| Mode | Intent |
| --- | --- |
| `autonomous-bounded` | The engine receives no blanket consent; permission requests are denied fail-closed. Capability and integration gates still apply. |
| `ask-for-sensitive-actions` | Engine permission requests become durable operator approvals while the engine's request is held open. |
| `ask-always` | Same operator channel, reserved for engines that can surface every tool call. |

The default for a new Ship is **`ask-for-sensitive-actions`**, set in `src/config/schema.ts` and used
by every team template. There is no `full`, `allow-all`, or equivalent mode, and none may be added
without superseding this ADR.

### 2. Engine-boundary mapping

| Mode | OpenCode policy | Meaning |
| --- | --- | --- |
| `autonomous-bounded` | `deny` | No engine grant, even when isolation is runtime-proven. |
| `ask-for-sensitive-actions` | `interactive` | Request becomes an approval row; the engine waits. |
| `ask-always` | `interactive` | Same, because the engine decides when to ask. |

No mode maps to `allow_once` or `allow_always`. `ask-always` is currently behaviourally identical to
`ask-for-sensitive-actions` at the engine boundary: OpenCode does not expose a "ask for everything"
switch, and Pluton will not fabricate a distinction by granting more. The name records intent and
stays compatible if an adapter later exposes per-call permission requests.

### 3. Layered gates (a mode cannot bypass them)

The approval mode governs **engine permission requests** only. It does not replace:

- capability-expanding creations (`ship.create`, `muse.create`) requiring an approval record (ADR-0007);
- protected-path/main-branch integration approval (ADR-0009);
- the task `needs_approval` state and its resume rules (ADR-0006).

A permissive engine policy can never turn these into implicit grants, and a restrictive one cannot
make them disappear.

### 4. Fail-closed resolution

| Situation | Resolution |
| --- | --- |
| Unknown mode in `pluton.yaml` | Config schema rejects the value; no run starts. |
| Unknown/legacy mode in a stored Ship row | `ValidationError` at adapter construction; never a silent `deny` that looks like "nothing happened", and never a grant. |
| No durable approval row (store failure, lost ownership fence) | `deny` — no record, no authorization. |
| No operator surface attached | `deny` after the bounded wait. |
| TTL elapsed | Record becomes `expired`, an `approval.expired` event is written, engine answer is `deny`. Default TTL 60 minutes; `0` means the record never expires, bounded by session/prompt teardown. |
| Run cancelled, session closed, TUI/SPA disconnected | Pending requests settle `deny`; records expire with `pluton:aborted`. A cancelled turn never proceeds even if another process approved the same row concurrently. |
| More than 3 concurrent pending requests per session | `deny` without minting a record, waiter, or timer. |
| Duplicate or late decision | No-op; the first durable decision wins. |
| Any non-`pending` record | Only `approved` can ever produce an engine `allow`; `denied` and `expired` stay terminal. |

### 5. One decision funnel, one journal

All surfaces (`pluton approvals approve|deny`, the TUI approval card, the HTTP route) call the same
decision function. It writes the approval row and appends exactly one `approval.decided` event with
the resulting status. Creation writes `approval.requested`; timeout and abort write
`approval.expired`. `decidedBy` records the actor (`operator`, `pluton:timeout`, `pluton:aborted`).

The `approvals` table is the authoritative state; the event log is the append-only elevation journal
and is queryable with `pluton logs --type approval.requested --type approval.decided --type
approval.expired` (ADR-0017). No second approval system, in-memory queue, or per-surface cache exists.

### 6. Typed text is not consent

A/D/V act on a pending approval only when the composer is empty
(`src/tui/keys.ts`). Free text — chat lines, prompts, approval reasons, engine-provided scope — can
never answer a card or change a decision. Decisions require an explicit key, command, or HTTP call
bound to an approval id.

### 7. Attribution scope

PLUTON is single-operator today. `decidedBy` distinguishes the operator from system settlements;
per-user identity and multi-operator quorum are out of scope until the product has more than one
operator. The journal shape leaves room for them without a schema rewrite.

## Alternatives rejected

- **Five-mode enum with a `full` default** (reference prior art): default-permissive and assumes the
  engine asks; reproduces the failure R7 rejects.
- **Treat `autonomous-bounded` as auto-approve inside an isolated checkout**: isolation limits blast
  radius; it is not consent. The engine still gets `deny`.
- **Silent `deny` for an unknown stored mode**: hides misconfiguration and looks like a no-op success
  in the task record. Fail loudly instead.
- **In-memory or per-surface approvals**: no durable journal, no cross-process decisions, no recovery
  after restart.
- **Free-text decisions**: indistinguishable from prompt injection and impossible to audit by id.
- **Session-scoped blanket grants**: one approved request would authorize later, unread requests.

## Consequences

### Positive

- One vocabulary, one default, one decision funnel, one journal; every surface agrees by construction.
- The default is reviewable, and no mode can broaden consent beyond what the operator explicitly gave.
- Timeout, cancellation, store failure, and unknown modes all fail closed and leave truthful records.
- The journal is already queryable and replay-safe through ADR-0017.

### Negative

- An unattended run under an ask mode stalls until TTL expiry and then denies; operators must choose
  `autonomous-bounded` deliberately.
- `ask-always` is not yet distinguishable from `ask-for-sensitive-actions` with OpenCode.
- Approvals are per request, not per session; repeated requests require repeated decisions.
- Attribution stops at `operator`; no per-user audit until multi-operator exists.

### Neutral

- The mode set may grow when an engine exposes richer permission scopes; this ADR must be superseded
  first, and the ratchet test must be updated in the same change.

## Verification

| Claim | Test |
| --- | --- |
| Mode set, non-permissive default, no blanket mapping, unknown-mode rejection | `tests/unit/approval-model.test.ts` (ratchet) |
| Recorded mode reaches engine construction; unknown mode throws | `tests/unit/engine-approval.test.ts` |
| Allow only from the durable operator funnel; timeout/abort/store failure deny | `tests/unit/engine-interactive-approval.test.ts` |
| A real engine request can only be approved through the operator funnel | `tests/integration/engine-approval-seam.test.ts` |
| Typed text never answers a card | `tests/unit/tui-keys.test.ts` |

## Revisit triggers

- An engine adapter exposes per-call "ask for everything" permission scopes, making `ask-always`
  meaningfully stricter.
- A concrete need for session-scoped or repository-scoped grants appears (requires expiry, scope, and
  revocation semantics first).
- PLUTON gains more than one operator (identity, quorum, and separation of duties must be designed).
