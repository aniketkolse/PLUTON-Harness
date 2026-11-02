import { z } from 'zod'

/**
 * Provider metadata is project-local configuration, never a secret store.
 * Credentials live in `.pluton/provider-homes/<id>/credential.json` (0600)
 * and are addressed only by provider id.
 */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,47}$/
export const PROVIDER_REGISTRY_VERSION = 1

/**
 * Refuse provider ids that look like a pasted credential. This is a guard
 * against operator error, not a security boundary: the real boundary is that
 * credentials are only ever read from the credential file.
 */
const CREDENTIAL_SHAPED_ID_RE = /^(?:sk|pk|rk|ak|api|key|token|secret|bearer)[-_]/i

export function isValidProviderId(value: string): boolean {
  if (typeof value !== 'string') return false
  if (!PROVIDER_ID_RE.test(value)) return false
  return !CREDENTIAL_SHAPED_ID_RE.test(value)
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

function validateBaseUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    if (!loopback) return false
  }
  return true
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
      .refine(isValidProviderId, 'provider ids are lowercase slugs starting with a letter and must not look like a credential'),
    engine: z.string().min(1).max(64),
    display_name: z.string().min(1).max(200),
    base_url: z.string().refine(validateBaseUrl, {
      message:
        'base_url must be an http(s) URL without embedded credentials; plain http is allowed only for loopback gateways',
    }),
    auth: providerAuthSchema.default({ style: 'bearer' }),
    models_path: z.string().refine(validatePath, { message: 'models_path must be an absolute URL path' }).default('/models'),
    chat_path: z.string().refine(validatePath, { message: 'chat_path must be an absolute URL path' }).default('/chat/completions'),
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

export interface ProviderRegistryFile {
  version: typeof PROVIDER_REGISTRY_VERSION
  providers: Record<string, ProviderConfig>
}

export function emptyProviderRegistry(): ProviderRegistryFile {
  return { version: PROVIDER_REGISTRY_VERSION, providers: {} }
}

/** Validate a credential value before it ever reaches a file or a header. */
export function isValidCredentialValue(value: string): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 16_384) return false
  if (value.trim() !== value) return false
  return !/[\u0000-\u001f\u007f]/.test(value)
}
