# ADR — Provider Adapters and OpenAI-Compatible HTTP Protocol (PLUTON 4.1 Phase 1)

- Status: **Accepted** (2026-11-02)
- Context: PLUTON 4.1 Phase 1 upgrade on `main`
- Supersedes / Extends: Extends [ADR-0003](./0003-engine-adapter-protocol.md) (Engine adapter protocol) and [ADR-0008](./0008-model-auth-secret-storage.md) (Secret storage).

## Context

Pluton previously supported a single real engine (`opencode` via ACP over stdio). The legacy secondary engine (`qwen`) was removed during the OpenCode migration. To satisfy the PLUTON 4.1 architecture specification, Pluton requires a true multi-engine adapter protocol that supports:
1. Heterogeneous model providers without relying on proprietary or abandoned vendor CLIs.
2. Direct HTTP/SSE communication with standard OpenAI-compatible endpoints (Ollama, vLLM, DeepSeek, OpenAI, Groq, LiteLLM, Cloudflare AI Gateway, etc.).
3. Native execution tool bridge access without running arbitrary third-party CLI binaries inside the sandbox.
4. Strict credential isolation that stores API keys per-provider in filesystem homes with minimal permissions (0600 on POSIX, current-user/SYSTEM/Administrators SID ACLs on Windows).

## Decisions

### 1. OpenAI-Compatible HTTP Engine (`openai-compatible`)

We implement an `openai-compatible` engine adapter speaking standard REST and Server-Sent Events (SSE):
- Endpoint defaults: `/models` for model catalog discovery and `/chat/completions` for streaming inference.
- Streaming: Standard `data: {...}` SSE streams with text deltas, `reasoning_content` (thought deltas), and `tool_calls` delta reconstruction.
- Fallback: Non-streaming JSON responses parsed gracefully if the server does not support SSE.
- Native `fetch`: Zero external HTTP client dependencies, relying exclusively on Node 24+ native `fetch` and standard web streams.

### 2. MCP HTTP Tool Bridge (`McpHttpClient`)

Unlike stdio-based CLI engines that execute tools via local child processes, the HTTP engine connects back to Pluton's native tool bridge via HTTP MCP:
- JSON-RPC 2.0 transport over HTTP POST.
- Supports `tools/list` and `tools/call`.
- Replaces local process spawning with in-session network calls to the host-concurred tool server.

### 3. Non-Process Engine Substrate Seam (`EngineFactory.spawnsProcess`)

The native execution engine sandbox (`nativeAdapterFor`) historically assumed that all engine adapters spawn a child process (`spawnsProcess: true`). For HTTP adapters:
- `EngineFactory` registers `spawnsProcess: false`.
- `nativeAdapterFor` detects `spawnsProcess === false` and returns the engine adapter directly, avoiding unnecessary sandbox child process allocation while routing tool calls through the HTTP MCP bridge.

### 4. Per-Provider Metadata and Credential Store

- **Registry (`.pluton/providers.json`)**: Stores provider id, engine kind (`openai-compatible`), human display name, `base_url`, `auth` configuration (`bearer` or `header`), custom paths, extra headers, and timeout. This file contains no secret keys and can be inspected safely.
- **Credential Storage (`.pluton/provider-homes/<id>/credential.json`)**: Stores `{ version: 1, api_key: "..." }`. Stored with mode `0600` on POSIX. On Windows, inheritance is stripped (`icacls /inheritance:r`) and explicit access is granted exclusively to the current user SID, SYSTEM SID, and Administrators SID.
- **Standard Input Only**: API keys are accepted exclusively via standard input (`pluton provider key <id>`), never via CLI flags or arguments, preventing process table (`ps`/Task Manager) leakage.
- **Redaction**: API keys are scrubbed and masked from log streams, SSE events, CLI output, and error messages.

### 5. Ship Configuration Schema

The `ShipConfig` schema gains an optional `provider` field (`ships.<id>.provider`).
- When a Ship specifies `provider: <id>`, the engine adapter resolves credentials and endpoint configuration for that provider.
- If omitted for an engine with exactly one configured provider, that provider is selected automatically.
- If multiple providers exist for the engine and no provider is specified on the Ship, configuration fails explicitly with `ConfigError` (Phase 3 multi-provider routing seam).
- No SQLite schema migration is required; Ship configuration is held in `pluton.yaml` and resolved at execution boundaries.

## Consequences

- Pluton now supports any OpenAI-compatible API without installing foreign CLI packages.
- Tool calling is fully supported through Pluton's native MCP server without compromising sandbox boundaries.
- No secrets are stored in `pluton.yaml` or SQLite.
- Fully verified via offline mock fixtures and live conformance test suites.
