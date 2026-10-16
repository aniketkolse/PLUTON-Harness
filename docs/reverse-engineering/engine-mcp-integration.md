# Engine MCP integration — how OpenCode and Qwen Code can be given Pluton-controlled MCP tools

Status: Phase 6 planning input. Written 2026-10-16 on the Pluton host (Windows, `win32`).
Owner question: Pluton's Phase 6 manager flow needs the manager engine session to call **restricted Pluton tools** (`task.create`, `result.collect`, `muse.propose_create`, …) through an MCP server that Pluton controls and authorizes per call. This doc records how each supported engine can be wired to such a server, what is verified by live test, and what remains open.

Evidence labels used throughout:

| Label | Meaning |
| --- | --- |
| **(verified)** | Reproduced live on this host against a throwaway stub, or read from the installed binary/bundle on this host. Command or file cited. |
| **(inferred)** | Follows from verified facts or official docs but was not executed here. |
| **(unknown)** | Not determined; listed in the Phase 6 test list if it matters. |

All live tests used a disposable probe workspace: `C:\Users\Asus\AppData\Local\Temp\opencode\pluton-mcp-probe\` (stub MCP stdio server `stub-mcp-server.js`, stub streamable-HTTP server `stub-mcp-http-server.js`, fake OpenAI-compatible endpoint `fake-openai-server.js`, plus per-engine test projects). Nothing under `Y:\Pluton` or the user's real configs was modified; the user's OpenCode config was only read via `opencode debug config` (structure inspected, secrets not printed). Probe processes were stopped after testing.

Versions on this host:

- `opencode --version` → **v2.0.30** (the MCP handshake reports clientInfo `opencode/2.0.31` — minor skew between shim and server, both observed live).
- `node Y:\Pluton\.pluton-tmp\engines\qwen-prefix\node_modules\@qwen-code\qwen-code\cli-entry.js --version` → **0.25.2** (qwen is not on PATH; all qwen probes invoked `cli-entry.js` via `node`).

---

## 1. OpenCode

### 1.1 Config location(s)

| Location | What | Evidence |
| --- | --- | --- |
| `%USERPROFILE%\.config\opencode\opencode.json`, `opencode.jsonc` | global user config | **verified**: `opencode debug paths` → `config C:\Users\Asus\.config\opencode`; `opencode debug config` lists both files as document sources |
| `<project>/opencode.json` (cwd) | project config | **verified**: `opencode debug config` run in the probe project lists `…\ocproj\opencode.json` as a document source, and `opencode mcp list` picks servers from it |
| `opencode mcp add … --global` writes the global file; without the flag it writes the project file | writer behavior | **verified**: `opencode mcp add added_probe -- node …` wrote `ocscratch\opencode.json` |

### 1.2 Schema (v2)

OpenCode v2 nests servers under **`mcp.servers`**. The older flat shape from the v1 docs page (`"mcp": { "<name>": {…} }`) is **not read by v2.0.30** — **verified**: a flat-shape project config produced `opencode mcp list` → `No MCP servers configured`; rewriting the same project to `mcp.servers` produced `✓ pluton_probe  connected`. The v2 docs state it explicitly: “V2 does not place server names directly under `mcp`.”

Exact file written by `opencode mcp add` on this host — **verified** (`ocscratch\opencode.json`, verbatim):

```json
{
  "mcp": {
    "servers": {
      "added_probe": {
        "type": "local",
        "command": [
          "node",
          "C:/Users/Asus/AppData/Local/Temp/opencode/pluton-mcp-probe/stub-mcp-server.js"
        ]
      }
    }
  }
}
```

Local server fields (docs v2, https://opencode.ai/v2/docs/mcp-servers):

```jsonc
{
  "mcp": {
    "servers": {
      "my-server": {
        "type": "local",                    // required
        "command": ["npx", "-y", "example-mcp-server"], // required
        "cwd": ".",                          // optional, relative to workspace
        "environment": { "MCP_API_KEY": "{env:MCP_API_KEY}" }, // optional
        "disabled": true,                    // optional; note: v2 uses disabled, NOT enabled
        "codemode": false,                   // optional, default true (see 1.4)
        "timeout": { "catalog": 60000 },     // optional per-server override
        "protocol": "legacy"                 // optional: legacy | auto | 2026-07-28
      }
    }
  }
}
```

Remote server fields (streamable HTTP, absolute URL required):

```jsonc
{
  "mcp": {
    "servers": {
      "pluton": {
        "type": "remote",
        "url": "http://host.docker.internal:PORT/mcp",
        "headers": { "Authorization": "Bearer {env:PLUTON_MCP_TOKEN}" },
        "oauth": false,                      // object for pre-registered clients, or false
        "disabled": false,
        "codemode": false,
        "timeout": { "execution": 600000 }
      }
    }
  },
  "mcp": {
    "timeout": { "startup": 45000, "catalog": 30000, "execution": 600000 }
  }
}
```

(One real `mcp` object; shown split only for readability. Timeout defaults from docs: `startup` 30 s, `catalog` 30 s, `execution` 12 h. `{env:NAME}` substitution applies to `environment` values and `headers` values; shell-style `$NAME` is not expanded — docs.)

OAuth: enabled by default for remote servers; disable with `"oauth": false` for static bearer tokens. Pre-registered client fields are **snake_case in v2** (`client_id`, `client_secret`, `scope`, `callback_port`, `redirect_uri`, `auth_server_metadata_url`); v2 tries pre-registered → CIMD → RFC 7591 DCR. Manage with `opencode mcp auth [name]`, `opencode mcp logout [name]`; interactively `/mcps`. Credentials are stored outside project configuration (v1 docs named `~/.local/share/opencode/mcp-auth.json`; v2 docs say only “outside project configuration”). **(docs)**; not exercised here.

### 1.3 CLI surface for MCP

- `opencode mcp list` — lists servers with connection state. **verified**: `✓ pluton_probe connected`, `✓ pluton_probe_http connected` (stdio and streamable-HTTP stubs).
- `opencode mcp add [flags] <name> [<command...>]` — flags `--url`, `--header key=value`, `--env key=value`, `--global`. **verified** (`opencode mcp add --help`, plus a live write).
- `opencode mcp auth`, `opencode mcp logout` exist in help; the docs also mention `opencode mcp auth list` and `opencode mcp debug <name>`, which were **not** exercised.
- Headless mode: `opencode run [--auto] [--format default|json] -m provider/model "message"` — **verified** live (see 1.4/1.5).

### 1.4 Tool naming and exposure to the model

v2 docs: a tool is exposed as `<server>_<tool>`, with every character outside `[A-Za-z0-9_-]` replaced by `_`; prompts become commands `<server>:<prompt>`.

Live capture from the probe (`fake-openai-server.js` log, `opencode run --auto -m probe/fake-model …` with `codemode: false`):

- request `tools` array contained `pluton_probe_pluton_probe_ping` (stdio server `pluton_probe`) and `pluton_probe_http_pluton_probe_ping` (remote server `pluton_probe_http`) — **verified**. The model invoked `pluton_probe_http_pluton_probe_ping`; OpenCode executed it and the next request carried the tool result `PROBE_HTTP_RESULT {"value":"42"}` — **verified end-to-end** for the remote/HTTP transport. The stdio server was live-verified to connection + `tools/list` (see 1.6); a stdio **call** through OpenCode was not executed (the fake model picked the HTTP tool from the list).
- **Code Mode is the default (`codemode: true`)** and changes what the model sees. With default config, the captured request `tools` array was `edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write, execute` — **no MCP tools at all**; the docs say MCP tools are grouped by normalized server name and reached through Code Mode (`tools.context_7.resolve_library_id(...)`). For a Pluton restricted-tool catalog, `"codemode": false` produces plain per-tool entries and is the easier surface to allow/deny — **verified** by the two captured runs differing only in that flag.
- On the wire, the MCP `tools/call` uses the **bare** tool name: HTTP stub log shows `params.name = "pluton_probe_ping"` — **verified**.
- Every call carries `params._meta["ai.opencode/sessionID"] = "ses_…"` (streamable HTTP body captured) — **verified**; the docs note this is correlation metadata, explicitly **not** authentication (“Do not use it by itself for authentication or authorization”).
- Server `instructions` from `initialize` are injected into the system prompt as `<mcp_instructions>` — **(docs)**.
- Elicitation (`input requests`) supported — **(docs)**; the captured OpenCode `initialize` advertises `capabilities: { elicitation: { form: {}, url: {} }, roots: {} }` — **verified** from the stdio stub log.

### 1.5 Permission / approval gates

- v2 uses a `permissions` array with `{action, resource, effect}` entries; match the normalized `<server>_<tool>` name, e.g. `{"action": "context7_*", "resource": "*", "effect": "deny"}` — **(docs)**.
- MCP resources are read via built-in tools `list_mcp_resources` / `read_mcp_resource`, gated by `opencode_list_mcp_resources` / `opencode_read_mcp_resource` actions — **(docs)**; not exercised in the probe runs.
- Headless flag `--auto`: “Auto-approve permissions that are not explicitly denied” (`opencode run --help` — **verified** help text). Under `--auto` the probe tool call executed without a prompt — **verified**.
- Docs also show glob-based disabling via a `tools` map (`"my-mcp*": false`) and per-agent tool maps in the v1 page; on v2.0.30 prefer the `permissions` array (v2 docs) — the older form is **(unknown)** in v2 (not tested).
- Judgment for Pluton: engine-side gates are UX. A hidden Code Mode path or an `--auto` host means Pluton must still authorize every call server-side (consistent with R8 / O4 / ADR-0007).

### 1.6 Stdio handshake details (from the stub log, verbatim excerpts)

**verified** — OpenCode stdio client sends, in order:

1. `initialize` with `protocolVersion "2025-11-25"`, `clientInfo {"name":"opencode","version":"2.0.31"}`, capabilities `{elicitation:{form:{},url:{}},roots:{}}`;
2. `notifications/initialized`;
3. `tools/list` (id 1) during connect.

Tool catalogs are fetched at connect time (times listed in `stub-inbound.log`); default protocol mode is `legacy` (classic initialize), with `auto`/`2026-07-28` opt-in per server — **(docs + verified handshake)**.

---

## 2. Qwen Code

### 2.1 Config location(s)

| Location | What | Evidence |
| --- | --- | --- |
| `~/.qwen/settings.json` | user scope (default for `qwen mcp add`) | **verified indirectly**: bundle `Storage.getGlobalQwenDir()` / `getGlobalSettingsPath()` = `<global>\settings.json` (`chunks/chunk-EPODBRBP.js`); docs; and a live `mcp add` with `QWEN_HOME` pointed at a temp dir wrote `<temp>\settings.json` |
| `QWEN_HOME` env var | overrides the global dir (sandboxing/portability hook) | **verified**: `$env:QWEN_HOME="…\qwenscratch"; qwen mcp add probe-http -t http -H "Authorization: Bearer PROBE_TOKEN" http://127.0.0.1:8731/mcp` wrote `qwenscratch\settings.json` |
| `<workspace>/.qwen/settings.json` | project scope | **verified**: bundle constant `SETTINGS_DIRECTORY_NAME=".qwen"` (`chunks/chunk-BU5LEKKO.js`); a probe file at `qwenproj\.qwen\settings.json` was discovered by `qwen mcp list` (shown as *Pending approval*, see 2.4) |
| `--mcp-config <json-or-path>` (root run command only) | per-invocation config, `{"mcpServers": {…}}` | **verified**: headless runs with `--mcp-config <file>` connected both a stdio and an `httpUrl` server. Note: `qwen mcp list --mcp-config …` and `qwen --mcp-config … mcp list` both fail with `Unknown arguments: mcp-config, mcpConfig` — the flag is only accepted by the main run command |

