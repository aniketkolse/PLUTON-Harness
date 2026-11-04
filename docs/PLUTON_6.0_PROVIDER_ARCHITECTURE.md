# PLUTON 6.0: Universal Provider-Agnostic AI Execution Architecture

## 1. Overview & Architectural Principles

PLUTON 6.0 transforms PLUTON from an engine-coupled runner into an extensible, provider-agnostic multi-agent execution orchestrator. OpenCode is treated as an optional integration rather than a mandatory execution layer. Any OpenAI-compatible, Anthropic, Google, or custom HTTP endpoint can be configured as a first-class AI provider connection.

### Core Architectural Pillars
1. **Optional Integration**: OpenCode is strictly optional. PLUTON can run with zero OpenCode dependencies or installations.
2. **Strict Multi-Connection Isolation**: Multiple connections to the same provider (e.g. `openrouter-dev` and `openrouter-prod`) have completely separate configurations, credentials (0600 permissions), rate limits, and health states.
3. **Composite Model Identity**: Models are identified globally by `(connectionId, modelId)`. Provider model IDs are never flattened or misinterpreted.
4. **Shared PLUTON Coding Tool Runtime**: A native PLUTON tool host exposes `file.write`, `file.edit`, `file.search`, and `command.exec` to all connected models, guaranteeing consistent workspace boundary enforcement, path confinement, and lease locking.
5. **Mixed-Provider Ship Teams**: A single Ship run can coordinate teams with different providers (e.g., manager on mock/local, coder on Anthropic, reviewer on OpenAI) without cross-engine contamination.

---

## 2. System Architecture & Routing Flow

```
                     ┌──────────────────────────────────────────────┐
                     │           User / CLI / Web SPA               │
                     └──────────────────────┬───────────────────────┘
                                            │
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │          Execution Router (Router)           │
                     │   Resolves Composite (connId, modelId)       │
                     └──────┬───────────────────────┬───────────────┘
                            │                       │
           Built-in / Mock  │                       │ HTTP Connection (OpenAI-compatible)
                            ▼                       ▼
            ┌───────────────────────┐       ┌───────────────────────────────┐
            │ Mock / Builtin Engine │       │   Routed HTTP Engine Adapter  │
            └───────────────────────┘       └───────────────┬───────────────┘
                                                            │
                                                            ▼
                                            ┌───────────────────────────────┐
                                            │    PLUTON Tool Host Bridge    │
                                            │   file.write / file.edit      │
                                            │   file.search / command.exec  │
                                            │   Enforces Workspace Boundary │
                                            └───────────────────────────────┘
```

---

## 3. Data Modeling & Storage Isolation

### 3.1 Connection Configuration (`.pluton/connections.json`)
Connections are stored in project-local storage with mode 0600:

```json
{
  "version": 1,
  "connections": {
    "openrouter-prod": {
      "id": "openrouter-prod",
      "providerId": "openrouter",
      "displayName": "OpenRouter Production",
      "baseUrl": "https://openrouter.ai/api/v1",
      "protocol": "openai-compatible",
      "auth": {
        "style": "bearer"
      },
      "customHeaders": {
        "HTTP-Referer": "https://pluton.dev"
      }
    }
  }
}
```

### 3.2 Private Credential Isolation
API keys and secrets are stored in strictly isolated subdirectories under `.pluton/provider-homes/<connectionId>/credential` with mode 0600. Credentials are never written into `pluton.yaml`, never serialized into REST API responses, and never logged.

### 3.3 SSRF & URL Security Validation
All connection base URLs undergo strict SSRF validation via `validateEndpointUrl`:
- Restricts protocols to `http:` and `https:`.
- Enforces `https:` for all remote targets; plain `http:` is permitted only on loopback (`127.0.0.1`, `localhost`).
- Rejects cloud metadata addresses (e.g., `169.254.169.254`) and link-local ranges.
- Prohibits embedded basic-auth credentials in URLs.

---

## 4. Composite Model Resolution & Syntax

### 4.1 Resolution Priority
When resolving a model name:
1. **Explicit Colon Syntax**: `<connection-id>:<model-id>` routes directly to the specified connection and strips the connection prefix for the upstream provider.
2. **Provider Slash Prefix**: If matching an approved connection ID, routes to that connection.
3. **Ship-Assigned Provider**: Inherited from the ship's configuration or SQLite record.
4. **Built-in Engine**: Explicit `mock/` or `opencode/` prefixes map to their respective local engines.

Multi-segment model names (e.g. `anthropic/claude-3.5-sonnet:beta`) preserve slashes and colons within the model ID segment.

---

## 5. Model Registry & User-Declared Capabilities

Models are indexed in `ModelRegistry` by composite key `(connectionId, modelId)`.
For models without live listing or on static providers, users can declare capabilities via manual model registration:

```json
{
  "connectionId": "openrouter-prod",
  "modelId": "nvidia/nemotron-4-340b",
  "displayName": "Nemotron 340B",
  "capabilities": {
    "toolCalling": true,
    "contextWindow": 128000,
    "coding": true,
    "reasoning": true
  }
}
```

Durable manual model declarations are stored in `.pluton/manual-models.json`.

---

## 6. Connection-Scoped Health, Quotas & Route-Aware Fallback

### 6.1 Isolated Failure Categorization
`ModelHealthMonitor` isolates health status by connection ID:
- A rate limit (`429`) on `openrouter-dev` does not trigger cooldown on `openrouter-prod`.
- Network errors (`ECONNREFUSED`) mark only the affected connection as unavailable.

### 6.2 Supervisor Route Re-Resolution
When a model encounters a failure during execution:
1. Supervisor records failure scoped to `(connectionId, modelId)`.
2. Fallback selector finds alternative eligible models from healthy connections.
3. Supervisor calls `resolveExecutionRoute` for the fallback model and updates the active session adapter.

---

## 7. Shared PLUTON Coding Tool Runtime

The native tool host provides uniform coding primitives across all models:
- `file.write`: Atomically writes files inside the workspace root.
- `file.edit`: Performs exact single or multiple string replacements.
- `file.search`: Searches workspace file contents with regex.
- `command.exec`: Executes shell commands bounded by timeout and workspace directory confinement.

All file operations enforce path confinement (preventing traversal outside the workspace or project root) and file lease checks.

## 8. Workspace Policy: `direct-write` vs `isolated-task-checkout`

PLUTON defaults new projects to `workspace_policy: direct-write`: model sessions work in the project directory itself (like Cursor, Claude Code, Codex and OpenCode) and all Ships see the same file tree. Write leases still serialize conflicting edits, and per-worker `worktree` isolation remains available as opt-in via `isolated-task-checkout`.

## 9. Team Collaboration Protocol

Collaboration between Ships defaults to a shared protocol described in [PLUTON_TEAM_COLLABORATION.md](./PLUTON_TEAM_COLLABORATION.md): shared specs (`spec.read`/`spec.write`), file claims (`file.claim`/`file.release`), team-wide announcements (`team.broadcast`) and durable peer messaging (`ship.message`/`ship.inbox`). All events land in the run's durable event log and appear in the SPA activity feed and worker inspector.

