# Model Providers in Pluton 4.1

Pluton 4.1 introduces native external provider support. In addition to process-based coding engines such as `opencode`, Pluton natively supports HTTP/SSE model providers through the `openai-compatible` engine adapter.

## Supported Engine Protocol

### `openai-compatible`
- **Inference**: Streaming Server-Sent Events (SSE) or non-streaming JSON over standard HTTP/HTTPS.
- **Discovery**: Queries `GET /models` (or custom `--models-path`) to inspect available models.
- **Tool Calling**: Connects directly to Pluton's native execution substrate via the HTTP MCP tool bridge (`tools/list`, `tools/call`).
- **Endpoints**: Any server implementing the OpenAI chat completion API (e.g. OpenAI, DeepSeek, Groq, Ollama, vLLM, LiteLLM, Cloudflare AI Gateway, OpenRouter).

## CLI Provider Management

### 1. Listing Configured Providers
```bash
pluton provider list [--json]
```
Outputs a table or JSON array containing provider IDs, engines, base URLs, auth styles, and credential configuration status.

### 2. Adding a Provider
```bash
pluton provider add <id> \
  --engine openai-compatible \
  --base-url <url> \
  [--display-name <name>] \
  [--auth-style bearer|header] \
  [--auth-header <name>] \
  [--auth-prefix <prefix>] \
  [--models-path <path>] \
  [--chat-path <path>] \
  [--timeout <ms>] \
  [--json]
```
Example:
```bash
pluton provider add deepseek \
  --engine openai-compatible \
  --base-url https://api.deepseek.com/v1 \
  --display-name "DeepSeek"
```
Metadata is saved in `.pluton/providers.json`. No secrets or keys are written to this file.

### 3. Storing Credentials (API Keys)
To prevent secrets from appearing in process tables (`ps`, Task Manager) or shell histories, credentials are **only** accepted via standard input:
```bash
# Via pipe
echo -n "sk-your-api-key" | pluton provider key deepseek

# Or interactive typing (finish with Enter / EOF)
pluton provider key deepseek
```
Credentials are saved to `.pluton/provider-homes/<id>/credential.json`:
- **Linux / macOS**: Permissions set to mode `0600` on the file and `0700` on the directory.
- **Windows**: ACL inheritance is disabled; explicit read/write access is granted strictly to the current user SID, SYSTEM SID, and Administrators SID.

### 4. Validating a Provider
```bash
pluton provider validate <id> [--json]
```
Tests:
1. Provider configuration validity.
2. Credential availability.
3. Live network connectivity and model list response from the remote endpoint.

### 5. Inspecting Provider Models
```bash
pluton provider models <id> [--json]
```
Lists models returned by the provider's `/models` endpoint.

### 6. Removing Credentials and Providers
```bash
# Delete the stored API key
pluton provider remove-key <id>

# Remove the provider configuration and delete its private home directory
pluton provider remove <id>
```

## Configuring Ships with Providers

Ships in `pluton.yaml` declare their engine and optional provider:

```yaml
version: 1
project:
  name: demo
  repository: .
  default_branch: main
  verification: []
ships:
  manager:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/test
    workspace_policy: coordinator-read-only
  coder:
    display_name: DeepSeek Coder
    role: coder
    engine: openai-compatible
    provider: deepseek
    model: deepseek-chat
    workspace_policy: isolated-task-checkout
```

You can create or update Ships via the CLI:
```bash
# Create a Ship with a provider
pluton ship create coder \
  --engine openai-compatible \
  --provider deepseek \
  --model deepseek-chat \
  --role coder

# Update an existing Ship's provider
pluton ship edit coder --provider deepseek
```

## Web Workspace UI & REST API Management

Pluton 4.1 also provides graphical management of providers and models in the Web Workspace UI:

### Settings: AI Providers Management
Under the **Settings** sidebar tab (`sidebarTabSettings`):
1. **Configured Providers Table**: View configured providers, their underlying engines (`openai-compatible`, `opencode`), base URLs, and credential status (`Key Configured` / `No Key`).
2. **Add Provider Dialog**: Click **+ Add Provider** to configure an endpoint:
   - Provide Provider ID, select engine, display name, base URL, and optional API key.
   - Credentials are submitted securely via POST and written directly to `.pluton/provider-homes/<id>/credential.json` (0600 permissions); keys are never returned in responses.
3. **Provider Actions**:
   - **Set / Update Key**: Opens credential prompt to update the stored API key.
   - **Remove Key**: Removes the stored credential while preserving provider configuration.
   - **Validate**: Tests network connectivity and lists discovered models directly in the UI.
   - **Delete**: Confirms and removes the provider and its credential directory.

### Searchable Model Selection Dialog
Clicking **Switch Model** in the bottom status strip or clicking **Browse...** on any Ship row opens the **Select AI Model** dialog:
- **Search & Filter**: Real-time search across model IDs, labels, engines, and providers.
- **Provider & Engine Badges**: Clear grouping and availability indicators (e.g. green for available, red for probe failures with reasons).
- **Ship Assignment**: Select a model to assign it to the target Ship; Pluton atomically updates `pluton.yaml`, updates SQLite, restarts the Ship's engine session, and provides an Undo action.

### REST API Endpoints

- `GET /api/providers`: Returns list of configured providers with `hasCredential` boolean flags (no plaintext keys).
- `POST /api/providers`: Registers a new provider with optional `apiKey`.
- `GET /api/providers/:id`: Returns provider details with `hasCredential`.
- `DELETE /api/providers/:id`: Deletes provider configuration and private credential home.
- `POST /api/providers/:id/key`: Stores provider API key in private credential storage.
- `DELETE /api/providers/:id/key`: Deletes provider API key.
- `POST /api/providers/:id/validate`: Executes validation checks and returns `{ ok: true, report }`.
- `POST /api/ships/:id/model`: Updates Ship model, engine, and provider atomically; updates `pluton.yaml` and reloads the engine session. (Backward-compatible alias: `POST /api/muses/:id/model`).

## Security & Isolation Guarantees

1. **No Credentials in Configuration or Database**: `pluton.yaml` and SQLite only record provider identifiers (e.g. `provider: deepseek`), never API keys.
2. **Strict Redaction**: Any API key matching a configured provider is automatically redacted from log files, SSE messages, CLI responses, and error traces.
3. **Restricted Access**: Stored keys are restricted to the local user via filesystem permissions and Windows Security Identifiers (SIDs).
4. **No Process Args**: CLI commands will reject any attempt to pass credentials via flags or options.
