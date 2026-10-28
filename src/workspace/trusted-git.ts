import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { run, type RunOptions, type RunResult } from '../util/exec.ts'

/**
 * Trusted host-side Git access.
 *
 * A task checkout's `.git` directory, config, attributes, hooks, filters and
 * merge drivers are worker-controlled. Pluton therefore never lets a host Git
 * process use that repository's metadata:
 *
 * - Git runs with a throwaway GIT_DIR whose config is written by Pluton, a
 *   trusted empty hooks/attributes directory, and an explicit environment;
 * - objects and refs are read as data (or through the throwaway GIT_DIR with
 *   GIT_OBJECT_DIRECTORY pointing at the checkout's object store);
 * - worktree content is hashed by `git hash-object --no-filters` and committed
 *   through `update-index`/`write-tree`/`commit-tree`, never `git add/commit`;
 * - integration copies objects and runs the merge under a minimal repository
 *   config, so worker-defined hooks, filters, external diff programs and merge
 *   drivers cannot execute on the host.
 *
 * This module does not claim that a checkout's own Git commands are safe; it
 * only guarantees that Pluton's host-side evidence/commit/integration path is.
 */

const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_OUTPUT = 16 * 1024 * 1024
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_REF_BYTES = 16 * 1024
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024
const MAX_PATH_CHARS = 16 * 1024

export type GitObjectFormat = 'sha1' | 'sha256'

export interface CheckoutIdentity {
  path: string
  gitDir: string
  objectsDir: string
  objectFormat: GitObjectFormat
  head: string
  /** `refs/heads/...` when HEAD is a symbolic ref, null when detached. */
  headRef: string | null
}

export interface TrustedGitView {
  /** Throwaway GIT_DIR (trusted config, empty hooks). */
  dir: string
  /** Normalized path of the checkout this view describes. */
  checkout: string
  identity: CheckoutIdentity
  env: Record<string, string>
  run(args: string[], options?: TrustedGitRunOptions): Promise<RunResult>
  dispose(): void
}

export interface TrustedGitRunOptions {
  timeoutMs?: number
  maxOutputBytes?: number
  /** Override GIT_INDEX_FILE for this command. */
  indexFile?: string | null
  /** Override GIT_WORK_TREE for this command (null = no worktree). */
  workTree?: string | null
}

export interface WorktreeEntry {
  /** Repository-relative path, forward slashes. */
  path: string
  /** Absolute host path. */
  absolute: string
  kind: 'file' | 'symlink'
  /** Git tree mode (100644, 100755 or 120000). */
  mode: string
  stat: Stats
}

export interface SnapshotFile extends WorktreeEntry {
  blob: string
}

export interface RawSnapshot {
  identity: CheckoutIdentity
  /** Commit files: HEAD-tracked paths present in the worktree plus untracked, non-ignored files. */
  files: SnapshotFile[]
  /** Paths excluded from a commit by Git ignore rules but still fingerprinted. */
  ignored: string[]
  tree: string
  headTree: string
  dirty: boolean
  /** Porcelain-style change lines derived from raw trees (never from `git status`). */
  changes: string[]
  /** SHA-256 over every worktree path/mode/blob (including ignored content). */
  contentFingerprint: string
  fingerprint: string
}

function sha256(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

function hashLength(format: GitObjectFormat): number {
  return format === 'sha256' ? 64 : 40
}

function isHash(value: string, format: GitObjectFormat): boolean {
  return new RegExp(`^[0-9a-f]{${String(hashLength(format))}}$`).test(value)
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function readBoundedFile(path: string, maxBytes: number): string {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing non-regular file: ${path}`)
  if (info.size > maxBytes) throw new Error(`file is too large to trust: ${path}`)
  return readFileSync(path, 'utf8')
}

/** Validate one repository-relative path before it reaches the filesystem or Git. */
export function isSafeRepoPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) return false
  if (path.includes('\0')) return false
  if (isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (segment.toLowerCase() === '.git') return false
    if (process.platform === 'win32') {
      if (/[<>:"|?*]/.test(segment)) return false
      if (/[. ]$/.test(segment)) return false
    }
  }
  return true
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const rootAbs = resolve(root)
  const rel = relative(rootAbs, resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes trusted root: ${target}`)
  }
  let current = rootAbs
  if (lstatSync(current).isSymbolicLink()) throw new Error(`trusted root is a symlink: ${root}`)
  for (const segment of rel.split(sep).filter((s) => s !== '')) {
    current = join(current, segment)
    let info: Stats
    try {
      info = lstatSync(current)
    } catch {
      return
    }
    if (info.isSymbolicLink()) throw new Error(`refusing symlinked path component: ${current}`)
  }
}

function parseObjectFormat(configPath: string): { format: GitObjectFormat; version: number; refStorage: string | null } {
  let text: string
  try {
    text = readBoundedFile(configPath, MAX_CONFIG_BYTES)
  } catch {
    return { format: 'sha1', version: 0, refStorage: null }
  }
  let section = ''
  let format: GitObjectFormat = 'sha1'
  let version = 0
  let refStorage: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').toLowerCase()
      continue
    }
    const kv = /^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = (kv[1] ?? '').toLowerCase()
    const value = (kv[2] ?? '').trim()
    if (section === 'extensions' && key === 'objectformat') {
      if (value === 'sha256') format = 'sha256'
      else if (value !== 'sha1') throw new Error(`unsupported Git object format '${value}'`)
    }
    if (section === 'extensions' && key === 'refstorage') refStorage = value.toLowerCase()
    if (section === 'core' && key === 'repositoryformatversion') {
      const parsed = Number.parseInt(value, 10)
      version = Number.isFinite(parsed) ? parsed : 0
    }
  }
  if (version > 1) throw new Error(`unsupported Git repository format version ${String(version)}`)
  if (refStorage !== null && refStorage !== 'files') {
    throw new Error(`unsupported Git ref storage '${refStorage}'`)
  }
  return { format, version, refStorage }
}

