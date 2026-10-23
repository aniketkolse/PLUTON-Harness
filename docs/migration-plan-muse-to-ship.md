# Muse-to-Ship Migration Plan

## Classification of Changes

### A. Code identifiers (rename-in-place — no compat needed)
- Type names: `MuseRecord`→`ShipRecord`, `MuseConfig`→`ShipConfig`, `MuseRole`→`ShipRole`, `MuseSyncSpec`→`ShipSyncSpec`, etc.
- Variables: `museId`→`shipId`, `museSlug`→`shipSlug`, etc.
- Functions: `listMuses`→`listShips`, `getMuse`→`getShip`, etc.
- Constants: `MUSE_ROLES`→`SHIP_ROLES`, `MUSE_ID_RE`→`SHIP_ID_RE`

### B. Backward-compatible (aliases + deprecation)
- **Config key**: `muses` → `ships` (accept `muses` alias)
- **Config runtime limits**: `max_muse_input_tokens` → `max_ship_input_tokens` (alias)
- **Event types**: `muse.create` → `ship.create` (emit new, accept both)
- **Tool permission**: `muse.propose_create` → `ship.propose_create` (accept both)
- **API fields**: `museId` → `shipId` in JSON (accept both)
- **CLI command**: `pluton muse` → `pluton ship` (alias `muse` → `ship`)
- **Engine contract**: `StartSessionRequest.muse` → `.ship` (accept both)

### C. DB schema migration (v8)
- Rename table `muses` → `ships`
- Rename columns: `muse_id` → `ship_id`, `manager_muse_id` → `manager_ship_id`, `assignee_muse_id` → `assignee_ship_id`, `requested_by_muse_id` → `requested_by_ship_id`
- Keep old column reads as fallback in row mappers

### D. Historical references (keep as-is or annotate)
- docs/ referencing the pre-Ships era or ADRs that describe history
- Git history (not touched)

## Execution Order
1. domain/models.ts, domain/permissions.ts
2. config/schema.ts, config/load.ts
3. store/migrations.ts, store/store.ts
4. engines/approval.ts, engines/contract/types.ts
5. execution/factory.ts, execution/native.ts
6. cli/commands/* (rename muse.ts → ship.ts)
7. chat/*, tools/*, server/routes.ts
8. tui/*, ui/*
9. sandbox/*
10. templates/*
11. tests/*
12. docs/*
13. Verify: typecheck, build, tests, release-check, case-insensitive audit