System-level settings layers (system defaults / system settings) exist in the settings loader — **(docs)**; not needed by Pluton.

### 2.2 Schema

`mcpServers` object in `settings.json`. Exact file written by `qwen mcp add` on this host — **verified** (`qwenscratch\settings.json`, verbatim):

```json
{
  "mcpServers": {
    "probe-http": {
      "httpUrl": "http://127.0.0.1:8731/mcp",
      "headers": {
        "Authorization": "Bearer PROBE_TOKEN"
      }
    }
  }
}
```

Transport keys (docs `docs/users/features/mcp.md`, matched by bundle `normalizeClaudeMcpServer` in `chunks/chunk-IFAUFERF.js`):

| Transport | JSON field(s) | Notes |
| --- | --- | --- |
| `http` (Streamable HTTP, recommended) | `httpUrl` (+ `headers`) | a plain `url` alone means legacy SSE — **verified** from the converter code and docs |
| `sse` (legacy/deprecated) | `url` (+ `headers`) | |
| `stdio` | `command`, `args` (+ `cwd`, `env`) | the only case where a process is spawned |

Per-server optional fields (docs reference table, corroborated by `qwen mcp add --help`):

- `timeout` — **tool-call** timeout, default `600000` ms (10 min).
- `discoveryTimeoutMs` — connect + `tools/list`/`prompts/list`/`resources/list` budget; defaults 30 s (stdio) / 5 s (remote).
- `trust` — default `false`; `true` skips tool-call confirmations **in a trusted workspace** and enables connection-loss replay only for calls annotated idempotent/read-only.
- `includeTools` / `excludeTools` — per-server allow/deny; exclude wins.
- `versionNegotiation: "auto" | "legacy"` — modern-only stdio servers.
- `env` values may reference environment variables via `$VAR` or `${VAR}` (docs).
- `oauth` object `{enabled, clientId, clientSecret, authorizationUrl, tokenUrl, redirectUri, scopes, tokenParamName, audiences}` — tokens stored under the global dir (`~/.qwen/mcp-oauth-tokens.json`, plaintext by default; `QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE=true` opts into encrypted storage) — **(docs)**; not exercised, and no token files were read.
- Global policy in the same file: `mcp.allowed` / `mcp.excluded` — glob allow/deny lists of **server names**; `mcp.excluded` wins — **(docs)**.

