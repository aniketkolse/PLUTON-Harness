# Qwen Code ACP recorded frames

Source: live probes of `qwen --acp` (**Qwen Code v0.25.2**, `@qwen-code/qwen-code@0.25.2`)
run on 2026-10-16 on the build host, driving an OpenAI-compatible endpoint (a local
9router gateway; see `docs/adr/0003-engine-adapter-protocol.md` addendum).

Probe transcripts (build session, gitignored): `.pluton-tmp/qwen-acp-probe.log`,
`.pluton-tmp/qwen-acp-probe2.log`, `.pluton-tmp/qwen-noauth-probe.log`.

## Trimming rules applied when extracting this fixture

- `initializeResult`: the live response carries a large bundled skills catalog under
  `agentCapabilities._meta`; it is dropped (`_trimNote` records this). `agentInfo`,
  `loadSession`, `promptCapabilities`, `sessionCapabilities` (`{list:{}, resume:{}}` —
  note: no `close`) and `mcpCapabilities` are verbatim.
- `sessionNew`: verbatim (composite model ids `$runtime|openai|…`, `modes` starting at
  `auto`, `configOptions` for `mode` and `model`).
- `setModeResult` / `setModelResult`: verbatim `set_config_option` responses.
- `permissionRequest`: verbatim `session/request_permission` params (edit approval),
  session id normalized.
- `promptUpdates`: one real frame per kind from probe 1's full-frame log
  (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`,
  `usage_update`, `available_commands_update` — commands list trimmed to one entry).
- `promptResult`: verbatim result of the "write under mode=default" prompt.
- `cancelResult`: verbatim (`stopReason: "cancelled"`) from probe 1.
- `loadResult`: verbatim `session/load` result (`modes`, `models`, `configOptions`, `_meta`).
- `sessionList`: `session/list` result with session metadata trimmed for size.
- `authError`: verbatim unauthenticated `session/new` failure (code -32000,
  `data.authMethods[openai]`) from the no-auth probe.

Session ids in `sessionNew`/`promptUpdates` are the real ones from the probe run; this
fixture contains no credentials.
