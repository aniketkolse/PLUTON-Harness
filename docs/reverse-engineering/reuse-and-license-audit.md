# Reuse and license audit — reference repositories vs Pluton-Harness

## Purpose

This document records, as of 2026-10-16, the licensing facts of the two reference repositories
studied in Phase 1, the component-level restrictions inside them, the code-reuse register (what, if
anything, was copied or adapted into Pluton), the trademark constraints, and the obligations that
would apply if reuse ever happens. It is the canonical place ADR-0011 requires to be extended
before any verbatim or snippet-level adaptation lands.

Audit basis: the three reverse-engineering reports (`cloudroom-core.md`,
`openmausbot-runtime.md`, `openmausbot-mcp-workspaces-tests-licensing.md`), `THIRD_PARTY_NOTICES.md`,
ADR-0011, and read-only inspection. No reference file was modified; no reference code was executed.

## 1. License summary

| Project | Root license | License file path | Commit SHA (studied pin) | Date recorded |
|---|---|---|---|---|
| cloudroom-core | Apache-2.0 (`Cargo.toml:6` declares `license = "Apache-2.0"`; `LICENSE` is the Apache License 2.0 text; no other license file exists) — `cloudroom-core.md` §1 | `LICENSE` | `3949daaea3c7613458e9ad14afddbd267a0a56bc` | Commit date `Wed Oct 14 20:42:19 2026 -0700` (report §1); the reports do not record a wall-clock clone timestamp — `docs/ROADMAP.md` Phase 1 lists the same date |
| OpenMausBot | Apache-2.0 with a source-available `enterprise/` carve-out (`LICENSE` header; `package.json:15` declares `"license": "Apache-2.0"`; `NOTICE:1-2` names the holder) — `openmausbot-runtime.md` §1 | `LICENSE` (+ `NOTICE`, `LICENSING.md`) | `7d008053cbdb255c2078fbf772630e634000dce5` | Commit date `2026-10-15 22:51:16 +0530` (merge of PR #2927, release 0.1.112) — `openmausbot-runtime.md` §1; clone timestamp not recorded |

Notes:

- **cloudroom-core** is the published subset of a larger private product: one shipped ADR while
  code/docs cite ADR numbers up to ≥0237, `docs/database/*.sql` unused by `src/` — `cloudroom-core.md`
  §1. Licensing a snapshot as Apache-2.0 is the repo's own act; the private side is out of scope.
- **OpenMausBot `LICENSE` quirk:** the file is the unmodified Apache text whose appendix still
  contains the boilerplate `Copyright [yyyy] [name of copyright owner]`; the holder is named in
  `NOTICE:1-2` ("OpenMausBot / Copyright 2026 Milind Soni and OpenMausBot contributors") and
  `README.md:486` — `openmausbot-mcp-workspaces-tests-licensing.md` §10.1. Treat `NOTICE` as the
  authoritative attribution source, not the license appendix.
- **Relicensing record:** `NOTICE:4-6` records a relicensing from MIT to Apache-2.0 "with the
  consent of all contributors whose copyright was incorporated before the transition"
  (`openmausbot-mcp-workspaces-tests-licensing.md` §10.1).
- For contrast, **Pluton-Harness's own license is deliberately undecided**: repository private,
  `license: "UNLICENSED"` in `package.json`, owner decision recorded in ADR-0011; it does not
  affect the obligations below (those attach to reference code if reused, regardless of Pluton's
  outbound license).

## 2. Component-level notes

### 2.1 cloudroom-core

- Single license throughout; the report records no third-party bundles, vendored licences or
  carve-outs in the public tree (`cloudroom-core.md` §§1, 3).
- License finding recorded by the report: Apache-2.0 permits reuse and adaptation **with
  attribution** — "any code copied into Pluton must retain the license text/notices, and modified
  files must be marked as changed" (`cloudroom-core.md` §13).
- The repo distinguishes private-product material (missing ADRs, database SQL, control plane) from
  the shipped core; nothing in the public subset changes the Apache-2.0 grant covering what is
  present.

### 2.2 OpenMausBot `enterprise/` carve-out (off-limits)

Per `LICENSING.md:6-23` and `enterprise/LICENSE:1-32` (`openmausbot-mcp-workspaces-tests-licensing.md`
§§10.2–10.3):

- Everything under `enterprise/` is source-available under the "OpenMausBot Enterprise License",
  not open source: reading, building, evaluating and modification-for-evaluation are free;
- **production use requires a valid license key** issued per organization under a separate
  agreement; **no** redistribution, sublicensing, selling, or hosting for third parties, and the
  license check may not be removed, disabled or circumvented;
- deleting `enterprise/` yields the OSS edition (server reports `{"edition":"oss"}`);
- entitlement ids observed: `whitelabel`, `sso` (planned), `admin`, `budgets`, `billing`; offline
  Ed25519 verification via `OMB_LICENSE_KEY` — `openmausbot-mcp-workspaces-tests-licensing.md` §9.
- **Verdict:** `enterprise/` is off-limits for Pluton. Reading it for architectural ideas is
  permitted; copying any of it is not, and the anti-circumvention clause forbids copying the code
  minus the license check (`openmausbot-mcp-workspaces-tests-licensing.md` §10.3, [Verified +
  Inferred]).
- `CLA.md` applies only to `enterprise/` contributions; anything contributed upstream should target
  the Apache side, where no CLA/DCO is required (`openmausbot-mcp-workspaces-tests-licensing.md`
  §§10.2, 10.4).

### 2.3 OpenMausBot `third_party/*` components (as recorded by the report)

All rows below are from `openmausbot-mcp-workspaces-tests-licensing.md` §10.5 unless noted.

| Component | License | Where recorded | Notes |
|---|---|---|---|
| T3 Code (Antigravity ACP adaptation; approval-mode model credit) | MIT © 2026 T3 Tools Inc. | `third_party/t3-code/LICENSE`; `server/drivers/antigravity-temp.ts:1-4` | the approval-level model is credited to T3 Code's permission modes (`docs/approval-levels.md:253-258`) |
| Cache Tax (prompt-cache keep-warm) | MIT © 2026 Karan Bansal | `third_party/cache-tax/LICENSE`; `server/cache-keepwarm.ts:1` | design port, attributed in-file |
| hpke-js (`@hpke/core`, `@hpke/common`) | MIT © 2023-2024 Ajitomi Daisuke | `third_party/hpke-js/*` | phone credential transport |
| models.dev data | MIT © 2025 models.dev | `third_party/models-dev/LICENSE` | provider/model catalog data |
| OpenCode `models-dev.ts` adaptation | MIT © 2025 opencode | `third_party/opencode/LICENSE`; README pins commit `2fa3363c…` | keeps the copyright line in `server/model-catalog/catalog.ts:6`; a test asserts the built catalog still contains it (`catalog.test.ts:115`) |
| playwright-injected (aria snapshot/distiller) | Apache-2.0 | `third_party/playwright-injected/LICENSE`, `UPSTREAM_COMMIT` pinned | copied upstream files with provenance |
| agent-browser (bundled bot browser) | Apache-2.0, plus **axe-core MPL-2.0** for bundled axe files | `third_party/browser/agent-browser-LICENSE.txt`, `LICENSE-axe-core*.txt`, `README.md` | Windows artifact is a **vendor build `0.36.0-omb.1`**, not an official Vercel binary; patch + build script checked in, digests recorded |
| cua-driver 0.19.3 + cursor theme + Inter font | MIT © 2025 Cua AI, Inc.; **OFL-1.1** for Inter | `third_party/cua-driver/{LICENSE.md,Inter-OFL-1.1.txt,SBOM.cdx.json,THIRD_PARTY_NOTICES.md,…}` | upstream release omitted license/SBOM; preserved here with SHA-256 provenance |
| 1Password SDK | MIT © 2024 1Password | `third_party/onepassword-sdk/LICENSE` | |
| Simple Icons / Lobe Icons | CC0-1.0 / MIT © 2023 LobeHub | `third_party/provider-icons/` | icon paths only |
| noVNC 1.7.0 (desktop viewer) | **MPL-2.0** + accompanying licences, modified-file disclosure | `NOTICE:40-43`, `public/novnc-NOTICE.txt` | bundled **unmodified**, so MPL's source-availability obligation is satisfied as recorded |
| WebRTC (Android/iOS bindings) | BSD-3-Clause | `NOTICE:23-27`, `NOTICE:44-47` | companion apps only |
| cloudflared 2026.8.2 | not restated in-repo; only release provenance + SHA-256 digests | `third_party/cloudflared/README.md` | upstream Apache-2.0 presumed — **[Inferred from upstream, not verified in-repo]** |
| Whop assets | Apache-2.0 text present | `src/assets/whop/LICENSE.txt` | **[Unknown]** which components this covers |

Additional recorded facts: third-party skills carry per-file attribution comments, e.g.
`server/skill-review.ts:2,155` credits Nous Research code under MIT with a "changed for
OpenMausBot" note (`openmausbot-mcp-workspaces-tests-licensing.md` §10.5). The repo's convention is
per-file attribution at the top of adapted files (verified in 5 places).

Ambiguities the report flags (do not silently resolve them): the unfilled license appendix;
`third_party/cloudflared/README.md` restating digests but not the license text; `apps/docs` having
no license field; the Windows agent-browser vendor build not being an unmodified upstream binary;
and the third-party boundary being enforced socially (comments + NOTICE) rather than by SBOM
tooling inside the repo — the CI license-report job referenced at `README.md:374` was not inspected
(`openmausbot-mcp-workspaces-tests-licensing.md` §10.6).

### 2.4 Per-directory verdict for Pluton (from the report)

| Area | Status | Can Pluton learn/adapt? |
|---|---|---|
| OpenMausBot `server/` (except the enterprise hook), `shared/`, `scripts/` | Apache-2.0 | Yes, with NOTICE/attribution; per-file MIT/Nous attributions preserved where present |
| `docs/`, `evals/`, `docs/verification/` (102 recipes) | Apache-2.0 | Yes; architecture descriptions are reusable prose |
| `src/` renderer, `electron/`, `companion/`, `apps/docs` | Apache-2.0 ([Inferred] for `apps/docs`, no license field) | Yes, but out of scope for a CLI product |
| `third_party/*` | Per directory (MIT / Apache-2.0 / MPL-2.0 / OFL / CC0) | Copy the *records*; copying a bundled binary re-imposes its own license and provenance obligations |
| `enterprise/` | OpenMausBot Enterprise License — source-available | **No code reuse in production**; reading for concepts only |
| Names/branding/mascot | Trademarked (Supamaus Software Private Limited); Apache §6 grants nothing | No name/mascot reuse; do not copy brand assets as product branding |

## 3. Code reuse register

**As of this audit, NO reference source code has been copied or adapted into Pluton.** The register
is empty.

| Date | Source repo | URL | Commit SHA | File(s) | License | Description of changes |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — none as of 2026-10-16 — |

Basis for the "none" statement:

- ADR-0011 (Accepted): "No reference code is copied in this milestone. Patterns are learned at the
  concept level and re-implemented against Pluton's own contracts."
- `THIRD_PARTY_NOTICES.md` records both references as "None (concept-level study only)" (with the
  further note that OpenMausBot's `enterprise/` was never consulted for implementation).
- The Phase 1 deliverables record re-implementation, not porting; where an idea travelled, the
  receiving code is Pluton's own (e.g. `src/domain/state.ts` implements Pluton's own transition
  table; ADR-0006 specifies Pluton's own receipt design).
- Coarse machine check (read-only, 2026-10-16): a case-insensitive grep for `mausbot|cloudroom|openmaus`
  across `src/**/*.ts` returned no matches. This is a marker-level check, not a similarity scan; it
  detects names, not paraphrased algorithms.

If any snippet or algorithm-level port ever lands, this register must gain one row per item with
URL, commit SHA, original license, the changed files, and a description of the changes — per
ADR-0011. Until a row exists, treat any copied reference code as a defect to be removed, not as
undocumented reuse.

## 4. Trademark / attribution constraints

- **OpenMausBot / MausBot names and the mascot** are trademarks of Supamaus Software Private
  Limited; the Apache License grants no trademark rights (section 6), so a product built on the
  code "needs its own name unless a partner agreement says otherwise"
  (`openmausbot-mcp-workspaces-tests-licensing.md` §10.2; `LICENSING.md:41-49`). The mascot is a
  product asset (`mascot-preview.html` at repo root), not source.
- **Do not copy brand assets as branding**: `brand.json` shapes, icons, the MCP server name string
  `openmausbot-mcp`, and similar product identifiers are names/assets, not code to reuse
  (`openmausbot-mcp-workspaces-tests-licensing.md` §§3.2, 10.6).
- **cloudroom-core:** the report records no trademark policy for the name "Cloudroom"; the safe
  position is the same — no name reuse, and keep the non-affiliation statements already in
  `THIRD_PARTY_NOTICES.md:3-6` and `README.md`.
- **OpenCode:** consumed as an external engine via its documented CLI protocols; not bundled and
  not modified (`THIRD_PARTY_NOTICES.md:33-35`).
- **Idea credits:** where Pluton borrows a named pattern whose credit travels with it in the
  source repo (e.g. T3 Code's permission-mode model, Cache Tax's keep-warm design, Nous Research
  skill code), carry the attribution note if any code travels; ideas alone need no license but
  crediting costs nothing (`openmausbot-mcp-workspaces-tests-licensing.md` §10.5).
- Pluton-Harness must continue to state non-affiliation with Cloudroom, OpenMausBot and OpenCode
  in README and notices.

## 5. Obligations if reuse ever happens (intake checklist)

1. **Extend this register first** with: source URL, commit SHA, original license, file paths,
   description of changes made (`ADR-0011`).
2. **Apache-2.0 obligations** (both references are Apache-2.0 for the reusable surface): include a
   copy of the license text; propagate `NOTICE` content where the source repo has one — for
   OpenMausBot that means `NOTICE:1-2` attribution ("OpenMausBot / Copyright 2026 Milind Soni and
   OpenMausBot contributors"); mark modified files as changed; preserve per-file copyright lines
   where they exist (the OpenCode `models-dev.ts` adaptation's kept copyright line plus a
   contains-check test is the model to imitate); §5 covers automatic contribution of any upstream
   PR Pluton sends; §6 grants no trademark rights.
3. **License compatibility:** MIT / ISC / Apache-2.0 / BSD-3-Clause / CC0 / OFL content is
   compatible with attribution. **MPL-2.0 is file-level copyleft**: noVNC is bundled unmodified
   today, so if Pluton ever bundles it (or an MPL file such as axe-core) *modified*, Pluton must
   publish the modified files. Anything from `enterprise/` is never compatible: production use
   requires a paid key and the license forbids redistribution and license-check circumvention.
4. **Contribution rule:** do not contribute to OpenMausBot's `enterprise/` (CLA required, and the
   license is not open source); upstream contributions, if any, target the Apache-2.0 side
   (`openmausbot-mcp-workspaces-tests-licensing.md` §10.4).
5. **Update notices:** `THIRD_PARTY_NOTICES.md` lists runtime/dev dependencies and their licenses
   and is updated when dependencies change (ADR-0011); adapt the policy so reference-derived code
   appears both there and in this register.
6. **Author Pluton's own tests and fixtures** rather than copying reference fixtures wholesale;
   both reference repos' fixtures are protocol-accurate and tempting, but they carry their own
   attribution/redaction expectations and embed vendor protocol texts.

## 6. Link to THIRD_PARTY_NOTICES.md

[`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) is the canonical dependency-notice
file. Its current content, as of 2026-10-16:

- Runtime dependencies: `commander` 15.0.0 (MIT), `zod` 4.6.7 (MIT), `yaml` 2.9.1 (ISC).
  Development: `typescript` 7.0.2 (Apache-2.0), `vitest` 5.0.5 (MIT), `@types/node` 26.6.5 (MIT).
  `node:sqlite` is a Node.js runtime module (MIT-licensed project), not a bundled dependency.
- Reference repositories: davidondrej/cloudroom-core @ `3949daae…`, Apache-2.0, reuse "None
  (concept-level study only)"; milind-soni/OpenMausBot @ `7d00805…`, Apache-2.0 except `enterprise/`
  (source-available; production requires a license key), reuse "None (concept-level study only);
  `enterprise/` never consulted for implementation".
- Trademarks: OpenMausBot/MausBot names and mascot belong to their owner; Pluton does not use them.
- Pluton-Harness's own license: undecided, private, `UNLICENSED` — an explicit owner decision in
  ADR-0011.

This audit and `THIRD_PARTY_NOTICES.md` must stay consistent: any row added to the register in
section 3 implies an update there if the reused material is redistributed with Pluton. For the
current milestone no such update is required because the register is empty.