`qwen mcp add` gotchas (**verified**): flags and command share one argument list — a `--` separator before the command makes it fail with `Not enough non-option arguments: got 1, need at least 2`. Use `qwen mcp add <name> -t stdio --timeout 9000 node C:/path/server.js`. Scope flag: `-s user` (default) / `-s project`.

### 2.3 CLI surface for MCP

`qwen mcp {add, remove, list, reconnect, approve, reject}` — **verified** (`mcp --help`). `qwen mcp list` prints e.g.:

- `✓ context7: npx -y @upstash/context7-mcp (stdio) - Connected` (docs example)
- on this host: `Configured MCP servers: ● pluton_probe: node … (stdio) - Pending approval` — **verified** (project-scope server, see 2.4).

Headless run surfaces (all **verified** as help text; the JSON ones also exercised): `-p/--prompt` or positional prompt; `-o text|json|stream-json`; `--input-format text|stream-json`; `--max-tool-calls`; `--max-wall-time`; `--json-schema`; `--json-fd`; `--approval-mode plan|default|auto-edit|auto|yolo`; `-y/--yolo`; `--allowed-tools` (“Tools to allow, will bypass confirmation”); `--allowed-mcp-server-names`; `--disable-mcp-server`; `--safe-mode` (“Disable all customizations (context files, hooks, extensions, skills, MCP servers) for troubleshooting”).