function assertSafeCheckout(checkoutPath: string): { path: string; gitDir: string; objectsDir: string; objectFormat: GitObjectFormat } {
  const path = resolve(checkoutPath)
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`checkout is not a real directory: ${path}`)
  const realCheckout = realOrResolved(path)

  const dotGit = join(path, '.git')
  const dotGitInfo = lstatSync(dotGit)
  if (!dotGitInfo.isDirectory() || dotGitInfo.isSymbolicLink()) {
    throw new Error(`.git is not a real directory (worktree/gitdir files are not trusted): ${dotGit}`)
  }
  const realDotGit = realOrResolved(dotGit)
  if (!isInside(realCheckout, realDotGit)) throw new Error(`.git resolves outside the checkout: ${dotGit}`)

  const objects = join(dotGit, 'objects')
  const objectsInfo = lstatSync(objects)
  if (!objectsInfo.isDirectory() || objectsInfo.isSymbolicLink()) {
    throw new Error(`git object store is not a real directory: ${objects}`)
  }
  const realObjects = realOrResolved(objects)
  if (!isInside(realDotGit, realObjects)) throw new Error(`git object store resolves outside .git: ${objects}`)

  // Alternates can redirect object reads outside the checkout; Pluton clones
  // never create them, so their presence is a trust-boundary failure.
  if (existsSync(join(objects, 'info', 'alternates'))) {
    throw new Error('git alternates are not supported in a Pluton checkout')
  }
  if (existsSync(join(dotGit, 'commondir'))) {
    throw new Error('git commondir/worktree layouts are not supported')
  }

  const { format } = parseObjectFormat(join(dotGit, 'config'))
  return { path, gitDir: dotGit, objectsDir: objects, objectFormat: format }
}

