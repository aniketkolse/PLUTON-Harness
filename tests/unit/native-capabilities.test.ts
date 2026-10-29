import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SandboxUnavailableError } from '../../src/domain/errors.ts'
import {
  HELPER_ABI,
  detectCapabilities,
  helperPathFor,
  helperTargetFor,
  packageRoot,
  readHelperManifest,
  verifyHelper,
} from '../../src/execution/capabilities.ts'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

const tmpDirs: string[] = []

const OK_PROBE = {
  landlockAbi: 3,
  userNamespaces: true,
  mountNamespaces: true,
  networkNamespaces: true,
  pidNamespaces: true,
}

function okProbe(overrides: Record<string, unknown> = {}) {
  return {
    error: undefined,
    status: 0,
    stdout: JSON.stringify({ ...OK_PROBE, ...overrides }),
    stderr: '',
  }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pluton-native-caps-'))
  tmpDirs.push(root)
  return root
}

function writeHelper(root: string, content = 'helper-binary') {
  const target = 'linux-x64'
  const path = helperPathFor(target, root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return {
    target,
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  }
}

function writeManifest(root: string, manifest: unknown): void {
  const path = join(root, 'native', 'landlock-run', 'manifest.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
}

function manifestFor(helper: { target: string; sha256: string; size: number }, overrides: Record<string, unknown> = {}) {
  return {
    helperAbi: HELPER_ABI,
    version: '1.2.3',
    targets: {
      [helper.target]: {
        file: `landlock-run-${helper.target}`,
        sha256: helper.sha256,
        size: helper.size,
      },
    },
    ...overrides,
  }
}

beforeEach(() => {
  spawnSyncMock.mockReset()
  spawnSyncMock.mockReturnValue(okProbe())
})

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('native helper discovery', () => {
  it('maps platform and architecture to a helper target', () => {
    expect(helperTargetFor('linux', 'x64')).toBe('linux-x64')
    expect(helperTargetFor('linux', 'arm64')).toBe('linux-arm64')
    expect(helperTargetFor('linux', 'ia32')).toBeNull()
    expect(helperTargetFor('darwin', 'arm64')).toBeNull()
    expect(helperTargetFor('win32', 'x64')).toBeNull()
  })

  it('resolves the helper path under the package root', () => {
    const root = 'C:\\package'
    expect(helperPathFor('linux-x64', root)).toBe(join(root, 'native', 'landlock-run', 'landlock-run-linux-x64'))
    expect(existsSync(join(packageRoot(), 'package.json'))).toBe(true)
  })

  it('returns null for a missing, unreadable or malformed manifest', () => {
    const missing = makeRoot()
    expect(readHelperManifest(missing)).toBeNull()

    const brokenJson = makeRoot()
    writeManifest(brokenJson, '{not json')
    expect(readHelperManifest(brokenJson)).toBeNull()

    for (const malformed of [null, [], 'text', 42, { version: '1' }, { helperAbi: 1 }, { helperAbi: 1, version: '1', targets: null }]) {
      const root = makeRoot()
      writeManifest(root, malformed)
      expect(readHelperManifest(root)).toBeNull()
    }
  })

  it('reads a valid manifest unchanged', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    const manifest = manifestFor(helper)
    writeManifest(root, manifest)
    expect(readHelperManifest(root)).toEqual(manifest)
  })
})

describe('native helper verification', () => {
  it('reports unavailable on a non-Linux platform', () => {
    const result = verifyHelper({ platform: 'win32', arch: 'x64', root: makeRoot() })
    expect(result).toMatchObject({ available: false, version: null, sha256: null })
    expect(result.detail).toMatch(/no native helper is built for win32\/x64/)
  })

  it('reports unavailable for an unsupported architecture', () => {
    const result = verifyHelper({ platform: 'linux', arch: 'ia32', root: makeRoot() })
    expect(result.available).toBe(false)
    expect(result.detail).toMatch(/no native helper is built for linux\/ia32/)
  })

  it('reports unavailable when the manifest is missing', () => {
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root: makeRoot() })
    expect(result).toEqual({
      available: false,
      version: null,
      sha256: null,
      detail: 'native helper manifest is missing or invalid',
    })
  })

  it('reports an ABI mismatch before reading the binary', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper, { helperAbi: HELPER_ABI + 1 }))
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, version: '1.2.3', sha256: null })
    expect(result.detail).toMatch(/native helper ABI 2 is not supported/)
  })

  it('reports a manifest without the current target', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, { helperAbi: HELPER_ABI, version: '1.2.3', targets: { 'linux-arm64': { sha256: helper.sha256 } } })
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, sha256: null })
    expect(result.detail).toMatch(/manifest has no linux-x64 helper/)
  })

  it('reports a missing helper binary', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))
    rmSync(helper.path)
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, sha256: null })
    expect(result.detail).toMatch(/native helper is missing/)
  })

  it('reports a hash mismatch with the actual digest', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper, {
      targets: { 'linux-x64': { sha256: '0'.repeat(64) } },
    }))
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, version: '1.2.3', sha256: helper.sha256 })
    expect(result.detail).toMatch(/native helper hash mismatch/)
  })

  it('compares the manifest digest case-insensitively', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper, {
      targets: { 'linux-x64': { sha256: helper.sha256.toUpperCase() } },
    }))
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root })).toMatchObject({
      available: true,
      version: '1.2.3',
      sha256: helper.sha256,
    })
  })

  it('reports a size mismatch', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper, {
      targets: { 'linux-x64': { sha256: helper.sha256, size: helper.size + 1 } },
    }))
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, sha256: helper.sha256 })
    expect(result.detail).toMatch(/native helper size mismatch/)
  })

  it('reports a probe spawn error', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))
    spawnSyncMock.mockReturnValueOnce({ error: new Error('spawn failed'), status: null, stdout: '', stderr: '' })
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toMatchObject({ available: false, sha256: helper.sha256 })
    expect(result.detail).toBe('spawn failed')
  })

  it('reports a non-zero probe using stderr, stdout or exit status', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))

    spawnSyncMock.mockReturnValueOnce({ error: undefined, status: 2, stdout: '', stderr: 'probe denied' })
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root }).detail).toBe('probe denied')

    spawnSyncMock.mockReturnValueOnce({ error: undefined, status: 2, stdout: 'stdout reason', stderr: '' })
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root }).detail).toBe('stdout reason')

    spawnSyncMock.mockReturnValueOnce({ error: undefined, status: null, stdout: '', stderr: '' })
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root }).detail).toBe('exit null')
  })

  it('reports invalid probe JSON and a probe without landlockAbi', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))

    spawnSyncMock.mockReturnValueOnce({ error: undefined, status: 0, stdout: 'not-json', stderr: '' })
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root }).detail).toMatch(/invalid JSON/)

    spawnSyncMock.mockReturnValueOnce({ error: undefined, status: 0, stdout: '{}', stderr: '' })
    expect(verifyHelper({ platform: 'linux', arch: 'x64', root }).detail).toBe('helper probe returned no landlockAbi')
  })

  it('accepts a verified helper and records the manifest version and digest', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))
    const result = verifyHelper({ platform: 'linux', arch: 'x64', root })
    expect(result).toEqual({
      available: true,
      version: '1.2.3',
      sha256: helper.sha256,
    })
    expect(spawnSyncMock).toHaveBeenCalledWith(helper.path, ['--probe'], expect.objectContaining({ timeout: 5_000 }))
  })
})