Live `-o json` output contains machine-readable events. The **init event** from a probe run — **verified**:

```json
{"type":"system","subtype":"init",
 "tools":["read_mcp_resource","skill","read_file", … ,
          "mcp__pluton_probe_http__pluton_probe_ping",
          "mcp__pluton_probe__pluton_probe_ping"],
 "mcp_servers":[{"name":"pluton_probe","status":"connected"},
                {"name":"pluton_probe_http","status":"connected"}],
 "permission_mode":"yolo","qwen_code_version":"0.25.2", …}
```

(Tool list abridged; full registry lists ~30 entries.) Useful for Phase 6: the manager harness can parse `mcp_servers`/`tools`/`permission_mode` from the init event instead of guessing.

### 2.4 Tool naming, exposure, and the deferred-tools bridge

- **Model-facing name: `mcp__<server>__<tool>`** (double underscores) — **verified** (init event above). On the wire the bare name is used: the stdio stub received `tools/call params.name = "pluton_probe_ping"` — **verified**.
- **The model does not see MCP tools directly in the LLM request**, even though they are registered (init event lists them). With ~30 registered tools, every captured main-model request carried only 10 tools: `edit, glob, grep_search, notebook_edit, read_file, run_shell_command, skill, tool_call, tool_search, write_file` — **verified** from the fake-endpoint request bodies (two runs, different model names).
- The bridge: the model calls `tool_search` (`{query: "select:<tool_name>" | keywords, max_results?}`, default 5, max 20 — schema **verified** from bundle `chunks/chunk-D6UTJ3SP.js`); the result is an informational `<functions>` block containing `{name, description, parametersJsonSchema, serverName}` — **verified** in the next request's tool message. The bundle's own description says: “After reviewing a hidden deferred tool's schema, invoke it through **tool_call** with its exact name and schema-shaped arguments. Do not call a hidden deferred tool directly…” — **verified** text, `chunks/chunk-D6UTJ3SP.js`.
- **End-to-end loop verified** with a fake model: request 1 → fake calls `tool_search("select:mcp__pluton_probe__pluton_probe_ping")` → Qwen executes it (auto-accepted) → request 2 → fake calls the hidden `tool_call` with `{name: "mcp__pluton_probe__pluton_probe_ping", arguments: {value: "42"}}` → **Qwen executed the MCP tool**: run stats `byName: {"tool_search": 1, "mcp__pluton_probe__pluton_probe_ping": 1}`, `permission_denials: []`, final result `DONE`. The stub log shows `tools/call {"name":"pluton_probe_ping","arguments":{"value":"42"},"_meta":{"progressToken":4}}` — **verified**.
- When this deferral activates (tool-count threshold? a setting?) is **unknown**; both `tool_search` and `tool_call` are present in the registry, which is the code-level gate for the bridge (`isDeferredToolBridgeAvailable()` — `chunks/chunk-D6UTJ3SP.js`). `QWEN_CODE_LEGACY_MCP_BLOCKING=1` restores blocking discovery **(docs)**; not tested.