function resolveRefFile(gitDir: string, ref: string, depth = 0): string | null {
  if (depth > 8) throw new Error(`symbolic ref nesting is too deep at '${ref}'`)
  if (!ref.startsWith('refs/') || ref.includes('\0') || ref.includes('\\')) return null
  for (const segment of ref.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  const refPath = join(gitDir, ...ref.split('/'))
  assertNoSymlinkComponents(gitDir, refPath)
  if (existsSync(refPath)) {
    const text = readBoundedFile(refPath, MAX_REF_BYTES).trim()
    if (text.startsWith('ref: ')) return resolveRefFile(gitDir, text.slice(5).trim(), depth + 1)
    return text
  }
  const packedPath = join(gitDir, 'packed-refs')
  if (!existsSync(packedPath)) return null
  const packed = readBoundedFile(packedPath, MAX_PACKED_REFS_BYTES)
  for (const line of packed.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#') || line.startsWith('^')) continue
    const match = /^([0-9a-f]{40,64}) (.+)$/.exec(line)
    if (match !== null && match[2] === ref) return match[1] ?? null
  }
  return null
}

/** Read HEAD without running Git. Throws when the checkout's metadata is unsafe or malformed. */
export function readCheckoutIdentity(checkoutPath: string): CheckoutIdentity {
  const safe = assertSafeCheckout(checkoutPath)
  const headPath = join(safe.gitDir, 'HEAD')
  assertNoSymlinkComponents(safe.gitDir, headPath)
  const headText = readBoundedFile(headPath, MAX_REF_BYTES).trim()
  let head: string | null = null
  let headRef: string | null = null
  if (headText.startsWith('ref: ')) {
    headRef = headText.slice(5).trim()
    head = resolveRefFile(safe.gitDir, headRef)
  } else {
    head = headText
  }
  if (head === null) throw new Error(`HEAD ref '${headRef ?? '(detached)'}' does not resolve to a commit`)
  if (!isHash(head, safe.objectFormat)) throw new Error(`HEAD is not a valid ${safe.objectFormat} object id`)
  return {
    path: safe.path,
    gitDir: safe.gitDir,
    objectsDir: safe.objectsDir,
    objectFormat: safe.objectFormat,
    head,
    headRef,
  }
}

/** Resolve a branch tip without running Git or reading repository config. */
export function readBranchTip(checkoutPath: string, branch: string): string {
  const safe = assertSafeCheckout(checkoutPath)
  if (branch === '' || branch.includes('\0') || branch.includes('\\') || branch.startsWith('-')) {
    throw new Error(`invalid branch name '${branch}'`)
  }
  for (const segment of branch.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new Error(`invalid branch name '${branch}'`)
  }
  const tip = resolveRefFile(safe.gitDir, `refs/heads/${branch}`)
  if (tip === null || !isHash(tip, safe.objectFormat)) throw new Error(`branch '${branch}' has no readable tip`)
  return tip
}

function buildTrustedConfig(input: {
  dir: string
  objectFormat: GitObjectFormat
  hooksDir: string
  attributesFile: string
  excludesFile: string
  extraCoreLines?: string[]
}): string {
  return [
    '[core]',
    'repositoryformatversion = 0',
    'bare = false',
    `hooksPath = ${input.hooksDir.replace(/\\/g, '/')}`,
    `attributesFile = ${input.attributesFile.replace(/\\/g, '/')}`,
    `excludesFile = ${input.excludesFile.replace(/\\/g, '/')}`,
    'fsmonitor = false',
    'untrackedCache = false',
    'autocrlf = false',
    'safecrlf = false',
    'logAllRefUpdates = false',
    'symlinks = true',
    ...(input.extraCoreLines ?? []),
    '[diff]',
    'external =',
    'noprefix = false',
    '[merge]',
    'verifySignatures = false',
    '[commit]',
    'gpgsign = false',
    '[tag]',
    'gpgsign = false',
    '[gc]',
    'auto = 0',
    '[maintenance]',
    'auto = false',
    '[fetch]',
    'recurseSubmodules = false',
    '[submodule]',
    'recurse = false',
    '[protocol "file"]',
    'allow = always',
    ...(input.objectFormat === 'sha256' ? ['[extensions]', 'objectformat = sha256'] : []),
    '',
  ].join('\n')
}

/**
 * Read the non-executable `core.*` settings that describe how the existing
 * worktree was checked out. A merge must see the same line-ending/filemode
 * interpretation as the index it is merging into; everything executable
 * (hooks, filters, diff/merge drivers, fsmonitor) stays in Pluton's config.
 *
 * This probe reads configuration only. It deliberately uses the checkout's
 * real GIT_DIR so system/global settings (for example Git for Windows'
 * `core.autocrlf=true`) are preserved, but the trusted merge config never
 * inherits a hook, filter, external diff or merge driver from it.
 */
export interface EffectiveCoreSettings {
  /** Trusted `core.*` lines suitable for the throwaway merge config. */
  lines: string[]
  /** True when Git would normalise CRLF to LF on add. */
  normalizeText: boolean
}

async function readEffectiveCoreSettings(identity: CheckoutIdentity): Promise<EffectiveCoreSettings> {
  const allowed = new Set([
    'autocrlf',
    'eol',
    'safecrlf',
    'filemode',
    'ignorecase',
    'symlinks',
    'protecthfs',
    'protectntfs',
    'precomposeunicode',
  ])
  const env: Record<string, string> = {
    ...platformEnv(),
    GIT_DIR: identity.gitDir,
    GIT_WORK_TREE: identity.path,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C',
  }
  for (const key of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const) {
    const value = process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  const result = await run(
    [
      'git',
      'config',
      '-z',
      '--get-regexp',
      '^core\\.(autocrlf|eol|safecrlf|filemode|ignorecase|symlinks|protecthfs|protectntfs|precomposeunicode)$',
    ],
    {
      cwd: identity.path,
      env,
      envMode: 'explicit',
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    },
  )
  const lines: string[] = []
  let normalizeText = false
  if (result.timedOut || result.exitCode !== 0) return { lines, normalizeText }
  for (const record of result.stdout.split('\0')) {
    const newline = record.indexOf('\n')
    if (newline <= 0) continue
    const key = record.slice(0, newline).toLowerCase()
    const short = key.startsWith('core.') ? key.slice('core.'.length) : key
    const value = record.slice(newline + 1).trim()
    if (!allowed.has(short) || value === '' || /[\0\r\n]/.test(value)) continue
    if (!/^[A-Za-z0-9._/-]+$/.test(value)) continue
    if (short === 'autocrlf') normalizeText = value === 'true' || value === 'input'
    lines.push(`${short} = ${value}`)
  }
  return { lines, normalizeText }
}

function platformEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {}
  const env: Record<string, string> = {}
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const) {
    const value = process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/**
 * Open a throwaway trusted Git view over a checkout.
 *
 * `objectDir` defaults to the checkout's object store. Passing a directory
 * makes Git write new objects there instead (used for throwaway diff trees).
 */
export function openTrustedGit(
  checkoutPath: string,
  opts: {
    objectDir?: string
    alternateObjectDirs?: string[]
    indexFile?: string | null
    workTree?: string | null
  } = {},
): TrustedGitView {
  const identity = readCheckoutIdentity(checkoutPath)
  const dir = mkdtempSync(join(tmpdir(), 'pluton-git-'))
  try {
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    mkdirSync(join(dir, 'home'), { recursive: true })
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    mkdirSync(join(dir, 'objects'), { recursive: true })
    mkdirSync(join(dir, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(dir, 'info'), { recursive: true })
    const attributesFile = join(dir, 'empty-attributes')
    const excludesFile = join(dir, 'empty-excludes')
    writeFileSync(attributesFile, '')
    writeFileSync(excludesFile, '')
    const config = buildTrustedConfig({
      dir,
      objectFormat: identity.objectFormat,
      hooksDir: join(dir, 'hooks'),
      attributesFile,
      excludesFile,
    })
    writeFileSync(join(dir, 'config'), config)
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/pluton-trusted\n')

    const primaryObjects = resolve(opts.objectDir ?? identity.objectsDir)
    const alternate = (opts.alternateObjectDirs ?? []).map((p) => resolve(p))
    const workTree = opts.workTree === null ? null : resolve(opts.workTree ?? identity.path)
    const env: Record<string, string> = {
      ...platformEnv(),
      GIT_DIR: dir,
      GIT_OBJECT_DIRECTORY: primaryObjects,
      ...(alternate.length > 0
        ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate.join(sep === '\\' ? ';' : ':') }
        : {}),
      ...(workTree !== null ? { GIT_WORK_TREE: workTree } : {}),
      ...(opts.indexFile !== undefined && opts.indexFile !== null
        ? { GIT_INDEX_FILE: resolve(opts.indexFile) }
        : {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'config'),
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_AUTHOR_NAME: 'Pluton',
      GIT_AUTHOR_EMAIL: 'pluton@localhost',
      GIT_COMMITTER_NAME: 'Pluton',
      GIT_COMMITTER_EMAIL: 'pluton@localhost',
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'home', '.config'),
      TMPDIR: join(dir, 'tmp'),
      ...(process.platform === 'win32' ? { TEMP: join(dir, 'tmp'), TMP: join(dir, 'tmp') } : {}),
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
    }

    const view: TrustedGitView = {
      dir,
      checkout: identity.path,
      identity,
      env,
      run(args, options = {}) {
        const envOverride = { ...env }
        if (options.indexFile === null) delete envOverride['GIT_INDEX_FILE']
        else if (options.indexFile !== undefined) envOverride['GIT_INDEX_FILE'] = resolve(options.indexFile)
        if (options.workTree === null) delete envOverride['GIT_WORK_TREE']
        else if (options.workTree !== undefined) envOverride['GIT_WORK_TREE'] = resolve(options.workTree)
        return run(['git', ...args], {
          cwd: identity.path,
          env: envOverride,
          envMode: 'explicit',
          timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
          maxOutputBytes: options.maxOutputBytes ?? GIT_MAX_OUTPUT,
        })
      },
      dispose() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
    return view
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

function runOk(result: RunResult, what: string): string {
  if (result.timedOut) throw new Error(`${what} timed out`)
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${String(result.exitCode)}): ${result.stderr.trim().slice(0, 500)}`)
  }
  return result.stdout
}

async function listTree(
  view: TrustedGitView,
  commit: string,
): Promise<Map<string, { mode: string; type: string; blob: string }>> {
  const out = runOk(await view.run(['ls-tree', '-r', '-z', commit]), `git ls-tree ${commit}`)
  const entries = new Map<string, { mode: string; type: string; blob: string }>()
  for (const record of out.split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    if (tab < 0) throw new Error('git ls-tree returned a malformed record')
    const meta = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    if (meta.length !== 3) throw new Error('git ls-tree returned a malformed entry')
    if (!isSafeRepoPath(path)) throw new Error(`git tree contains an unsafe path: ${JSON.stringify(path)}`)
    const mode = meta[0] as string
    const type = meta[1] as string
    const blob = meta[2] as string
    if (type === 'commit' || mode === '160000') {
      throw new Error(`submodule/gitlink '${path}' is not supported by trusted verification`)
    }
    if (type !== 'blob') throw new Error(`unsupported git tree entry '${path}' (${type})`)
    entries.set(path, { mode, type, blob })
  }
  return entries
}

function walkWorktree(checkout: string): WorktreeEntry[] {
  const root = resolve(checkout)
  const out: WorktreeEntry[] = []
  const stack: string[] = ['']
  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const absDir = relDir === '' ? root : join(root, ...relDir.split('/'))
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name
      if (name.toLowerCase() === '.git') continue
      const rel = relDir === '' ? name : `${relDir}/${name}`
      if (!isSafeRepoPath(rel)) throw new Error(`worktree contains an unsafe path: ${JSON.stringify(rel)}`)
      const absolute = join(root, ...rel.split('/'))
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) {
        out.push({ path: rel, absolute, kind: 'symlink', mode: '120000', stat: info })
      } else if (info.isDirectory()) {
        stack.push(rel)
      } else if (info.isFile()) {
        const executable = process.platform !== 'win32' && (info.mode & 0o111) !== 0
        out.push({ path: rel, absolute, kind: 'file', mode: executable ? '100755' : '100644', stat: info })
      } else {
        throw new Error(`unsupported worktree entry type at '${rel}'`)
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

async function checkIgnoredAsync(view: TrustedGitView, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const input = `${paths.join('\0')}\0`
  const result = await run(
    ['git', 'check-ignore', '-z', '--stdin'],
    {
      cwd: view.checkout,
      env: view.env,
      envMode: 'explicit',
      input,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT,
    },
  )
  if (result.timedOut) throw new Error('git check-ignore timed out')
  if (result.exitCode === 1) return new Set()
  if (result.exitCode !== 0) throw new Error(`git check-ignore failed: ${result.stderr.trim().slice(0, 300)}`)
  const ignored = new Set<string>()
  for (const path of result.stdout.split('\0')) if (path !== '') ignored.add(path)
  return ignored
}

async function hashEntries(
  view: TrustedGitView,
  entries: WorktreeEntry[],
  write: boolean,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  const regular = entries.filter((entry) => entry.kind === 'file')
  const symlinks = entries.filter((entry) => entry.kind === 'symlink')
  const batch: WorktreeEntry[] = []
  for (const entry of regular) {
    if (entry.path.includes('\n')) {
      const result = await view.run(
        ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--', entry.path],
      )
      const hash = runOk(result, `git hash-object ${entry.path}`).trim()
      if (hash === '') throw new Error(`git hash-object returned no hash for '${entry.path}'`)
      hashes.set(entry.path, hash)
    } else {
      batch.push(entry)
    }
  }
  if (batch.length > 0) {
    const input = `${batch.map((entry) => entry.path).join('\n')}\n`
    const result = await run(
      ['git', 'hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin-paths'],
      {
        cwd: view.checkout,
        env: view.env,
        envMode: 'explicit',
        input,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT,
      },
    )
    if (result.timedOut) throw new Error('git hash-object timed out')
    const lines = runOk(result, 'git hash-object').split(/\r?\n/).filter((line) => line !== '')
    if (lines.length !== batch.length) throw new Error('git hash-object returned the wrong number of hashes')
    for (let i = 0; i < batch.length; i += 1) hashes.set(batch[i]!.path, lines[i] as string)
  }
  for (const entry of symlinks) {
    // Never read through the link: the blob for a 120000 entry is the link
    // target, and following it would let worker-controlled content make the
    // host read files outside the checkout (and commit their bytes).
    const target = readlinkSync(entry.absolute)
    const result = await run(
      ['git', 'hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin'],
      {
        cwd: view.checkout,
        env: view.env,
        envMode: 'explicit',
        input: target,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT,
      },
    )
    const hash = runOk(result, `git hash-object symlink ${entry.path}`).trim()
    hashes.set(entry.path, hash)
  }
  return hashes
}

interface TextAttributes {
  text: string
  filter: string
}

/**
 * Read `text`/`filter` attributes without executing anything. Attribute files
 * are worker-controlled data; `check-attr` only parses them. The filter value
 * is deliberately informational: Pluton never runs a clean filter, so a path
 * whose Git content depends on one is fingerprinted by its raw bytes.
 */
async function readTextAttributes(
  view: TrustedGitView,
  paths: string[],
): Promise<Map<string, TextAttributes>> {
  const attributes = new Map<string, TextAttributes>()
  if (paths.length === 0) return attributes
  const result = await run(
    ['git', 'check-attr', '-z', '--stdin', 'text', 'filter'],
    {
      cwd: view.checkout,
      env: view.env,
      envMode: 'explicit',
      input: `${paths.join('\0')}\0`,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT,
    },
  )
  if (result.timedOut) throw new Error('git check-attr timed out')
  runOk(result, 'git check-attr')
  const tokens = result.stdout.split('\0')
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const path = tokens[i] as string
    const attr = tokens[i + 1] as string
    const value = tokens[i + 2] as string
    if (path === '') continue
    const current = attributes.get(path) ?? { text: 'unspecified', filter: 'unspecified' }
    if (attr === 'text' || attr === 'filter') current[attr] = value
    attributes.set(path, current)
  }
  return attributes
}

const MAX_NORMALIZE_BYTES = 64 * 1024 * 1024

/**
 * Reproduce Git's CRLF-to-LF clean conversion for text files without running
 * a worker-defined clean filter. This is what makes a Windows checkout with
 * `core.autocrlf=true` report clean instead of every text file as modified.
 * The committed blob is then byte-identical to what normal `git add` would
 * store; raw bytes are still covered by the content fingerprint.
 */
function normalizeWorktreeContent(
  content: Buffer,
  attributes: TextAttributes | undefined,
  enabled: boolean,
): Buffer | null {
  if (!enabled) return null
  if (content.length > MAX_NORMALIZE_BYTES) return null
  const text = attributes?.text ?? 'unspecified'
  if (text === 'unset') return null
  const binary = content.subarray(0, 8000).includes(0)
  if (binary && (text === 'unspecified' || text === 'auto')) return null
  if (!content.includes(13)) return null
  return Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}

interface NormalizedEntry {
  entry: WorktreeEntry
  content: Buffer
}

async function hashNormalizedEntries(
  view: TrustedGitView,
  items: NormalizedEntry[],
  write: boolean,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  if (items.length === 0) return hashes
  const dir = join(view.dir, 'normalized')
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < items.length; i += 1) {
    const file = join(dir, String(i))
    writeFileSync(file, items[i]!.content)
    paths.push(file.replace(/\\/g, '/'))
  }
  const result = await run(
    ['git', 'hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin-paths'],
    {
      cwd: view.checkout,
      env: view.env,
      envMode: 'explicit',
      input: `${paths.join('\n')}\n`,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT,
    },
  )
  if (result.timedOut) throw new Error('git hash-object timed out')
  const lines = runOk(result, 'git hash-object').split(/\r?\n/).filter((line) => line !== '')
  if (lines.length !== items.length) throw new Error('git hash-object returned the wrong number of hashes')
  for (let i = 0; i < items.length; i += 1) hashes.set(items[i]!.entry.path, lines[i] as string)
  return hashes
}

async function writeIndex(view: TrustedGitView, indexFile: string, files: SnapshotFile[]): Promise<string> {  const empty = await view.run(['read-tree', '--empty'], { indexFile })
  runOk(empty, 'git read-tree --empty')
  const simple = files.filter((file) => !file.path.includes('\n') && !file.path.includes('\r'))
  const unusual = files.filter((file) => file.path.includes('\n') || file.path.includes('\r'))
  if (simple.length > 0) {
    const info = simple.map((file) => `${file.mode} ${file.blob}\t${file.path}\n`).join('')
    const result = await run(['git', 'update-index', '--add', '--index-info'], {
      cwd: view.checkout,
      env: { ...view.env, GIT_INDEX_FILE: indexFile },
      envMode: 'explicit',
      input: info,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT,
    })
    runOk(result, 'git update-index --index-info')
  }
  for (const file of unusual) {
    const result = await view.run(
      ['update-index', '--add', '--cacheinfo', `${file.mode},${file.blob},${file.path}`],
      { indexFile },
    )
    runOk(result, `git update-index ${JSON.stringify(file.path)}`)
  }
  const tree = await view.run(['write-tree'], { indexFile })
  return runOk(tree, 'git write-tree').trim()
}

async function revParseTree(view: TrustedGitView, commit: string): Promise<string> {
  return runOk(await view.run(['rev-parse', '--verify', `${commit}^{tree}`]), `git rev-parse ${commit}^{tree}`).trim()
}

async function buildSnapshot(
  view: TrustedGitView,
  checkout: string,
  options: { writeObjects: boolean },
): Promise<RawSnapshot> {
  const identity = view.identity
  const walked = walkWorktree(checkout)
  const headEntries = await listTree(view, identity.head)
  const tracked = new Set(headEntries.keys())
  const untrackedCandidates = walked.filter((entry) => !tracked.has(entry.path)).map((entry) => entry.path)
  const ignored = await checkIgnoredAsync(view, untrackedCandidates)
  const commitEntries = walked.filter((entry) => tracked.has(entry.path) || !ignored.has(entry.path))

  const commitHashes = await hashEntries(view, commitEntries, options.writeObjects)
  const ignoredOnly = walked.filter((entry) => !commitEntries.includes(entry))
  const ignoredHashes = await hashEntries(view, ignoredOnly, false)
  const allHashes = new Map<string, string>([...commitHashes, ...ignoredHashes])
  if (allHashes.size !== walked.length) throw new Error('worktree changed while hashing; refusing evidence capture')

  // A Windows checkout with core.autocrlf=true stores LF in Git but CRLF in
  // the worktree. Reproduce that clean conversion for text files so status,
  // diff and commits see the same content normal `git add` would store. Raw
  // bytes still feed the content fingerprint below.
  const core = await readEffectiveCoreSettings(identity)
  const normalized: NormalizedEntry[] = []
  if (core.normalizeText) {
    const candidates = commitEntries.filter((entry) => entry.kind === 'file')
    const attributes = await readTextAttributes(view, candidates.map((entry) => entry.path))
    for (const entry of candidates) {
      const content = readFileSync(entry.absolute)
      const converted = normalizeWorktreeContent(content, attributes.get(entry.path), true)
      if (converted !== null && !converted.equals(content)) normalized.push({ entry, content: converted })
    }
  }
  const normalizedHashes = await hashNormalizedEntries(view, normalized, options.writeObjects)

  const files: SnapshotFile[] = commitEntries.map((entry) => {
    const blob = normalizedHashes.get(entry.path) ?? commitHashes.get(entry.path)
    if (blob === undefined) throw new Error(`missing blob hash for '${entry.path}'`)
    return { ...entry, blob }
  })
  const indexFile = join(view.dir, 'index')
  const tree = await writeIndex(view, indexFile, files)
  const headTree = await revParseTree(view, identity.head)
  const dirty = tree !== headTree
  const contentFingerprint = sha256([
    'pluton-worktree-content-v1\0',
    ...walked.flatMap((entry) => [entry.path, '\0', entry.mode, '\0', allHashes.get(entry.path) ?? '', '\0']),
  ])
  const fingerprint = sha256([
    'pluton-worktree-v2\0',
    identity.head,
    '\0',
    tree,
    '\0',
    dirty ? 'dirty' : 'clean',
    '\0',
    contentFingerprint,
  ])
  const worktree = new Map(files.map((file) => [file.path, file]))
  const changes: string[] = []
  for (const [path, entry] of headEntries) {
    const current = worktree.get(path)
    if (current === undefined) {
      changes.push(` D ${path}`)
    } else if (current.blob !== entry.blob || current.mode !== entry.mode) {
      changes.push(` M ${path}`)
    }
  }
  for (const file of files) {
    if (!headEntries.has(file.path)) changes.push(`?? ${file.path}`)
  }
  changes.sort((a, b) => (a.slice(3) < b.slice(3) ? -1 : a.slice(3) > b.slice(3) ? 1 : 0))
  return {
    identity,
    files,
    ignored: [...ignored].sort(),
    tree,
    headTree,
    dirty,
    changes,
    contentFingerprint,
    fingerprint,
  }
}

/** Open a view that writes new objects to a disposable store, reading the checkout's as an alternate. */
function openSnapshotView(checkoutPath: string): { view: TrustedGitView; objectDir: string } {
  const identity = readCheckoutIdentity(checkoutPath)
  const objectDir = mkdtempSync(join(tmpdir(), 'pluton-git-objects-'))
  try {
    const view = openTrustedGit(checkoutPath, {
      objectDir,
      alternateObjectDirs: [identity.objectsDir],
    })
    return { view, objectDir }
  } catch (error) {
    rmSync(objectDir, { recursive: true, force: true })
    throw error
  }
}

/** Capture raw worktree evidence without executing repository metadata. */
export async function captureRawSnapshot(checkoutPath: string): Promise<RawSnapshot> {
  const { view, objectDir } = openSnapshotView(checkoutPath)
  try {
    return await buildSnapshot(view, view.checkout, { writeObjects: true })
  } finally {
    view.dispose()
    rmSync(objectDir, { recursive: true, force: true })
  }
}

/** Generate the raw diff between HEAD and the current worktree (including untracked files). */
export async function captureRawDiff(
  checkoutPath: string,
): Promise<{ diff: string; untracked: string[]; truncated: boolean }> {
  const { view, objectDir } = openSnapshotView(checkoutPath)
  try {
    const snapshot = await buildSnapshot(view, view.checkout, { writeObjects: true })
    const headEntries = await listTree(view, view.identity.head)
    const untracked = snapshot.files
      .filter((file) => !headEntries.has(file.path))
      .map((file) => file.path)
      .sort()
    const result = await view.run(
      ['diff-tree', '--no-ext-diff', '--no-textconv', '--no-color', '-p', view.identity.head, snapshot.tree],
    )
    const diff = runOk(result, 'git diff-tree')
    return { diff, untracked, truncated: result.truncated }
  } finally {
    view.dispose()
    rmSync(objectDir, { recursive: true, force: true })
  }
}

/**
 * Patch and plain changed-file list between a verified base commit and the
 * LIVE worktree (uncommitted edits and untracked files included), generated in
 * the disposable trusted view. This is the diff the independent verifier sees:
 * it must describe exactly the content the checks ran against, not only what
 * the worker happened to commit.
 */
export async function diffWorktreePatch(
  checkoutPath: string,
  from: string,
  opts: TrustedGitRunOptions = {},
): Promise<{ diff: string; files: string[]; head: string; truncated: boolean }> {
  const identity = readCheckoutIdentity(checkoutPath)
  const value = from === 'HEAD' ? identity.head : from
  if (!isHash(value, identity.objectFormat)) throw new Error(`commit id is invalid: ${from}`)
  const { view, objectDir } = openSnapshotView(checkoutPath)
  try {
    const snapshot = await buildSnapshot(view, view.checkout, { writeObjects: true })
    const result = await view.run(
      ['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-color', '-p', '-r', value, snapshot.tree],
      opts,
    )
    return {
      diff: runOk(result, 'git diff-tree -p'),
      files: snapshot.changes.map((change) => change.slice(3)),
      head: snapshot.identity.head,
      truncated: result.truncated,
    }
  } finally {
    view.dispose()
    rmSync(objectDir, { recursive: true, force: true })
  }
}

/**
 * Stat and change list between a verified base commit and the live worktree
 * (uncommitted edits and untracked files included), computed in the disposable
 * trusted view. Repository-owned diff drivers, textconv and filters never run.
 */
export async function diffWorktreeStat(
  checkoutPath: string,
  from: string,
  opts: TrustedGitRunOptions = {},
): Promise<{ stat: string; changes: string[]; head: string; truncated: boolean }> {
  const identity = readCheckoutIdentity(checkoutPath)
  const value = from === 'HEAD' ? identity.head : from
  if (!isHash(value, identity.objectFormat)) throw new Error(`commit id is invalid: ${from}`)
  const { view, objectDir } = openSnapshotView(checkoutPath)
  try {
    const snapshot = await buildSnapshot(view, view.checkout, { writeObjects: true })
    const result = await view.run(
      ['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--stat', '-r', value, snapshot.tree],
      opts,
    )
    return {
      stat: runOk(result, 'git diff-tree --stat'),
      changes: snapshot.changes,
      head: snapshot.identity.head,
      truncated: result.truncated,
    }
  } finally {
    view.dispose()
    rmSync(objectDir, { recursive: true, force: true })
  }
}

export interface RawCommitResult {
  commit: string | null
  snapshot: RawSnapshot
}

/** Commit the raw worktree through plumbing; no hooks, filters or merge drivers run. */
export async function commitRaw(
  checkoutPath: string,
  message: string,
  opts: { expectedFingerprint?: string } = {},
): Promise<RawCommitResult> {
  if (typeof message !== 'string' || message.trim() === '' || message.includes('\0')) {
    throw new Error('commit message must be non-empty and must not contain NUL')
  }
  if (opts.expectedFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(opts.expectedFingerprint)) {
    throw new Error('expected worktree fingerprint is malformed')
  }
  const identity = readCheckoutIdentity(checkoutPath)
  if (identity.headRef === null || !identity.headRef.startsWith('refs/heads/')) {
    throw new Error('refusing to commit a detached HEAD in a Pluton checkout')
  }
  const view = openTrustedGit(checkoutPath)
  try {
    const snapshot = await buildSnapshot(view, view.checkout, { writeObjects: true })
    if (opts.expectedFingerprint !== undefined && snapshot.fingerprint !== opts.expectedFingerprint) {
      throw new Error('worktree changed after verification; refusing to commit unverified content')
    }
    if (snapshot.tree === snapshot.headTree) return { commit: null, snapshot }

    const commitResult = await view.run([
      '-c',
      'user.name=Pluton',
      '-c',
      'user.email=pluton@localhost',
      'commit-tree',
      snapshot.tree,
      '-p',
      identity.head,
      '-m',
      message,
    ])
    const commit = runOk(commitResult, 'git commit-tree').trim()
    if (!isHash(commit, identity.objectFormat)) throw new Error('git commit-tree returned an invalid commit id')

    // The worktree must not change between the tree we hashed and the ref we
    // update. Re-take the snapshot and require exact tree equality.
    const verify = await buildSnapshot(view, view.checkout, { writeObjects: false })
    if (verify.tree !== snapshot.tree) throw new Error('worktree changed while committing; refusing to move the ref')

    writeLooseRef(identity, commit)
    copyIndex(view, join(view.dir, 'index'), join(identity.gitDir, 'index'))
    return { commit, snapshot }
  } finally {
    view.dispose()
  }
}

function writeLooseRef(identity: CheckoutIdentity, commit: string): void {
  const ref = identity.headRef
  if (ref === null || !ref.startsWith('refs/heads/')) throw new Error('cannot update a non-branch HEAD')
  if (!isHash(commit, identity.objectFormat)) throw new Error('invalid commit id for ref update')
  const refPath = join(identity.gitDir, ...ref.split('/'))
  assertNoSymlinkComponents(identity.gitDir, join(identity.gitDir, 'refs'))
  mkdirSync(dirname(refPath), { recursive: true })
  assertNoSymlinkComponents(identity.gitDir, dirname(refPath))
  if (existsSync(refPath)) {
    const info = lstatSync(refPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing to replace non-regular ref: ${refPath}`)
  }
  const lock = `${refPath}.lock`
  if (existsSync(lock)) throw new Error(`ref lock already exists: ${lock}`)
  writeFileSync(lock, `${commit}\n`, { flag: 'wx', mode: 0o600 })
  try {
    try {
      renameSync(lock, refPath)
    } catch (error) {
      if (process.platform !== 'win32') throw error
      rmSync(refPath, { force: true })
      renameSync(lock, refPath)
    }
  } finally {
    rmSync(lock, { force: true })
  }
}

function copyIndex(view: TrustedGitView, from: string, to: string): void {
  if (!existsSync(from)) return
  assertNoSymlinkComponents(view.identity.gitDir, to)
  if (existsSync(to)) {
    const info = lstatSync(to)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`refusing to replace non-regular index: ${to}`)
  }
  const temp = `${to}.pluton-new`
  copyFileSync(from, temp)
  try {
    try {
      renameSync(temp, to)
    } catch (error) {
      if (process.platform !== 'win32') throw error
      rmSync(to, { force: true })
      renameSync(temp, to)
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Copy source object files into an integration object store as data (no Git process). */
export function copyObjectsAsData(sourceCheckout: string, targetCheckout: string): void {
  const source = assertSafeCheckout(sourceCheckout)
  const target = assertSafeCheckout(targetCheckout)
  const stack: string[] = ['']
  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const sourceDir = relDir === '' ? source.objectsDir : join(source.objectsDir, ...relDir.split('/'))
    const targetDir = relDir === '' ? target.objectsDir : join(target.objectsDir, ...relDir.split('/'))
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const from = join(sourceDir, entry.name)
      const info = lstatSync(from)
      if (info.isSymbolicLink()) throw new Error(`refusing symlinked object store entry: ${from}`)
      if (rel === 'info/alternates' || rel === 'info/grafts') {
        throw new Error(`refusing unsafe git object metadata '${rel}'`)
      }
      if (info.isDirectory()) {
        stack.push(rel)
        continue
      }
      if (!info.isFile()) throw new Error(`unsupported git object store entry: ${from}`)
      const to = join(targetDir, entry.name)
      mkdirSync(dirname(to), { recursive: true })
      if (!existsSync(to)) copyFileSync(from, to)
    }
  }
}

/** All object ids referenced by one commit, for an integrity check after a copy. */
export async function verifyCommitAvailable(checkoutPath: string, commit: string): Promise<void> {
  const view = openTrustedGit(checkoutPath, { workTree: null })
  try {
    const result = await view.run(['cat-file', '-e', `${commit}^{commit}`])
    if (result.exitCode !== 0) throw new Error(`commit ${commit} is not available in the object store`)
  } finally {
    view.dispose()
  }
}

/** Diff two commits with plumbing only (no external diff, textconv or filters). */
export async function diffTrees(
  checkoutPath: string,
  from: string,
  to: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const identity = readCheckoutIdentity(checkoutPath)
  const resolveCommit = (ref: string): string => {
    const value = ref === 'HEAD' ? identity.head : ref
    if (!isHash(value, identity.objectFormat)) throw new Error(`commit id is invalid: ${ref}`)
    return value
  }
  const fromCommit = resolveCommit(from)
  const toCommit = resolveCommit(to)
  const view = openTrustedGit(checkoutPath, { workTree: null })
  try {
    const result = await view.run([
      'diff-tree',
      '--no-commit-id',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-r',
      '-M',
      '-z',
      fromCommit,
      toCommit,
    ])
    const out = runOk(result, 'git diff-tree --name-status')
    return { files: parseNameStatus(out), truncated: result.truncated }
  } finally {
    view.dispose()
  }
}

function parseNameStatus(out: string): string[] {
  const tokens = out.split('\0').filter((token) => token !== '')
  const files: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i] as string
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push(tokens[i + 1] as string, tokens[i + 2] as string)
      i += 2
    } else {
      files.push(tokens[i + 1] as string)
      i += 1
    }
  }
  return files
}

