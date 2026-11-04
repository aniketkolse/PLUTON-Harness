import { z } from 'zod'
import { validateEndpointUrl } from './validation.ts'

/**
 * Provider metadata is project-local configuration, never a secret store.
 * Credentials live in `.pluton/provider-homes/<id>/credential.json` (0600)
 * and are addressed only by provider or connection id.
 */
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
export const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const PROVIDER_REGISTRY_VERSION = 1

/**
 * Refuse provider / connection ids that look like a pasted credential. This is a guard
 * against operator error, not a security boundary: the real boundary is that
 * credentials are only ever read from the credential file.
 */
const CREDENTIAL_SHAPED_ID_RE = /^(?:sk|pk|rk|ak|api|key|token|secret|bearer)[-_]/i

export function isValidProviderId(value: string): boolean {
  if (typeof value !== 'string') return false
  if (!PROVIDER_ID_RE.test(value)) return false
  return !CREDENTIAL_SHAPED_ID_RE.test(value)
}

export function isValidConnectionId(value: string): boolean {
  if (typeof value !== 'string') return false
  if (!CONNECTION_ID_RE.test(value)) return false
  return !CREDENTIAL_SHAPED_ID_RE.test(value)
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

function validateBaseUrl(value: string): boolean {
  return validateEndpointUrl(value).ok
}

function validatePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('..')
}

export const providerAuthSchema = z
  .object({
    /** How the credential is presented: standard bearer or a named header. */
    style: z.enum(['bearer', 'header']),
    /** Required for `header`; ignored for `bearer`. */
    header: z.string().min(1).max(128).optional(),
    /** Value prefix (defaults: 'Bearer ' for bearer, '' for header). */
    prefix: z.string().max(128).optional(),
  })
  .strict()
  .superRefine((auth, ctx) => {
    if (auth.style === 'header') {
      if (auth.header === undefined) {
        ctx.addIssue({ code: 'custom', path: ['header'], message: 'header is required when style is header' })
      } else if (!HEADER_NAME_RE.test(auth.header)) {
        ctx.addIssue({ code: 'custom', path: ['header'], message: 'invalid HTTP header name' })
      }
    }
    if (auth.prefix !== undefined && /[\r\n]/.test(auth.prefix)) {
      ctx.addIssue({ code: 'custom', path: ['prefix'], message: 'prefix must not contain newlines' })
    }
  })

export const providerConfigSchema = z
  .object({
    id: z
      .string()
      .refine(isValidProviderId, 'provider ids are lowercase slugs starting with a letter or digit and must not look like a credential'),
    engine: z.string().min(1).max(64),
    display_name: z.string().min(1).max(200),
    base_url: z.string().refine(validateBaseUrl, {
      message:
        'base_url must be an http(s) URL without embedded credentials; plain http is allowed only for loopback gateways',
    }),
    auth: providerAuthSchema.default({ style: 'bearer' }),
    models_path: z.string().refine(validatePath, { message: 'models_path must be an absolute URL path' }).default('/models'),
    chat_path: z.string().refine(validatePath, { message: 'chat_path must be an absolute URL path' }).default('/chat/completions'),
    /**
     * Model ids reported by the provider, provider-local (no provider prefix).
     * Imported from OpenCode so the picker still shows the catalogue while a
     * loopback gateway is offline.
     */
    models: z.array(z.string().min(1).max(300)).max(5000).optional(),
    /** Non-secret headers sent with every request. Secrets belong in the credential file. */
    headers: z
      .record(z.string(), z.string())
      .optional()
      .superRefine((headers, ctx) => {
        if (headers === undefined) return
        for (const [name, value] of Object.entries(headers)) {
          if (!HEADER_NAME_RE.test(name)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'invalid HTTP header name' })
          }
          if (/[\r\n]/.test(value)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'HTTP header values must not contain newlines' })
          }
        }
      }),
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  })
  .strict()

export type ProviderAuthConfig = z.infer<typeof providerAuthSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>

export const connectionProtocolSchema = z.enum(['openai-compatible', 'anthropic', 'google', 'custom'])
export type ConnectionProtocol = z.infer<typeof connectionProtocolSchema>

export interface ManualModelEntry {
  connectionId: string
  modelId: string
  displayName?: string
  capabilities?: {
    toolCalling?: boolean
    contextWindow?: number
    coding?: boolean
    reasoning?: boolean
  }
  registeredAt: string
}

export const connectionConfigSchema = z
  .object({
    id: z
      .string()
      .refine(
        isValidConnectionId,
        'connection ids are lowercase slugs starting with a letter or digit and must not look like a credential',
      ),
    providerId: z.string().min(1).max(64),
    displayName: z.string().min(1).max(200),
    baseUrl: z.string().refine(validateBaseUrl, {
      message:
        'baseUrl must be an http(s) URL without embedded credentials; plain http is allowed only for loopback gateways',
    }),
    protocol: connectionProtocolSchema.default('openai-compatible'),
    auth: providerAuthSchema.default({ style: 'bearer' }),
    modelsPath: z.string().refine(validatePath, { message: 'modelsPath must be an absolute URL path' }).default('/models').optional(),
    chatPath: z.string().refine(validatePath, { message: 'chatPath must be an absolute URL path' }).default('/chat/completions').optional(),
    models: z.array(z.string().min(1).max(300)).max(5000).optional(),
    customHeaders: z
      .record(z.string(), z.string())
      .optional()
      .superRefine((headers, ctx) => {
        if (headers === undefined) return
        for (const [name, value] of Object.entries(headers)) {
          if (!HEADER_NAME_RE.test(name)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'invalid HTTP header name' })
          }
          if (/[\r\n]/.test(value)) {
            ctx.addIssue({ code: 'custom', path: [name], message: 'HTTP header values must not contain newlines' })
          }
        }
      }),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict()

export type ConnectionConfig = z.infer<typeof connectionConfigSchema>

export interface ProviderConnectionRegistryFile {
  version: typeof PROVIDER_REGISTRY_VERSION
  providers?: Record<string, ProviderConfig>
  connections?: Record<string, ConnectionConfig>
}

export interface ProviderRegistryFile {
  version: typeof PROVIDER_REGISTRY_VERSION
  providers: Record<string, ProviderConfig>
  connections?: Record<string, ConnectionConfig>
}

export function emptyProviderRegistry(): ProviderRegistryFile {
  return { version: PROVIDER_REGISTRY_VERSION, providers: {} }
}

export function providerToConnection(provider: ProviderConfig): ConnectionConfig {
  return {
    id: provider.id,
    providerId: provider.engine,
    displayName: provider.display_name,
    baseUrl: provider.base_url,
    protocol: 'openai-compatible',
    auth: provider.auth,
    modelsPath: provider.models_path,
    chatPath: provider.chat_path,
    models: provider.models,
    customHeaders: provider.headers,
    timeoutMs: provider.timeout_ms,
  }
}

export function connectionToProvider(conn: ConnectionConfig): ProviderConfig {
  return {
    id: conn.id,
    engine: conn.protocol ?? 'openai-compatible',
    display_name: conn.displayName,
    base_url: conn.baseUrl,
    auth: conn.auth,
    models_path: conn.modelsPath ?? '/models',
    chat_path: conn.chatPath ?? '/chat/completions',
    models: conn.models,
    headers: conn.customHeaders,
    timeout_ms: conn.timeoutMs,
  }
}

/** Validate a credential value before it ever reaches a file or a header. */
export function isValidCredentialValue(value: string): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 16_384) return false
  if (value.trim() !== value) return false
  return !/[\u0000-\u001f\u007f]/.test(value)
}