### 2.5 Permission / approval gates

- **Project/workspace-scope servers are gated**: `isGatedMcpScope(scope) => scope === "project" || scope === "workspace"` (`chunks/chunk-IFAUFERF.js`) — and live, a project-scope server shows `Pending approval` in `qwen mcp list` and does not connect until approved with `qwen mcp approve <name>` (`remove`/`reject` exist too). **verified** (code + live list).
- **User scope is not gated** by construction — `isGatedMcpScope(scope)` is `scope === "project" || scope === "workspace"` (`chunks/chunk-IFAUFERF.js`) — and **`--mcp-config` servers are not gated live**: with `--mcp-config` pointing at the same stdio + HTTP servers, both reported `connected` in a headless run (**verified**).
- `trust: true` (or `qwen mcp add --trust`) skips tool-call confirmations for that server in a **trusted workspace**; connection-loss replay then applies only to idempotent/read-only-annotated calls — **(docs + CLI help)**.
- Approval modes (`--approval-mode`), `-y/--yolo`, and `--allowed-tools` bypass confirmations (help — **verified** text). Under `--approval-mode yolo` headless, MCP + bridge calls were `auto_accept` with no denials — **verified**; a warning is printed that yolo without a sandbox auto-executes at process privilege (silence with `QWEN_CODE_SUPPRESS_YOLO_WARNING=1`).
- Global `mcp.allowed` / `mcp.excluded` name lists (glob-capable) — **(docs)**.
- Where pending-approval state is stored was not determined — **unknown**; inside a Pluton-owned worker container Pluton owns the whole home directory, so it can pre-seed or avoid project scope entirely.

