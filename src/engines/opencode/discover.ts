import { existsSync, readFileSync } from 'node:fs'
import { delimiter, posix, win32 } from 'node:path'

/**
 * Locating the `opencode` executable without a shell.
 *
 * Windows reality (verified 2026-10-16): npm's global install puts an
 * `opencode.cmd` shim on PATH that forwards to the real binary at
 * `<npm-prefix>\node_modules\@opencode\cli\bin\opencode.exe`. `.cmd` files
 * cannot be spawned without a shell, and Pluton never builds shell strings
 * (prompt §2.7), so the shim is parsed for its `.exe` target instead.
 * `PLUTON_OPENCODE_BIN` overrides everything (documented escape hatch).
 */

export const OPENCODE_MISSING_FIX =
  'install OpenCode (https://opencode.ai/docs; e.g. `npm install -g @opencode/cli`) so `opencode` is on PATH, or set PLUTON_OPENCODE_BIN to the opencode executable'

export interface OpenCodeBinary {
  path: string
  /** How the binary was found (shown in doctor output). */
  via: 'env' | 'path' | 'cmd-shim'
}

export type OpenCodeResolution =
  | { ok: true; binary: OpenCodeBinary }
  | { ok: false; fix: string; looked: string[] }

export interface ResolveOpenCodeOptions {
  env: Record<string, string | undefined>
  platform?: NodeJS.Platform
  isFile?: (path: string) => boolean
  readTextFile?: (path: string) => string
}

function envPath(env: Record<string, string | undefined>): string | undefined {
  return env['PATH'] ?? env['Path'] ?? env['path']
}

export function resolveOpenCodeBinary(opts: ResolveOpenCodeOptions): OpenCodeResolution {
  const platform = opts.platform ?? process.platform
  const isFile = opts.isFile ?? ((p: string) => existsSync(p))
  const readTextFile =
    opts.readTextFile ??
    ((p: string) => {
      return readFileSync(p, 'utf8')
    })
  const looked: string[] = []

  const override = opts.env['PLUTON_OPENCODE_BIN']?.trim()
  if (override) {
    if (isFile(override)) return { ok: true, binary: { path: override, via: 'env' } }
    return {
      ok: false,
      fix: `PLUTON_OPENCODE_BIN is set to '${override}' but that file does not exist; fix the variable or unset it`,
      looked: [override],
    }
  }

  const pathValue = envPath(opts.env) ?? ''
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter((d) => d.trim() !== '')
  // Resolve with the TARGET platform's path rules, not the host's (tests run
  // on Windows while verifying both platforms).
  const win = platform === 'win32'
  const pathJoin = win ? win32.join : posix.join
  const pathNorm = win ? win32.normalize : posix.normalize
  const pathAbs = win ? win32.isAbsolute : posix.isAbsolute

  const winCandidates = (dir: string): Array<{ path: string; kind: 'exe' | 'shim' }> => [
    { path: pathJoin(dir, 'opencode.exe'), kind: 'exe' },
    { path: pathJoin(dir, 'opencode.cmd'), kind: 'shim' },
    { path: pathJoin(dir, 'opencode.bat'), kind: 'shim' },
  ]
  const posixCandidates = (dir: string): Array<{ path: string; kind: 'exe' }> => [
    { path: pathJoin(dir, 'opencode'), kind: 'exe' },
  ]

  const candidates = win ? winCandidates : posixCandidates

  for (const dir of dirs) {
    for (const candidate of candidates(dir)) {
      looked.push(candidate.path)
      if (!isFile(candidate.path)) continue
      if (candidate.kind === 'exe') return { ok: true, binary: { path: candidate.path, via: 'path' } }
      const target = parseCmdShim(candidate.path, readTextFile, isFile, {
        join: pathJoin,
        normalize: pathNorm,
        isAbsolute: pathAbs,
      })
      if (target) return { ok: true, binary: { path: target, via: 'cmd-shim' } }
    }
  }

  return { ok: false, fix: OPENCODE_MISSING_FIX, looked }
}

export interface ShimPathOps {
  join: (a: string, b: string) => string
  normalize: (p: string) => string
  isAbsolute: (p: string) => boolean
}

/** `.cmd` shims only exist on Windows: win32 path rules are the default. */
const WIN32_PATH_OPS: ShimPathOps = {
  join: (a, b) => win32.join(a, b),
  normalize: (p) => win32.normalize(p),
  isAbsolute: (p) => win32.isAbsolute(p),
}

/**
 * Extract the real executable path from an npm-style `.cmd`/`.bat` shim.
 * Understands `%~dp0` / `%dp0%` (the shim's own directory) and absolute
 * targets. Returns null when no existing `.exe` target can be identified —
 * the caller then reports "install opencode" rather than guessing.
 * Path operations default to win32 rules (`.cmd` shims are a Windows thing).
 */
export function parseCmdShim(
  shimPath: string,
  readTextFile: (path: string) => string,
  isFile: (path: string) => boolean,
  ops: ShimPathOps = WIN32_PATH_OPS,
): string | null {
  let text: string
  try {
    text = readTextFile(shimPath)
  } catch {
    return null
  }
  const shimDir = win32.dirname(shimPath)
  const tokens = text.match(/[^\s"'<>|]+\.exe/gi) ?? []
  for (const token of tokens) {
    let candidate = token.replace(/%~dp0/gi, shimDir).replace(/%dp0%/gi, shimDir)
    // Tokens like `\node_modules\...` after substitution are relative to the shim dir.
    if (!ops.isAbsolute(candidate)) candidate = ops.join(shimDir, candidate.replace(/^[\\/]+/, ''))
    candidate = ops.normalize(candidate)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** PATH-joined display form for doctor/fix messages. */
export function describeLooked(looked: string[]): string {
  return looked.length === 0 ? '(PATH is empty)' : looked.slice(0, 8).join(delimiter)
}

import { assertNonEmptyModel } from '../acp/options.ts'

export { assertNonEmptyModel }