function commitPair(checkoutPath: string, from: string, to: string): {
  identity: CheckoutIdentity
  fromCommit: string
  toCommit: string
} {
  const identity = readCheckoutIdentity(checkoutPath)
  const resolveCommit = (ref: string): string => {
    const value = ref === 'HEAD' ? identity.head : ref
    if (!isHash(value, identity.objectFormat)) throw new Error(`commit id is invalid: ${ref}`)
    return value
  }
  return { identity, fromCommit: resolveCommit(from), toCommit: resolveCommit(to) }
}

/**
 * Patch and changed-file list between two commits, generated by plumbing in a
 * trusted Git view. Worker-controlled `.git/config` (external diff, textconv,
 * filters) is never consulted, so rendering a diff cannot execute code.
 */
export async function diffCommitPatch(
  checkoutPath: string,
  from: string,
  to: string,
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const { fromCommit, toCommit } = commitPair(checkoutPath, from, to)
  const view = openTrustedGit(checkoutPath, { workTree: null })
  try {
    const names = await view.run([
      'diff-tree',
      '--no-commit-id',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-r',
      '-M',
      '-z',
      fromCommit,
      toCommit,
    ])
    const files = parseNameStatus(runOk(names, 'git diff-tree --name-status'))
    const patch = await view.run([
      'diff-tree',
      '--no-commit-id',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '-p',
      '-r',
      fromCommit,
      toCommit,
    ])
    return {
      diff: runOk(patch, 'git diff-tree -p'),
      files,
      truncated: names.truncated || patch.truncated,
    }
  } finally {
    view.dispose()
  }
}