---

## 3. Comparison

| | OpenCode v2.0.30 | Qwen Code 0.25.2 |
| --- | --- | --- |
| Config key | `mcp.servers.<name>` (v2; flat `mcp.<name>` ignored) | `mcpServers.<name>` |
| User config | `~/.config/opencode/opencode.json(c)` | `~/.qwen/settings.json` (relocatable via `QWEN_HOME`) |
| Project config | `<project>/opencode.json` | `<workspace>/.qwen/settings.json` (gated) |
| stdio transport | `type:"local"` + `command[]` (+`cwd`,`environment`) — connected live | `command`+`args`(+`cwd`,`env`) — connected and call executed live |
| Streamable HTTP | `type:"remote"` + absolute `url` + `headers` — connected **and call executed** live | `httpUrl` + `headers` — connected live; call not executed (fake picked the stdio server) |
| SSE transport | not a v2 shape (v1 docs had none either) | legacy `url` |
| Auth headers | static `headers`; `{env:NAME}` indirection (docs); `oauth:false` to disable OAuth | static `headers`; `oauth` object for OAuth; env-var syntax documented for `env` values, not stated for `headers` |
| OAuth | enabled by default; PKCE; pre-registered/CIMD/DCR; `opencode mcp auth/logout`, `/mcps` | optional `oauth` object; `qwen mcp add --oauth-*`; tokens in `~/.qwen/mcp-oauth-tokens.json` |
| Tool naming (model-facing) | `<server>_<tool>` normalized; `tools.<server>.<tool>` under default Code Mode | `mcp__<server>__<tool>` (double underscore) |
| Tool visibility | direct entries when `codemode:false`; grouped behind `execute` by default | **deferred**: core tools + `tool_search` + `tool_call` in the LLM request; MCP tools discovered then invoked through `tool_call` |
| Headless mode | `opencode run --auto --format json -m provider/model "…"` | positional prompt / `-p`; `-o json|stream-json`; init event exposes `mcp_servers` |
| Approval gates | `--auto` flag; v2 `permissions[]` action/resource/effect; agent-level tools | approval modes + `--allowed-tools`; `trust`; `includeTools`/`excludeTools`; `mcp.allowed/excluded`; **project-scope servers need `mcp approve`** |
| Per-call metadata | `_meta["ai.opencode/sessionID"]` (verified) | `_meta.progressToken` (verified); explicit warning that these are not auth |
| Long-call timeout | execution default 12 h | tool-call default 10 min (`timeout` per server) |

---

## 4. Recommendation for a containerized Muse

Setup: the engine (OpenCode or Qwen) runs inside the worker container; Pluton's restricted MCP server runs on the host and authorizes every call (O4: “every bridge call is authorized server-side”).

**Recommendation: host-side Streamable HTTP endpoint + per-muse bearer token; engine inside the container configured as a remote client.**

