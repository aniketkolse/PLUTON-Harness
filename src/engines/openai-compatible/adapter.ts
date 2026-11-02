import {
  CapabilityError,
  EngineAuthMissingError,
  ValidationError,
} from '../../domain/errors.ts'
import type {
  EngineAdapter,
  EngineAuthStatus,
  EngineCapabilities,
  EngineDiscovery,
  EngineModel,
  EngineSession,
  ModelAvailability,
  StartSessionRequest,
} from '../contract/types.ts'
import { defaultCapabilities } from '../contract/types.ts'
import type { ProviderConfig } from '../../providers/types.ts'
import {
  credentialHint,
  hasProviderCredential,
  listProviders,
  readProviderCredential,
  resolveProviderForEngine,
} from '../../providers/store.ts'
import { OpenAICompatibleClient } from './client.ts'
import { McpHttpClient } from './mcp-client.ts'
import { OpenAICompatibleSession, type ToolClient } from './session.ts'

/**
 * Reference implementation of a real second engine (PLUTON 4.1, Phase 1).
 *
 * All provider-specific protocol lives in `client.ts` / `session.ts`; this
 * adapter is the contract bridge: provider resolution, credential presence,
 * discovery, model inventory, and session validation. No model id, URL, or
 * fallback catalog is hardcoded here.
 */

export const OPENAI_COMPATIBLE_KIND = 'openai-compatible'

export interface OpenAICompatibleAdapterOptions {
  /** Project root that contains `.pluton/providers.json`. */
  rootDir?: string
  /** Optional explicit provider id from the Ship's config. */
  providerId?: string
  /** Test seam for provider HTTP calls only. */
  fetchFn?: typeof fetch
  /** Test seam for the MCP tool bridge HTTP calls. */
  mcpFetchFn?: typeof fetch
}

export class OpenAICompatibleAdapter implements EngineAdapter {
  readonly kind = OPENAI_COMPATIBLE_KIND
  private readonly opts: OpenAICompatibleAdapterOptions

  constructor(opts: OpenAICompatibleAdapterOptions = {}) {
    this.opts = opts
  }

  capabilities(): EngineCapabilities {
    return {
      ...defaultCapabilities(),
      interrupt: true,
      usage: true,
      modelList: true,
      mcpServers: true,
    }
  }

  async discover(): Promise<EngineDiscovery> {
    const configured = this.configuredProviders()
    if (configured.length === 0) {
      return {
        engineKind: this.kind,
        installed: false,
        binaryPath: null,
        version: null,
        fix: 'run `pluton provider add <id> --engine openai-compatible --base-url <url>`, then `pluton provider key <id>`',
      }
    }
    const provider = this.resolveProvider()
    return {
      engineKind: this.kind,
      installed: true,
      binaryPath: null,
      version: null,
      fix: `HTTP provider '${provider.id}' is selected; ${credentialHint(provider.id)}`,
    }
  }

  async listModels(): Promise<EngineModel[]> {
    const provider = this.resolveProvider()
    const client = this.clientFor(provider, this.credentialFor(provider))
    const models = await client.listModels()
    return models.map((model) => ({
      id: model.id,
      ...(model.label !== undefined ? { label: model.label } : {}),
      source: 'engine' as const,
      provider: provider.id,
    }))
  }

  async listModelsWithAvailability(candidateModels?: string[]): Promise<ModelAvailability[]> {
    let discovered: EngineModel[]
    try {
      discovered = await this.listModels()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return (candidateModels ?? []).map((id) => ({
        id,
        available: false,
        reason,
        source: 'engine' as const,
      }))
    }

    if (candidateModels === undefined) {
      return discovered.map((model) => ({
        id: model.id,
        available: true,
        label: model.label ?? model.id,
        source: 'engine' as const,
      }))
    }

    const byId = new Map(discovered.map((model) => [model.id, model]))
    const providerId = discovered[0]?.provider ?? this.opts.providerId ?? this.kind
    return candidateModels.map((id) => {
      const model = byId.get(id)
      if (model === undefined) {
        return {
          id,
          available: false,
          reason: `not reported by provider ${providerId}`,
          source: 'engine' as const,
        }
      }
      return {
        id,
        available: true,
        label: model.label ?? model.id,
        source: 'engine' as const,
      }
    })
  }

  async authStatus(_configDir: string): Promise<EngineAuthStatus> {
    const configured = this.configuredProviders()
    if (configured.length === 0) {
      return {
        configured: false,
        hint: 'run `pluton provider add <id> --engine openai-compatible --base-url <url>` first',
      }
    }
    const provider = this.resolveProvider()
    return {
      configured: hasProviderCredential(this.requireRoot(), provider.id),
      hint: credentialHint(provider.id),
    }
  }

  async startSession(req: StartSessionRequest): Promise<EngineSession> {
    const provider = this.resolveProvider()
    const apiKey = this.credentialFor(provider)
    const model = (req.ship ?? req.muse)?.model
    if (typeof model !== 'string' || model.trim() === '') {
      throw new ValidationError(
        `engine '${this.kind}' requires an exact provider-qualified model id; model selection is not implicit`,
      )
    }
    if (req.resumeToken !== undefined) {
      throw new CapabilityError(this.kind, 'resumeSession')
    }

    const servers = req.mcpServers ?? []
    if (servers.length > 1) {
      throw new ValidationError(
        `engine '${this.kind}' supports at most one MCP server per session; received ${String(servers.length)}`,
      )
    }
    let mcpClient: ToolClient | null = null
    if (servers.length === 1) {
      const spec = servers[0]!
      if (spec.kind !== 'http') {
        throw new CapabilityError(this.kind, 'mcpServers:stdio')
      }
      mcpClient = new McpHttpClient({
        url: spec.url,
        ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
        engineKind: this.kind,
        ...(this.opts.mcpFetchFn !== undefined ? { fetchFn: this.opts.mcpFetchFn } : {}),
      })
    }

    return new OpenAICompatibleSession({
      client: this.clientFor(provider, apiKey),
      model,
      ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
      mcpClient,
    })
  }

  private requireRoot(): string {
    if (this.opts.rootDir === undefined || this.opts.rootDir === '') {
      throw new ValidationError(
        `engine '${this.kind}' requires a project root to resolve its provider`,
      )
    }
    return this.opts.rootDir
  }

  private configuredProviders(): ProviderConfig[] {
    if (this.opts.rootDir === undefined || this.opts.rootDir === '') return []
    return listProviders(this.opts.rootDir).filter((provider) => provider.engine === this.kind)
  }

  private resolveProvider(): ProviderConfig {
    return resolveProviderForEngine(this.requireRoot(), this.kind, this.opts.providerId)
  }

  private credentialFor(provider: ProviderConfig): string {
    const apiKey = readProviderCredential(this.requireRoot(), provider.id)
    if (apiKey === null) {
      throw new EngineAuthMissingError(this.kind, credentialHint(provider.id))
    }
    return apiKey
  }

  private clientFor(provider: ProviderConfig, apiKey: string): OpenAICompatibleClient {
    return new OpenAICompatibleClient({
      baseUrl: provider.base_url,
      apiKey,
      auth: provider.auth,
      ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
      modelsPath: provider.models_path,
      chatPath: provider.chat_path,
      ...(provider.timeout_ms !== undefined ? { timeoutMs: provider.timeout_ms } : {}),
      engineKind: this.kind,
      providerId: provider.id,
      ...(this.opts.fetchFn !== undefined ? { fetchFn: this.opts.fetchFn } : {}),
    })
  }
}
