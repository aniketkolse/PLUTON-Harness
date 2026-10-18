/**
 * Container user mapping and Linux bind-mount file ownership alignment (ADR-0004, ADR-0010).
 * Prevents host permission conflicts on agent-created files while strictly enforcing non-root sandbox execution.
 */

import { ValidationError } from '../domain/errors.ts'

export const DEFAULT_MUSE_CONTAINER_USER = '10001:10001'

export interface UserMappingOptions {
  configured?: string
  envUser?: string
  platform?: NodeJS.Platform
  getuid?: () => number
  getgid?: () => number
}

export interface UserMappingResolution {
  containerUser: string
  source: 'configured' | 'env' | 'host-detected' | 'default'
  warning?: string
}

function validateNonRootUser(userStr: string, context: string): void {
  if (!/^\d+(:\d+)?$/.test(userStr) || userStr === '0' || userStr.startsWith('0:')) {
    throw new ValidationError(
      `${context} must be a numeric non-root user (uid or uid:gid), got '${userStr}'`,
      { details: { containerUser: userStr } },
    )
  }
}

export function resolveContainerUser(opts: UserMappingOptions = {}): UserMappingResolution {
  const env = opts.envUser ?? process.env['PLUTON_CONTAINER_USER']
  if (env && env.trim() !== '') {
    validateNonRootUser(env.trim(), 'PLUTON_CONTAINER_USER')
    return {
      containerUser: env.trim(),
      source: 'env',
    }
  }

  const configured = opts.configured?.trim()
  if (configured && configured !== 'auto' && configured !== 'host') {
    validateNonRootUser(configured, 'sandbox container_user')
    return {
      containerUser: configured,
      source: 'configured',
    }
  }

  const platform = opts.platform ?? process.platform
  const getuid = opts.getuid ?? process.getuid
  const getgid = opts.getgid ?? process.getgid

  if (platform !== 'win32' && typeof getuid === 'function') {
    const uid = getuid()
    if (uid === 0) {
      return {
        containerUser: DEFAULT_MUSE_CONTAINER_USER,
        source: 'default',
        warning: 'Host user is root (uid 0); refusing root container execution and falling back to default non-root 10001:10001',
      }
    }
    const gid = typeof getgid === 'function' ? getgid() : uid
    return {
      containerUser: `${uid}:${gid}`,
      source: 'host-detected',
    }
  }

  return {
    containerUser: DEFAULT_MUSE_CONTAINER_USER,
    source: 'default',
  }
}
