# PLUTON Team Collaboration — How Ships Work Together Like Office Workers

PLUTON's direct-write mode puts every Ship in the same project directory, the same way Cursor, Claude Code, Codex and OpenCode work directly in your folder. Filing writes are real filesystem writes, just like a human team sharing one project tree. To keep that safe, the team uses a small protocol of durable, auditable tools instead of private context and hope.

## The Protocol

| Moment | Tool | Purpose |
|---|---|---|
| At session start | `spec.read` | See the team's agreed contracts, specs and decisions |
| At session start | `ship.inbox` | Catch messages addressed to you |
| Before editing a file | `file.claim` | Broadcast intent: path + what you'll do |
| After editing | `file.release` | Free the file for others |
| Starting work | `team.broadcast` (kind `announcement`) | Tell the team what you're about to do |
| Progress checkpoint | `team.broadcast` (kind `progress`) | Share what changed and what's next |
| New approach | `team.broadcast` (kind `idea`) | Suggest an approach the team should consider |
| Shared decision | `spec.write` | Record a contract/spec the whole team follows |
| Sharing a file/finding | `ship.message` (kind `evidence`) | Send file path or finding to a teammate |
| Before finishing | `ship.inbox` | Catch blocks, questions, handoffs |

Delivery is durable and at-most-once: every `worker.message`, `worker.spec.created`, `worker.spec.updated`, `worker.file.claim`, `worker.file.release` is appended to the run's durable event log and replayed in the activity feed.

## How conflicts are prevented

- **File leases** (`leaseManager`) block two Ships from writing the same path at once — the second write is refused with a lease-conflict error until the first releases.
- **File claims** are advisory: other Ships see the claim and route around it; claims are recorded with intent text and end with `file.release`.
- **`writeScope`** still narrows what a task is allowed to change; coordination never widens it. A peer message never authorizes more work than the brief does.

## What the UI shows

- **Main conversation** prints spec/claim/broadcast activity as concise feed items (e.g. `Researcher X: claimed src/api.ts`).
- **Worker Activity Inspector** shows a per-worker live stream: messages, spec changes, claims and releases.
- **Worker detail modal** lists the worker's durable messages and tool steps.
- The Files panel always reflects the **project root** — create, edit or delete a file and it appears within ~5s. A "Session checkout" checkbox shows an isolated checkout view instead.

## Honest limitations

- LLM engines cannot be pushed a message mid-turn; delivery happens at the next tool call. Short, self-contained tasks see fewer messages; long-running tasks see them reliably inbox-gated.
- `ship.inbox` is at-most-once: acknowledged messages are never re-delivered.
- Messages and broadcasts are capped (8,000 chars/body, 500 messages/run) so a runaway worker cannot flood the others.
- Cross-run memory is via the project directory itself (specs and diffs survive); per-conversation history is recoverable through the durable log and `worker.message.delivered`.
