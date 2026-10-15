# ADR-0008 — Model authentication directory and secret storage

- Status: Accepted (2026-10-16)

## Context

Each engine needs model-provider credentials. Host CLI login state does not automatically exist
inside Docker, must not be copied into every worker, and must never leak into YAML, databases,
events, logs or process arguments. Multiple Muses may use *different* engines with *different*
credentials on the same machine.

## Decision

- **Per-Muse engine home:** `.pluton/engine-homes/<muse-id>/` (excluded from version control,
  created with restrictive permissions — `0700` where the OS supports it; Windows uses best-effort
  ACLs via `icacls`, documented as weaker than Linux).
- Engine processes are launched with engine-specific config-dir environment variables pointing at
  that home (exact variable per engine recorded in `docs/ENGINE_ADAPTERS.md` once verified in
  Phase 4; e.g. engine-native config-dir env vars or `XDG_CONFIG_HOME` where applicable), plus a
  minimal env allowlist (never the daemon's own secrets).
- **Credential entry flow:** `pluton muse auth <muse>` runs the engine's own interactive login
  with the private home mounted/pointed at, inside the worker container (Phase 5+); meanwhile
  `pluton doctor` reports per-Muse auth *presence* (boolean) with editing instructions and never
  prints values.
- **Prohibited locations for secret values:** `pluton.yaml`, SQLite rows, event payloads, task
  artifacts, process argv, logs. A redaction pass (common key/token shapes) runs over diagnostic
  text before persistence and display; redaction is defense-in-depth, not a license to log
  secrets.
- **Revocation:** deleting a Muse's engine home revokes its credentials; `pluton muse show`
  reports the home path so this is discoverable.
- Copying the user's whole host engine config into Pluton homes is explicitly not done; the
  documented flow is a fresh login per Muse (or a user-managed copy they choose to make).

## Consequences

- Same-engine, different-account Muses are possible; cross-Muse credential bleed is prevented by
  directory separation.
- First-run friction: each Muse authenticates once. Doctor output makes this explicit instead of
  failing midway through a run.

## Evidence

- Prompt §8; Docker env/mount rules in ADR-0004; threat model in docs/SECURITY.md.
