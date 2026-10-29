import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  platformKey,
  type HelperCapability,
  type NativeCapabilities,
  type PlatformKey,
} from './policy.ts'

/**
 * Capability detection is deliberately conservative: a control is reported as
 * available only when this process can prove it. Unknown, unreadable or
 * mismatched facts are false/null, and the policy gate then fails closed.
 */

export const HELPER_ABI = 1

export interface HelperManifestTarget {
  file: string
  sha256: string
  size?: number
}

export interface HelperManifest {
  helperAbi: number
  version: string
  targets: Record<string, HelperManifestTarget>
}

export function packageRoot(): string {
  // src/execution/capabilities.ts (dev) or dist/execution/capabilities.js (built)
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function helperTargetFor(platform: PlatformKey, arch: string): string | null {
  if (platform !== 'linux') return null
  if (arch === 'x64') return 'linux-x64'
  if (arch === 'arm64') return 'linux-arm64'
  return null
}

export function helperPathFor(
  target: string,
  root = packageRoot(),
): string {
  return join(root, 'native', 'landlock-run', `landlock-run-${target}`)
}

export function readHelperManifest(root = packageRoot()): HelperManifest | null {
  const path = join(root, 'native', 'landlock-run', 'manifest.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj['helperAbi'] !== 'number' || typeof obj['version'] !== 'string') return null
    if (obj['targets'] === null || typeof obj['targets'] !== 'object') return null
    return parsed as HelperManifest
  } catch {
    return null
  }
}

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function probeHelper(path: string): {
  ok: boolean
  detail?: string
  abi?: number
  userNamespaces?: boolean
  mountNamespaces?: boolean
  networkNamespaces?: boolean
  pidNamespaces?: boolean
} {
  const probe = spawnSync(path, ['--probe'], { encoding: 'utf8', timeout: 5_000 })
  if (probe.error !== undefined) return { ok: false, detail: probe.error.message }
  if (probe.status !== 0) {
    return { ok: false, detail: (probe.stderr || probe.stdout || `exit ${String(probe.status)}`).trim().slice(0, 500) }
  }
  try {
    const parsed = JSON.parse(probe.stdout) as Record<string, unknown>
    const abi = typeof parsed['landlockAbi'] === 'number' ? parsed['landlockAbi'] : undefined
    if (abi === undefined) return { ok: false, detail: 'helper probe returned no landlockAbi' }
    return {
      ok: true,
      abi,
      userNamespaces: parsed['userNamespaces'] === true,
      mountNamespaces: parsed['mountNamespaces'] === true,
      networkNamespaces: parsed['networkNamespaces'] === true,
      pidNamespaces: parsed['pidNamespaces'] === true,
    }
  } catch (e) {
    return { ok: false, detail: `helper probe returned invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export function verifyHelper(options?: {
  root?: string
  platform?: NodeJS.Platform
  arch?: string
}): HelperCapability {
  const platform = platformKey(options?.platform ?? process.platform)
  const target = helperTargetFor(platform, options?.arch ?? process.arch)
  if (target === null) {
    return {
      available: false,
      version: null,
      sha256: null,
      detail: `no native helper is built for ${platform}/${options?.arch ?? process.arch}`,
    }
  }
  const root = options?.root ?? packageRoot()
  const manifest = readHelperManifest(root)
  if (manifest === null) {
    return { available: false, version: null, sha256: null, detail: 'native helper manifest is missing or invalid' }
  }
  if (manifest.helperAbi !== HELPER_ABI) {
    return {
      available: false,
      version: manifest.version,
      sha256: null,
      detail: `native helper ABI ${String(manifest.helperAbi)} is not supported (expected ${String(HELPER_ABI)})`,
    }
  }
  const expected = manifest.targets[target]
  if (expected === undefined) {
    return { available: false, version: manifest.version, sha256: null, detail: `manifest has no ${target} helper` }
  }
  const path = helperPathFor(target, root)
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { available: false, version: manifest.version, sha256: null, detail: `native helper is missing: ${path}` }
  }
  const actual = sha256File(path)
  if (actual === null) {
    return { available: false, version: manifest.version, sha256: null, detail: `native helper is unreadable: ${path}` }
  }
  if (actual !== expected.sha256.toLowerCase()) {
    return {
      available: false,
      version: manifest.version,
      sha256: actual,
      detail: `native helper hash mismatch for ${target}: expected ${expected.sha256}, got ${actual}`,
    }
  }
  if (expected.size !== undefined && statSync(path).size !== expected.size) {
    return {
      available: false,
      version: manifest.version,
      sha256: actual,
      detail: `native helper size mismatch for ${target}`,
    }
  }
  const probe = probeHelper(path)
  if (!probe.ok) {
    return { available: false, version: manifest.version, sha256: actual, detail: probe.detail ?? 'helper probe failed' }
  }
  return { available: true, version: manifest.version, sha256: actual }
}

function runUnshare(platform: PlatformKey, args: string[]): boolean {
  // Probe only when the requested platform is Linux. Using process.platform
  // here made synthetic win32/darwin reports inherit the host's namespaces.
  if (platform !== 'linux') return false
  const result = spawnSync('unshare', args, { stdio: 'ignore', timeout: 5_000 })
  return result.error === undefined && result.status === 0
}

export function detectCapabilities(options?: {
  root?: string
  platform?: NodeJS.Platform
  arch?: string
}): NativeCapabilities {
  const platform = platformKey(options?.platform ?? process.platform)
  const arch = options?.arch ?? process.arch
  const helper = verifyHelper(options)
  const linux = platform === 'linux'
  let kernelRelease: string | null = null
  if (linux) {
    try {
      kernelRelease = readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim()
    } catch {
      kernelRelease = null
    }
  }
  const probe = helper.available
    ? probeHelper(helperPathFor(helperTargetFor(platform, arch) as string, options?.root ?? packageRoot()))
    : null
  const runtimeRoots = new Set<string>()
  try {
    runtimeRoots.add(dirname(process.execPath))
  } catch {
    // Best effort; engine resolution adds its own roots.
  }
  return {
    platform,
    arch,
    kernelRelease,
    landlockAbi: probe?.abi ?? null,
    userNamespaces: probe?.userNamespaces ?? runUnshare(platform, ['-Ur', 'true']),
    mountNamespaces: probe?.mountNamespaces ?? runUnshare(platform, ['-Urm', 'true']),
    networkNamespaces: probe?.networkNamespaces ?? runUnshare(platform, ['-Urn', 'true']),
    pidNamespaces: probe?.pidNamespaces ?? runUnshare(platform, ['-Urp', 'true']),
    cgroupV2: linux && existsSync('/sys/fs/cgroup/cgroup.controllers'),
    helper,
    runtimeRoots: [...runtimeRoots],
  }
}
