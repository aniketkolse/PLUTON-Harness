import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { ValidationError, WorkspaceError } from '../domain/errors.ts'
import { slugify } from '../domain/ids.ts'
import { firstLine, run, type RunOptions, type RunResult } from '../util/exec.ts'

/**
 * Per-task checkouts (ADR-0005).
 *
 * Guarantees encoded here:
 * - the user's repository is only ever a `git clone` SOURCE; no git command
 *   ever runs inside it (base commits are read from the clone);
 * - one self-contained clone per task under Pluton's workspaces root, on
 *   branch `pluton/<run>/<slug>` (integration checkouts: `pluton/integration/<run>`);
 * - `git clone --local` (hardlinked object store) with an honest fallback to a
 *   full clone when hardlinks are unsupported — never shared worktrees;
 * - every checkout carries a marker inside its own `.git/` dir; removal
 *   refuses any directory without that marker, and any path outside the
 *   workspaces root.
 */

export interface CheckoutRequest {
  /** Absolute path of the source repository (read-only; clone source only). */
  repoPath: string
  kind: 'task-checkout' | 'integration-checkout'
  /** Run id (id-shaped, e.g. `run_…`). */
  runId: string
  /** Human subject; slugified defensively. Ignored for integration checkouts. */
  slug?: string
}

export interface CheckoutInfo {
  path: string
  branch: string
  baseCommit: string
}

export interface CheckoutStatus {
  branch: string
  headCommit: string
  /** `git status --porcelain` lines (bounded output). */
  changes: string[]
}

export interface CheckoutDiff {
  /** `git diff HEAD` (staged + unstaged) against the checkout's HEAD. */
  diff: string
  untracked: string[]
  truncated: boolean
}

interface MarkerFile {
  managed: true
  kind: CheckoutRequest['kind']
  branch: string
  baseCommit: string
  createdAt: string
}

export type WorkspaceRunFn = (argv: string[], options?: RunOptions) => Promise<RunResult>

const RUN_ID_RE = /^[a-z]+_[0-9a-z]+$/
const COMMIT_OPTS = ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost']

export function checkoutBranchName(req: Pick<CheckoutRequest, 'kind' | 'runId' | 'slug'>): string {
  if (!RUN_ID_RE.test(req.runId)) {
    throw new ValidationError(`invalid run id '${req.runId}' for a branch name`)
  }
  if (req.kind === 'integration-checkout') return `pluton/integration/${req.runId}`
  const slug = slugify(req.slug ?? 'task')
  return `pluton/${req.runId}/${slug}`
}

export class GitWorkspaceManager {
  private readonly workspacesRoot: string
  private readonly runFn: WorkspaceRunFn
  private readonly timeoutMs: number

  constructor(opts: { workspacesRoot: string; runFn?: WorkspaceRunFn; timeoutMs?: number }) {
    this.workspacesRoot = resolve(opts.workspacesRoot)
    this.runFn = opts.runFn ?? run
    this.timeoutMs = opts.timeoutMs ?? 120_000
  }

  private git(args: string[], cwd?: string): Promise<RunResult> {
    return this.runFn(['git', ...args], { cwd, timeoutMs: this.timeoutMs, maxOutputBytes: 4 * 1024 * 1024 })
  }

  private markerPath(checkoutPath: string): string {
    return join(checkoutPath, '.git', 'pluton-workspace.json')
  }

  private readMarker(checkoutPath: string): MarkerFile | null {
    try {
      const raw = JSON.parse(readFileSync(this.markerPath(checkoutPath), 'utf8')) as MarkerFile
      return raw.managed === true ? raw : null
    } catch {
      return null
    }
  }

  private assertInsideRoot(path: string, verb: string): void {
    const abs = resolve(path)
    if (abs !== this.workspacesRoot && !abs.startsWith(this.workspacesRoot + sep)) {
      throw new WorkspaceError(`${verb}: '${abs}' is outside Pluton's workspaces root (${this.workspacesRoot})`)
    }
  }

