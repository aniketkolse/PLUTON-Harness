import { existsSync, readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Locating the Qwen Code CLI without a shell.
 *
 * Reality verified 2026-10-16 (`@qwen-code/qwen-code` v0.25.2):
 * - npm installs a `qwen` → `cli-entry.js` pair: the `.cmd` shim on Windows
 *   and the shell script on POSIX both exec **node with a JavaScript entry**,
 *   not a standalone executable. `.cmd`/`.sh` files cannot be spawned without
 *   a shell, and Pluton never builds shell strings (prompt §2.7), so the shim
 *   is parsed for its `.js` target and the process is spawned as
 *   `node <cli-entry.js> --acp` (argv array, no shell).
 * - `PLUTON_QWEN_BIN` overrides everything; it may point at the script entry,
 *   an executable, or a shim (documented escape hatch).
 */

export const QWEN_MISSING_FIX =
  'install Qwen Code (Node >= 22; `npm install -g @qwen-code/qwen-code`) so `qwen` is on PATH, or set PLUTON_QWEN_BIN to its cli-entry.js'

export interface QwenInvocation {
  /** Executable to spawn — never a shell (node itself for script entries). */
  command: string
  /** Leading argv before engine args (the script path for node entries). */
  baseArgs: string[]
  /** The resolved artifact (shim/script/executable) — shown by doctor. */
  path: string
  via: 'env' | 'path' | 'cmd-shim'
  entryKind: 'node-script' | 'executable'
}

export type QwenResolution = { ok: true; invocation: QwenInvocation } | { ok: false; fix: string; looked: string[] }

export interface ResolveQwenOptions {
  env: Record<string, string | undefined>
  platform?: NodeJS.Platform
  isFile?: (path: string) => boolean
  readTextFile?: (path: string) => string
  /** Node executable for script entries; defaults to the running node. */
  nodePath?: string
}

function envPath(env: Record<string, string | undefined>): string | undefined {
  return env['PATH'] ?? env['Path'] ?? env['path']
}

function isScriptPath(path: string): boolean {
  return /\.(m?js|cjs)$/i.test(path)
}

function classify(
  path: string,
  via: QwenInvocation['via'],
  nodePath: string,
): QwenInvocation {
  if (isScriptPath(path)) {
    return { command: nodePath, baseArgs: [path], path, via, entryKind: 'node-script' }
  }
  return { command: path, baseArgs: [], path, via, entryKind: 'executable' }
}

/**
 * Extract the real target from an npm-style `.cmd` shim. Qwen shims reference a
 * `.js` entry (`"%_prog%" "%dp0%\..\@qwen-code\qwen-code\cli-entry.js" %*`);
 * `.exe` targets are also understood. Returns the first existing target.
 */
export function parseQwenCmdShim(
  shimPath: string,
  readTextFile: (path: string) => string,
  isFile: (path: string) => boolean,
): string | null {
  let text: string
  try {
    text = readTextFile(shimPath)
  } catch {
    return null
  }
  const shimDir = win32.dirname(shimPath)
  const tokens = text.match(/[^\s"'<>|]+\.(?:exe|js|cjs|mjs)/gi) ?? []
  for (const token of tokens) {
    let candidate = token.replace(/%~dp0/gi, shimDir).replace(/%dp0%/gi, shimDir)
    if (!win32.isAbsolute(candidate)) candidate = win32.join(shimDir, candidate.replace(/^[\\/]+/, ''))
    candidate = win32.normalize(candidate)
    if (isFile(candidate)) return candidate
  }
  return null
}

export function resolveQwenInvocation(opts: ResolveQwenOptions): QwenResolution {
  const platform = opts.platform ?? process.platform
  const isFile = opts.isFile ?? ((p: string) => existsSync(p))
  const readTextFile = opts.readTextFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const nodePath = opts.nodePath ?? process.execPath
  const looked: string[] = []
  const win = platform === 'win32'
  const pathJoin = win ? win32.join : posix.join

  const fromArtifact = (artifact: string, via: QwenInvocation['via']): QwenResolution => {
    if (/\.(cmd|bat)$/i.test(artifact)) {
      const target = parseQwenCmdShim(artifact, readTextFile, isFile)
      if (target) return { ok: true, invocation: classify(target, 'cmd-shim', nodePath) }
      return {
        ok: false,
        fix: `found '${artifact}' but could not identify its node/executable target; reinstall with \`npm install -g @qwen-code/qwen-code\` or set PLUTON_QWEN_BIN`,
        looked: [artifact],
      }
    }
    return { ok: true, invocation: classify(artifact, via, nodePath) }
  }

  const override = opts.env['PLUTON_QWEN_BIN']?.trim()
  if (override) {
    if (isFile(override)) return fromArtifact(override, 'env')
    return {
      ok: false,
      fix: `PLUTON_QWEN_BIN is set to '${override}' but that file does not exist; fix the variable or unset it`,
      looked: [override],
    }
  }

  const pathValue = envPath(opts.env) ?? ''
  const dirs = pathValue.split(win ? ';' : ':').filter((d) => d.trim() !== '')
  const candidates = (dir: string): string[] =>
    win
      ? [pathJoin(dir, 'qwen.cmd'), pathJoin(dir, 'qwen.bat'), pathJoin(dir, 'qwen.exe')]
      : [pathJoin(dir, 'qwen')]

  for (const dir of dirs) {
    for (const candidate of candidates(dir)) {
      looked.push(candidate)
      if (!isFile(candidate)) continue
      const resolved = fromArtifact(candidate, /\.(cmd|bat)$/i.test(candidate) ? 'cmd-shim' : 'path')
      if (resolved.ok) return resolved
    }
  }

  return { ok: false, fix: QWEN_MISSING_FIX, looked }
}
