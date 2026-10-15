import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GitWorkspaceManager, checkoutBranchName } from '../../src/workspace/manager.ts'
import { ValidationError, WorkspaceError } from '../../src/domain/errors.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Workspace tests — real git on throwaway repositories under the OS temp dir.
 * They prove the ADR-0005 contract: clones are independent, the user tree is
 * never modified, removal only ever touches marked Pluton checkouts, and the
 * hardlink fallback is honest.
 */

const created: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function git(args: string[], cwd: string): Promise<void> {
  const r = await run(['git', ...args], { cwd, timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

async function makeRepo(): Promise<string> {
  const repo = tempDir('pluton-ws-repo-')
  await git(['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  await git(['add', '-A'], repo)
  await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', 'init'], repo)
  return repo
}

function makeManager(workspacesRoot: string) {
  return new GitWorkspaceManager({ workspacesRoot })
}

describe('checkoutBranchName', () => {
  it('builds ADR-0005 branch names and slugifies the subject', () => {
    expect(checkoutBranchName({ kind: 'task-checkout', runId: 'run_abc123ff', slug: 'Fix the Login Bug!' })).toBe(
      'pluton/run_abc123ff/fix-the-login-bug',
    )
    expect(checkoutBranchName({ kind: 'integration-checkout', runId: 'run_abc123ff' })).toBe(
      'pluton/integration/run_abc123ff',
    )
    expect(checkoutBranchName({ kind: 'task-checkout', runId: 'run_abc123ff' })).toBe('pluton/run_abc123ff/task')
  })

  it('rejects a run id that could not be a safe branch component', () => {
    expect(() => checkoutBranchName({ kind: 'task-checkout', runId: '../evil', slug: 'x' })).toThrowError(
      ValidationError,
    )
    expect(() => checkoutBranchName({ kind: 'task-checkout', runId: 'run x', slug: 'x' })).toThrowError(
      ValidationError,
    )
  })
})

describe('GitWorkspaceManager (real git)', () => {
  it('clones per task on its own branch and never touches the source repository', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)

    const info = await manager.createCheckout({
      repoPath: repo,
      kind: 'task-checkout',
      runId: 'run_abc123ff',
      slug: 'implement feature',
    })
    expect(info.branch).toBe('pluton/run_abc123ff/implement-feature')
    expect(existsSync(join(info.path, 'README.md'))).toBe(true)
    expect(existsSync(join(info.path, '.git', 'pluton-workspace.json'))).toBe(true)

    const status = await manager.status(info.path)
    expect(status.branch).toBe(info.branch)
    expect(status.changes).toEqual([])
    // baseCommit is the source repository's HEAD (read from the clone).
    const repoHead = await run(['git', 'rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 60_000 })
    expect(info.baseCommit).toBe(repoHead.stdout.trim())

    // Edit inside the checkout: the source repo must stay clean and unchanged.
    writeFileSync(join(info.path, 'README.md'), 'changed in checkout\n')
    const repoStatus = await run(['git', 'status', '--porcelain'], { cwd: repo, timeoutMs: 60_000 })
    expect(repoStatus.stdout.trim()).toBe('')
    expect(readFileSync(join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n')

    // A second checkout for another task is independent.
    const info2 = await manager.createCheckout({
      repoPath: repo,
      kind: 'task-checkout',
      runId: 'run_abc123ff',
      slug: 'other task',
    })
    expect(info2.branch).not.toBe(info.branch)
    expect(readFileSync(join(info2.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n')
  })

  it('captures diffs (modified + untracked) and commits inside the checkout', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'diff task' })

    writeFileSync(join(info.path, 'README.md'), 'hello\nworld\n')
    writeFileSync(join(info.path, 'new-file.txt'), 'new\n')
    const diff = await manager.captureDiff(info.path)
    expect(diff.diff).toMatch(/world/)
    expect(diff.untracked).toContain('new-file.txt')
    expect(diff.truncated).toBe(false)

    const committed = await manager.commitAll(info.path, 'task: add world + file')
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/)
    const after = await manager.captureDiff(info.path)
    expect(after.diff.trim()).toBe('')
    expect(after.untracked).toEqual([])
    const status = await manager.status(info.path)
    expect(status.headCommit).toBe(committed.commit)

    const nothing = await manager.commitAll(info.path, 'task: empty commit')
    expect(nothing.commit).toBeNull()
  })

  it('falls back to a full clone when --local hardlinks are unsupported', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const cloneCalls: string[][] = []
    const manager = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv, options) => {
        if (argv.includes('clone')) cloneCalls.push(argv)
        if (argv.includes('clone') && argv.includes('--local')) {
          return {
            argv,
            exitCode: 128,
            timedOut: false,
            stdout: '',
            stderr: 'fatal: failed to copy objects (hardlink not supported)',
            truncated: false,
            durationMs: 1,
          }
        }
        return run(argv, options)
      },
    })
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'fallback' })
    expect(cloneCalls).toHaveLength(2)
    expect(cloneCalls[0]).toContain('--local')
    expect(cloneCalls[1]).not.toContain('--local')
    expect(existsSync(join(info.path, 'README.md'))).toBe(true)
  })

  it('reports a hard clone failure instead of pretending', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv) => ({
        argv,
        exitCode: 128,
        timedOut: false,
        stdout: '',
        stderr: 'fatal: repository not found',
        truncated: false,
        durationMs: 1,
      }),
    })
    await expect(
      manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'fail' }),
    ).rejects.toThrowError(/git clone --local failed/)
  })

  it('refuses to overwrite an existing checkout directory', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'dup' })
    await expect(
      manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'dup' }),
    ).rejects.toThrowError(/already exists/)
  })
})

describe('GitWorkspaceManager removal guards', () => {
  it('removes a managed checkout but refuses unmanaged directories and paths outside the root', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'remove me' })

    // Unmanaged directory inside the root: refused, still intact.
    const unmanaged = join(root, 'user-dir')
    mkdirSync(unmanaged, { recursive: true })
    writeFileSync(join(unmanaged, 'keep.txt'), 'keep')
    expect(() => manager.removeCheckout(unmanaged)).toThrowError(WorkspaceError)
    expect(existsSync(join(unmanaged, 'keep.txt'))).toBe(true)

    // Outside the root: refused.
    const outside = tempDir('pluton-ws-outside-')
    expect(() => manager.removeCheckout(outside)).toThrowError(/outside Pluton's workspaces root/)

    // The root itself: refused.
    expect(() => manager.removeCheckout(root)).toThrowError(/root itself/)

    // Managed checkout: removed.
    manager.removeCheckout(info.path)
    expect(existsSync(info.path)).toBe(false)
  })
})
