# ADR-0011 — Independence, licensing and reuse policy

- Status: Accepted (2026-10-16)

## Context

Two reference repositories are studied for architectural patterns (read-only checkouts under
`references/`): cloudroom-core (Apache-2.0) and OpenMausBot (Apache-2.0 with a source-available
`enterprise/` carve-out and trademark restrictions). The master prompt forbids wholesale copying,
vendor merging, renamed clones, and any implication of affiliation.

## Decision

- Pluton-Harness is an **independent** project; the README and all docs state non-affiliation.
- **No reference code is copied in this milestone.** Patterns are learned at the concept level
  and re-implemented against Pluton's own contracts. If any code is ever adapted verbatim,
  `docs/reverse-engineering/reuse-and-license-audit.md` must be extended with source URL, commit
  SHA, original license, changes made, and required notices.
- **Never** reuse source from `openmausbot/enterprise/` (different license, production use needs
  a license key) or from separately licensed third-party bundles; trademarked names/mascots are
  never used.
- `THIRD_PARTY_NOTICES.md` lists runtime/dev dependencies and their licenses; updated when
  dependencies change.
- Pluton's outbound license is **Apache-2.0**, decided and authorized by the owner
  for public distribution (`package.json` `"license": "Apache-2.0"`, `LICENSE` in root,
  and `"private": true` removed for npm package publication).

## Consequences

- The reverse-engineering deliverables carry a per-directory license audit and an explicit
  no-copy record.
- Any future verbatim reuse has a documented intake checklist.

## Evidence

- cloudroom-core `LICENSE` (Apache-2.0) — read directly at commit `3949daa…`.
- OpenMausBot `LICENSING.md` (Apache-2.0; `enterprise/` under OpenMausBot Enterprise License;
  trademark note re Supamaus Software) — read directly at commit `7d00805…`.
