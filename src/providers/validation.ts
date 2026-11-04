/**
 * Endpoint URL validation and SSRF protection.
 *
 * Enforces safe schemes (https, or http strictly for loopback),
 * blocks cloud metadata endpoints (169.254.169.254, metadata.google.internal),
 * link-local addresses, and embedded credentials.
 */

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'instance-data',
  'metadata.google.internal',
  'metadata',
  'fd00:ec2::254',
])

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
    return true
  }
  if (host.startsWith('127.')) {
    return true
  }
  return false
}

function isLinkLocalOrMetadata(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTS.has(host)) {
    return true
  }
  // IPv4 link-local: 169.254.0.0/16
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    return true
  }
  // IPv6 link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(host)) {
    return true
  }
  return false
}

export function validateEndpointUrl(value: string): { ok: boolean; reason?: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, reason: 'URL must be a non-empty string' }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'Invalid URL format' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol '${url.protocol}'; only http: and https: are allowed` }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'Credentials must not be embedded in URL' }
  }

  const hostname = url.hostname

  if (isLinkLocalOrMetadata(hostname)) {
    return { ok: false, reason: 'Access to cloud metadata or link-local address is forbidden' }
  }

  if (url.protocol === 'http:') {
    if (!isLoopback(hostname)) {
      return { ok: false, reason: 'https required for non-loopback endpoints; plain http is only permitted for loopback' }
    }
  }

  return { ok: true }
}