describe('native capability detection', () => {
  it('reports no Linux capabilities on Windows and macOS', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const caps = detectCapabilities({ platform, arch: 'x64', root: makeRoot() })
      expect(caps.platform).toBe(platform)
      expect(caps.arch).toBe('x64')
      expect(caps.kernelRelease).toBeNull()
      expect(caps.landlockAbi).toBeNull()
      expect(caps.userNamespaces).toBe(false)
      expect(caps.mountNamespaces).toBe(false)
      expect(caps.networkNamespaces).toBe(false)
      expect(caps.pidNamespaces).toBe(false)
      expect(caps.cgroupV2).toBe(false)
      expect(caps.helper.available).toBe(false)
      expect(caps.runtimeRoots.length).toBeGreaterThan(0)
    }
  })

  it('uses verified helper probe facts on Linux', () => {
    const root = makeRoot()
    const helper = writeHelper(root)
    writeManifest(root, manifestFor(helper))
    const caps = detectCapabilities({ platform: 'linux', arch: 'x64', root })
    expect(caps.platform).toBe('linux')
    expect(caps.helper.available).toBe(true)
    expect(caps.landlockAbi).toBe(3)
    expect(caps.userNamespaces).toBe(true)
    expect(caps.mountNamespaces).toBe(true)
    expect(caps.networkNamespaces).toBe(true)
    expect(caps.pidNamespaces).toBe(true)
  })

  it('reports no namespace capabilities when probing is denied without a helper', () => {
    spawnSyncMock.mockReturnValue({
      error: Object.assign(new Error('unshare unavailable'), { code: 'EPERM' }),
      status: null,
      stdout: '',
      stderr: '',
    })
    const caps = detectCapabilities({ platform: 'linux', arch: 'x64', root: makeRoot() })
    expect(caps.helper.available).toBe(false)
    expect(caps.landlockAbi).toBeNull()
    expect(caps.userNamespaces).toBe(false)
    expect(caps.mountNamespaces).toBe(false)
    expect(caps.networkNamespaces).toBe(false)
    expect(caps.pidNamespaces).toBe(false)
  })

  it('reports namespace capabilities proven by the fallback probe without a helper', () => {
    const caps = detectCapabilities({ platform: 'linux', arch: 'x64', root: makeRoot() })
    expect(caps.helper.available).toBe(false)
    expect(caps.landlockAbi).toBeNull()
    expect(caps.userNamespaces).toBe(true)
    expect(caps.mountNamespaces).toBe(true)
    expect(caps.networkNamespaces).toBe(true)
    expect(caps.pidNamespaces).toBe(true)
  })

  it('rejects an unsupported platform instead of guessing', () => {
    expect(() => detectCapabilities({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64', root: makeRoot() })).toThrow(
      SandboxUnavailableError,
    )
  })
})