  /** Create one isolated clone; returns the resolved path, branch and base commit. */
  async createCheckout(req: CheckoutRequest & { destName?: string }): Promise<CheckoutInfo> {
    const branch = checkoutBranchName(req)
    const repo = resolve(req.repoPath)
    if (!existsSync(repo)) throw new WorkspaceError(`source repository does not exist: ${repo}`)

    const destName = req.destName ?? slugify(req.slug ?? req.runId)
    const dest = resolve(join(this.workspacesRoot, destName))
    this.assertInsideRoot(dest, 'create checkout')
    if (existsSync(dest)) {
      throw new WorkspaceError(`checkout directory already exists: ${dest} (refusing to overwrite)`)
    }
    mkdirSync(resolve(this.workspacesRoot), { recursive: true })

    const local = await this.git(['clone', '--local', repo, dest])
    if (local.exitCode !== 0 || local.timedOut) {
      // Hardlinks (--local) are unsupported on some filesystems (e.g. across
      // drives/shares). Fall back to a full clone — correct, just slower.
      const hardlinkIssue = /hardlink|different filesystems|failed to copy/i.test(local.stderr)
      if (local.timedOut) {
        throw new WorkspaceError(`git clone timed out after ${this.timeoutMs}ms for ${repo}`)
      }
      if (!hardlinkIssue) {
        throw new WorkspaceError(
          `git clone --local failed (exit ${String(local.exitCode)}): ${firstLine(local.stderr, 300)}`,
          { details: { repo, dest, stderr: local.stderr.slice(0, 2_000) } },
        )
      }
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      const full = await this.git(['clone', repo, dest])
      if (full.exitCode !== 0 || full.timedOut) {
        throw new WorkspaceError(
          `git clone failed (exit ${String(full.exitCode)}): ${firstLine(full.stderr, 300)}`,
          { details: { repo, dest, stderr: full.stderr.slice(0, 2_000) } },
        )
      }
    }

    const head = await this.git(['rev-parse', 'HEAD'], dest)
    if (head.exitCode !== 0) {
      throw new WorkspaceError(`could not read HEAD of fresh clone: ${firstLine(head.stderr, 300)}`)
    }
    const baseCommit = head.stdout.trim()

    const createBranch = await this.git(['checkout', '-b', branch], dest)
    if (createBranch.exitCode !== 0) {
      throw new WorkspaceError(
        `could not create branch '${branch}': ${firstLine(createBranch.stderr, 300)}`,
        { details: { branch, dest, stderr: createBranch.stderr.slice(0, 2_000) } },
      )
    }

    const marker: MarkerFile = {
      managed: true,
      kind: req.kind,
      branch,
      baseCommit,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(this.markerPath(dest), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    return { path: dest, branch, baseCommit }
  }

  /** Branch, HEAD and porcelain status of a managed checkout. */
  async status(checkoutPath: string): Promise<CheckoutStatus> {
    const abs = resolve(checkoutPath)
    this.assertInsideRoot(abs, 'status')
    if (!this.readMarker(abs)) throw new WorkspaceError(`not a Pluton-managed checkout: ${abs}`)
    const head = await this.git(['rev-parse', 'HEAD'], abs)
    if (head.exitCode !== 0) throw new WorkspaceError(`git rev-parse failed in ${abs}: ${firstLine(head.stderr, 300)}`)
    const branchRes = await this.git(['symbolic-ref', '--short', 'HEAD'], abs)
    const porcelain = await this.git(['status', '--porcelain'], abs)
    if (porcelain.exitCode !== 0) {
      throw new WorkspaceError(`git status failed in ${abs}: ${firstLine(porcelain.stderr, 300)}`)
    }
    const changes = porcelain.stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
    return {
      branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : '(detached)',
      headCommit: head.stdout.trim(),
      changes,
    }
  }

  /** Diff of the whole checkout against its own HEAD, plus untracked files. */
  async captureDiff(checkoutPath: string): Promise<CheckoutDiff> {
    const abs = resolve(checkoutPath)
    this.assertInsideRoot(abs, 'diff')
    if (!this.readMarker(abs)) throw new WorkspaceError(`not a Pluton-managed checkout: ${abs}`)
    const diff = await this.git(['diff', 'HEAD'], abs)
    if (diff.exitCode !== 0) throw new WorkspaceError(`git diff failed in ${abs}: ${firstLine(diff.stderr, 300)}`)
    const porcelain = await this.git(['status', '--porcelain'], abs)
    const untracked =
      porcelain.exitCode === 0
        ? porcelain.stdout
            .split(/\r?\n/)
            .filter((l) => l.startsWith('??'))
            .map((l) => l.slice(3).trim())
            .filter((l) => l !== '')
        : []
    return { diff: diff.stdout, untracked, truncated: diff.truncated }
  }

  /**
   * Stage everything and commit inside the checkout. Returns the new commit, or
   * null when there was nothing to commit (not an error for task flows).
   */
  async commitAll(checkoutPath: string, message: string): Promise<{ commit: string | null }> {
    const abs = resolve(checkoutPath)
    this.assertInsideRoot(abs, 'commit')
    if (!this.readMarker(abs)) throw new WorkspaceError(`not a Pluton-managed checkout: ${abs}`)
    if (message.trim() === '') throw new ValidationError('commit message must be non-empty')
    const add = await this.git(['add', '-A'], abs)
    if (add.exitCode !== 0) throw new WorkspaceError(`git add failed: ${firstLine(add.stderr, 300)}`)
    const commit = await this.git([...COMMIT_OPTS, 'commit', '-m', message], abs)
    if (commit.exitCode === 0) {
      const rev = await this.git(['rev-parse', 'HEAD'], abs)
      return { commit: rev.stdout.trim() }
    }
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) return { commit: null }
    throw new WorkspaceError(`git commit failed (exit ${String(commit.exitCode)}): ${firstLine(commit.stderr, 300)}`, {
      details: { stdout: commit.stdout.slice(0, 2_000), stderr: commit.stderr.slice(0, 2_000) },
    })
  }

  /**
   * Remove a managed checkout. Refuses (never forces) when the marker is
   * missing or the path is outside the workspaces root — a user directory must
   * never be deleted by this code path.
   */
  removeCheckout(checkoutPath: string): void {
    const abs = resolve(checkoutPath)
    this.assertInsideRoot(abs, 'remove')
    if (abs === this.workspacesRoot) throw new WorkspaceError('refusing to remove the workspaces root itself')
    const marker = this.readMarker(abs)
    if (!marker) {
      throw new WorkspaceError(
        `refusing to remove '${abs}': no Pluton workspace marker found (only Pluton-created checkouts may be removed)`,
      )
    }
    rmSync(abs, { recursive: true, force: true })
  }
}