- opencode: `{"type":"remote","url":"http://host.docker.internal:<port>/mcp","headers":{"Authorization":"Bearer {env:PLUTON_MCP_TOKEN}"},"oauth":false,"codemode":false}`. `codemode:false` makes the restricted tools appear as plain `<server>_<tool>` entries — simpler to reason about than Code Mode's `execute` indirection, and verified to work for both transports. Docker Desktop on Windows resolves `host.docker.internal` by default (**inferred**, standard behavior); on Linux workers add `--add-host=host.docker.internal:host-gateway` (**inferred**, verify in Phase 6).
- qwen: `{"mcpServers":{"pluton":{"httpUrl":"http://host.docker.internal:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}` written into the container's user-scope settings (Pluton owns the container home) or passed per run via `--mcp-config`. **Avoid project/workspace scope** — it triggers the `Pending approval` gate; user scope and `--mcp-config` are verified ungated.
- Why HTTP over a stdio bridge: no engine-spawned child process in the container (simpler containment story, cf. O7); Pluton sees each call at the host boundary and can authorize/log per call with the bearer token identifying the muse; both engines are verified to speak streamable HTTP (OpenCode executed a call; Qwen connected). Keep server-side authorization authoritative — engine approvals/permissions and `_meta` identifiers are UX/correlation, not security boundaries (R8).
- Fallback (if host networking is unavailable): a thin Pluton-authored stdio↔HTTP bridge binary shipped in the worker image, referenced as `type:"local"` / `command` — both engines were verified to spawn stdio servers; the bridge reads the per-muse token from the container environment. This adds a process but keeps one authorization point.
- Token handling: per-muse token, minted at container start, injected via container env, never in a committed config. Prefer OpenCode's `{env:…}` indirection where possible; for Qwen, either generate the settings file per muse or confirm header env-interpolation behavior first (§5).

### What remains to be tested in Phase 6

1. Real-model (non-fake) MCP roundtrip inside the actual worker image for both engines, with Pluton's authorization server enforcing per-call grants.
2. `host.docker.internal` reachability from the worker container on the supported hosts (Docker Desktop vs Linux worker), and container DNS/port publish.
3. OpenCode `{env:PLUTON_MCP_TOKEN}` substitution inside `headers` in the container (only docs-verified here), and `--auto` vs `permissions[]` deny rules with a real model.
4. Qwen header env-interpolation (`$VAR` in `headers`) or per-muse settings generation; also Qwen's tool-call timeout (10 min default) vs long Pluton tools.
5. Qwen deferral activation: find whether `tool_search`/`tool_call` deferral depends on registry size or a setting; a real manager prompt must succeed with deferred MCP tools.
6. Qwen project-scope approval mechanics in a container: pre-approval state location, whether `mcp approve` can be scripted at container start, or whether to stay on user scope/`--mcp-config`.
7. OpenCode background service vs `--standalone` inside the worker (which mode the manager harness should spawn), plus session persistence behavior.
8. Exit-code/harness contract: the Qwen probe runs returned a nonzero process exit code in some piped invocations despite `is_error:false` success JSON — pin down the exit-code convention before the manager relies on it.
9. Result-size and budget behavior: Qwen’s `WorkspaceMcpBudget` / server-count refusal path (code evidence only) and large tool-result handling in both engines.
10. Windows containment verification for engine processes (O7) with the Docker daemon running.

### Open items from this doc

- Qwen HTTP-transport **tool execution** (connected but not called in the verified loop).
- OpenCode OAuth flow (`opencode mcp auth`) — not exercised (Pluton plan disables OAuth).
- Same-name server precedence across config scopes for both engines (docs claim whole-object replacement — not tested).
- Exact storage/discovery order for Qwen user vs project settings inside the container (user scope chosen by design; verify no project file shadows it).

### Sources

- OpenCode v2 docs (fetched 2026-10-16): https://opencode.ai/v2/docs/mcp-servers · v1 docs page (still live, different schema): https://opencode.ai/docs/mcp-servers/
- Qwen Code docs (fetched 2026-10-16): https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md
- Installed bundles read-only for schema evidence: `…\@qwen-code\qwen-code\chunks\{chunk-IFAUFERF,chunk-D6UTJ3SP,chunk-EPODBRBP,chunk-BU5LEKKO}.js`.
- Probe artifacts (disposable): `C:\Users\Asus\AppData\Local\Temp\opencode\pluton-mcp-probe\` — `stub-inbound.log`, `stub-http.log`, `fake-openai.log` contain the raw JSON-RPC and LLM-request captures referenced above.