/** `--stat` between two commits through plumbing (no textconv/external diff). */
export async function diffTreeStat(
  checkoutPath: string,
  from: string,
  to: string,
): Promise<{ stat: string; truncated: boolean }> {
  const { fromCommit, toCommit } = commitPair(checkoutPath, from, to)
  const view = openTrustedGit(checkoutPath, { workTree: null })
  try {
    const result = await view.run([
      'diff-tree',
      '--no-commit-id',
      '--no-ext-diff',
      '--no-textconv',
      '--stat',
      '-r',
      fromCommit,
      toCommit,
    ])
    return { stat: runOk(result, 'git diff-tree --stat'), truncated: result.truncated }
  } finally {
    view.dispose()
  }
}

/** Bounded one-line log between two commits through a trusted Git view. */
export async function logOneline(
  checkoutPath: string,
  from: string,
  to: string,
  maxCount = 50,
): Promise<{ log: string; truncated: boolean }> {
  const { fromCommit, toCommit } = commitPair(checkoutPath, from, to)
  const bounded = Math.max(1, Math.min(500, Math.floor(maxCount)))
  const view = openTrustedGit(checkoutPath, { workTree: null })
  try {
    const result = await view.run([
      'log',
      '--oneline',
      '--no-decorate',
      `--max-count=${String(bounded)}`,
      `${fromCommit}..${toCommit}`,
    ])
    return { log: runOk(result, 'git log --oneline'), truncated: result.truncated }
  } finally {
    view.dispose()
  }
}

export interface MergeResult {
  status: 'merged' | 'already_integrated' | 'conflict' | 'failed'
  commit: string | null
  conflicts: string[]
  detail: string | null
}

/**
 * Merge a source commit into an integration checkout.
 *
 * The source commit object must already be present in the integration object
 * store (see copyObjectsAsData). The integration repository's config is
 * replaced with a trusted minimal config for the duration of the merge, so
 * worker-defined merge drivers, hooks and filters cannot execute. The original
 * config is restored in a finally block.
 */
export async function mergeCommitTrusted(
  integrationPath: string,
  sourceCommit: string,
  message: string,
): Promise<MergeResult> {
  if (message.trim() === '' || message.includes('\0')) throw new Error('merge message must be non-empty')
  const identity = readCheckoutIdentity(integrationPath)
  if (identity.headRef === null || !identity.headRef.startsWith('refs/heads/')) {
    return { status: 'failed', commit: null, conflicts: [], detail: 'integration checkout HEAD is detached' }
  }
  if (!isHash(sourceCommit, identity.objectFormat)) {
    return { status: 'failed', commit: null, conflicts: [], detail: 'source commit id is invalid' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'pluton-merge-'))
  const configPath = join(identity.gitDir, 'config')
  const backupPath = join(identity.gitDir, 'config.pluton-trusted-backup')
  let configReplaced = false
  try {
    if (existsSync(backupPath)) throw new Error(`stale trusted-merge config backup exists: ${backupPath}`)
    const originalInfo = lstatSync(configPath)
    if (!originalInfo.isFile() || originalInfo.isSymbolicLink()) {
      throw new Error(`repository config is not a regular file: ${configPath}`)
    }
    const originalMode = originalInfo.mode & 0o777
    const coreLines = (await readEffectiveCoreSettings(identity)).lines
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    mkdirSync(join(dir, 'home'), { recursive: true })
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    const attributesFile = join(dir, 'empty-attributes')
    const excludesFile = join(dir, 'empty-excludes')
    writeFileSync(attributesFile, '')
    writeFileSync(excludesFile, '')
    const config = buildTrustedConfig({
      dir,
      objectFormat: identity.objectFormat,
      hooksDir: join(dir, 'hooks'),
      attributesFile,
      excludesFile,
      extraCoreLines: coreLines,
    })
    renameSync(configPath, backupPath)
    writeFileSync(configPath, config, { mode: originalMode })
    configReplaced = true

    const env: Record<string, string> = {
      ...platformEnv(),
      GIT_DIR: identity.gitDir,
      GIT_WORK_TREE: identity.path,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(dir, 'config'),
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_AUTHOR_NAME: 'Pluton',
      GIT_AUTHOR_EMAIL: 'pluton@localhost',
      GIT_COMMITTER_NAME: 'Pluton',
      GIT_COMMITTER_EMAIL: 'pluton@localhost',
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'home', '.config'),
      TMPDIR: join(dir, 'tmp'),
      ...(process.platform === 'win32' ? { TEMP: join(dir, 'tmp'), TMP: join(dir, 'tmp') } : {}),
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
    }
    const git = (args: string[], options: { input?: string } = {}): Promise<RunResult> =>
      run(['git', ...args], {
        cwd: identity.path,
        env,
        envMode: 'explicit',
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT,
        ...(options.input !== undefined ? { input: options.input } : {}),
      })

    const ancestor = await git(['merge-base', '--is-ancestor', sourceCommit, identity.head])
    if (ancestor.exitCode === 0) {
      return { status: 'already_integrated', commit: sourceCommit, conflicts: [], detail: null }
    }
    const merge = await git([
      '-c',
      'user.name=Pluton',
      '-c',
      'user.email=pluton@localhost',
      'merge',
      '--no-ff',
      '-m',
      message,
      sourceCommit,
    ])
    if (merge.exitCode === 0) {
      const rev = await git(['rev-parse', '--verify', 'HEAD'])
      const commit = rev.exitCode === 0 ? rev.stdout.trim() : ''
      if (!isHash(commit, identity.objectFormat)) {
        return { status: 'failed', commit: null, conflicts: [], detail: 'merge succeeded but HEAD is unreadable' }
      }
      return { status: 'merged', commit, conflicts: [], detail: null }
    }
    const unmerged = await git(['ls-files', '-u', '-z'])
    const conflicts = unmerged.exitCode === 0
      ? [...new Set(unmerged.stdout.split('\0').map((entry) => {
          const tab = entry.indexOf('\t')
          return tab >= 0 ? entry.slice(tab + 1) : ''
        }).filter((entry) => entry !== ''))].sort()
      : []
    if (conflicts.length > 0) return { status: 'conflict', commit: null, conflicts, detail: null }
    const detail = merge.timedOut
      ? `git merge timed out after ${String(GIT_TIMEOUT_MS)}ms`
      : merge.stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 300) || `git merge failed (exit ${String(merge.exitCode)})`
    return { status: 'failed', commit: null, conflicts: [], detail }
  } finally {
    if (configReplaced) {
      try {
        rmSync(configPath, { force: true })
        if (existsSync(backupPath)) renameSync(backupPath, configPath)
      } catch {
        // The original config remains at the backup path; callers fail closed
        // because the next integration sees the stale backup and refuses.
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Return unmerged index paths from the checkout's own index as data. */
export async function unmergedPaths(checkoutPath: string): Promise<string[]> {
  const identity = readCheckoutIdentity(checkoutPath)
  const indexFile = join(identity.gitDir, 'index')
  if (!existsSync(indexFile)) return []
  const view = openTrustedGit(checkoutPath, { indexFile })
  try {
    const result = await view.run(['ls-files', '-u', '-z'])
    if (result.exitCode !== 0) return []
    return [...new Set(result.stdout.split('\0').map((entry) => {
      const tab = entry.indexOf('\t')
      return tab >= 0 ? entry.slice(tab + 1) : ''
    }).filter((entry) => entry !== ''))].sort()
  } finally {
    view.dispose()
  }
}
