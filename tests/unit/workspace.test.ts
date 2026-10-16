import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function gitOut(args: string[], cwd: string): Promise<string> {
  const r = await run(['git', ...args], { cwd, timeoutMs: 60_000 })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
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

/** Let a spawned helper process die before temp-dir cleanup runs. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
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

  it('rejects a destName that resolves to the workspaces root itself', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)

    for (const destName of ['', '.']) {
      await expect(
        manager.createCheckout({
          repoPath: repo,
          kind: 'task-checkout',
          runId: 'run_abc123ff',
          slug: 'root guard',
          destName,
        }),
      ).rejects.toThrowError(/destName must name a subdirectory of the workspaces root/)
    }

    // Nothing was cloned into the workspaces root itself.
    expect(readdirSync(root)).toEqual([])
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('removes the half-built clone when the source has no commit to base on', async () => {
    const source = tempDir('pluton-ws-empty-')
    await git(['init', '-b', 'main'], source)
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)

    const dest = join(root, 'unborn-head')
    await expect(
      manager.createCheckout({
        repoPath: source,
        kind: 'task-checkout',
        runId: 'run_abc123ff',
        destName: 'unborn-head',
      }),
    ).rejects.toThrowError(/could not read HEAD/)
    expect(existsSync(dest)).toBe(false)
  })

  it('removes the clone when the expected checkout branch was not created', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv, options) => {
        if (argv[1] === 'rev-parse' && argv[2] === '--verify') {
          return {
            argv,
            exitCode: 1,
            timedOut: false,
            stdout: '',
            stderr: 'fatal: needed a single revision',
            truncated: false,
            durationMs: 1,
          }
        }
        return run(argv, options)
      },
    })

    const dest = join(root, 'missing-branch')
    await expect(
      manager.createCheckout({
        repoPath: repo,
        kind: 'task-checkout',
        runId: 'run_abc123ff',
        destName: 'missing-branch',
      }),
    ).rejects.toThrowError(/branch 'pluton\/run_abc123ff\/task' was not created/)
    expect(existsSync(dest)).toBe(false)
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

  it('throws a typed error when git status fails during diff capture instead of dropping untracked files', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv, options) => {
        if (argv[1] === 'status') {
          return {
            argv,
            exitCode: 128,
            timedOut: false,
            stdout: '',
            stderr: 'fatal: index file corrupt',
            truncated: false,
            durationMs: 1,
          }
        }
        return run(argv, options)
      },
    })
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'status fail' })
    writeFileSync(join(info.path, 'untracked.txt'), 'new\n')

    const error = await manager.captureDiff(info.path).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(WorkspaceError)
    const workspaceError = error as WorkspaceError
    expect(workspaceError.message).toMatch(/git status failed/)
    expect(workspaceError.details).toMatchObject({ path: info.path })
  })

  // Real-world wording varies: git says "failed to copy"/"hardlink" when the
  // --local object copy aborts, "failed to link"/"could not create link" on
  // link() failures, and "cross-device"/EXDEV when the copy crosses mounts.
  it.each([
    'fatal: failed to copy objects (hardlink not supported)',
    'error: failed to link objects/ab/cdef -> objects/ab/cdef: Operation not permitted',
    "fatal: could not create link 'src' -> 'dst': Invalid cross-device link",
    'fatal: copy-fd: Invalid cross-device link (EXDEV)',
  ])('falls back to a full clone when --local aborts with a hardlink-style error: %s', async (stderr) => {
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
            stderr,
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

  it('does not attempt a fallback for unrelated clone failures', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const cloneCalls: string[][] = []
    const manager = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv, options) => {
        if (argv.includes('clone')) {
          cloneCalls.push(argv)
          return {
            argv,
            exitCode: 128,
            timedOut: false,
            stdout: '',
            stderr: 'fatal: repository not found',
            truncated: false,
            durationMs: 1,
          }
        }
        return run(argv, options)
      },
    })
    await expect(
      manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'fail' }),
    ).rejects.toThrowError(/git clone --local failed/)
    expect(cloneCalls).toHaveLength(1)
  })

  it('refuses to overwrite an existing checkout directory and points at destName', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'dup' })
    const clash = manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'dup' })
    await expect(clash).rejects.toThrowError(WorkspaceError)
    await expect(clash).rejects.toThrowError(/already exists/)
    await expect(clash).rejects.toThrowError(/unique destName/)
  })

  it('rejects with a typed error when the checkout index is corrupt (real git failure)', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'corrupt index' })
    writeFileSync(join(info.path, '.git', 'index'), 'garbage bytes, not a git index')

    const error = await manager.captureDiff(info.path).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(WorkspaceError)
    // On this host git fails the corrupt index for `git diff HEAD` first
    // (captureDiff runs diff before status), so this pins the typed rejection;
    // the status-only branch is pinned by the injected-failure test above.
    expect((error as Error).message).toMatch(/git (diff|status) failed/)
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

  // Windows-only: a process's working directory holds a directory handle, so
  // rmSync fails with EPERM/EBUSY while a live child has its cwd inside the
  // checkout — the same shape as a sandbox still binding a mounted checkout.
  // POSIX permits removing a directory that is some process's cwd, so there
  // this failure is not inducible from Node and the case is skipped.
  it.runIf(process.platform === 'win32')('wraps filesystem removal failures in a typed WorkspaceError', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const info = await manager.createCheckout({ repoPath: repo, kind: 'task-checkout', runId: 'run_abc123ff', slug: 'busy' })

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      cwd: info.path,
      stdio: 'ignore',
    })
    await once(child, 'spawn')
    try {
      let error: unknown = null
      try {
        manager.removeCheckout(info.path)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(WorkspaceError)
      const workspaceError = error as WorkspaceError
      expect(workspaceError.message).toMatch(/failed to remove checkout/)
      expect(workspaceError.details).toMatchObject({ path: info.path })
      expect(String((workspaceError.details as { code: unknown }).code)).toMatch(/EBUSY|EPERM|ENOTEMPTY/)
    } finally {
      await stopChild(child)
      try {
        rmSync(info.path, { recursive: true, force: true })
      } catch {
        // afterAll retries once the child is gone.
      }
    }
  })
})

describe('GitWorkspaceManager integration primitives (real git)', () => {
  /** One task checkout plus one integration checkout, both based on the repo HEAD. */
  async function makePair(manager: GitWorkspaceManager, repo: string) {
    const task = await manager.createCheckout({
      repoPath: repo,
      kind: 'task-checkout',
      runId: 'run_abc123ff',
      slug: 'integration task',
    })
    const integration = await manager.createCheckout({
      repoPath: repo,
      kind: 'integration-checkout',
      runId: 'run_abc123ff',
    })
    return { task, integration }
  }

  it('lists committed files between two commits and refuses unmanaged paths', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const { task } = await makePair(manager, repo)

    expect(await manager.changedFiles(task.path, task.baseCommit)).toEqual([])
    writeFileSync(join(task.path, 'README.md'), 'hello\nworld\n')
    writeFileSync(join(task.path, 'new-file.txt'), 'new\n')
    await manager.commitAll(task.path, 'task: two files')

    const files = await manager.changedFiles(task.path, task.baseCommit)
    expect([...files].sort()).toEqual(['README.md', 'new-file.txt'])
    expect(await manager.changedFiles(task.path, 'HEAD')).toEqual([])

    const outside = tempDir('pluton-ws-outside-')
    await expect(manager.changedFiles(outside, 'HEAD')).rejects.toThrowError(
      /outside Pluton's workspaces root/,
    )
    await expect(manager.changedFiles(root, 'HEAD')).rejects.toThrowError(/not a Pluton-managed checkout/)
  })

  it('merges a diverged task branch with --no-ff and reports already_integrated on rerun', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const { task, integration } = await makePair(manager, repo)

    writeFileSync(join(task.path, 'feature.txt'), 'feature work\n')
    const committed = await manager.commitAll(task.path, 'task: add feature')
    expect(committed.commit).not.toBeNull()

    const opts = {
      checkoutPath: integration.path,
      sourcePath: task.path,
      sourceBranch: task.branch,
      message: 'pluton: merge integration task',
    }
    const merged = await manager.integrateBranch(opts)
    expect(merged.status).toBe('merged')
    expect(merged.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(merged.conflicts).toEqual([])
    expect(merged.detail).toBeNull()

    // A merge commit with two parents proves --no-ff was used.
    const parents = (await gitOut(['rev-list', '--parents', '-n', '1', 'HEAD'], integration.path))
      .trim()
      .split(/\s+/)
    expect(parents).toHaveLength(3)
    expect(parents[0]).toBe(merged.commit)
    expect(existsSync(join(integration.path, 'feature.txt'))).toBe(true)
    expect(existsSync(join(integration.path, '.git', 'MERGE_HEAD'))).toBe(false)

    const headAfterMerge = (await gitOut(['rev-parse', 'HEAD'], integration.path)).trim()
    const again = await manager.integrateBranch(opts)
    expect(again.status).toBe('already_integrated')
    expect(again.commit).toBe(committed.commit)
    expect(again.conflicts).toEqual([])
    expect((await gitOut(['rev-parse', 'HEAD'], integration.path)).trim()).toBe(headAfterMerge)
  })

  it('stops on conflict, keeps the mid-merge state and never aborts or resets', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const { task, integration } = await makePair(manager, repo)

    writeFileSync(join(task.path, 'README.md'), 'task side\n')
    await manager.commitAll(task.path, 'task: readme from task')
    writeFileSync(join(integration.path, 'README.md'), 'integration side\n')
    await manager.commitAll(integration.path, 'integration: readme on integration')

    const headBefore = (await gitOut(['rev-parse', 'HEAD'], integration.path)).trim()
    const opts = {
      checkoutPath: integration.path,
      sourcePath: task.path,
      sourceBranch: task.branch,
      message: 'pluton: merge conflicting task',
    }
    const result = await manager.integrateBranch(opts)
    expect(result.status).toBe('conflict')
    expect(result.commit).toBeNull()
    expect(result.conflicts).toEqual(['README.md'])

    // The mid-merge state must survive: MERGE_HEAD, markers, unchanged HEAD,
    // unmerged index entries — Pluton never runs merge --abort/reset/clean.
    expect(existsSync(join(integration.path, '.git', 'MERGE_HEAD'))).toBe(true)
    const conflicted = readFileSync(join(integration.path, 'README.md'), 'utf8')
    expect(conflicted).toContain('<<<<<<<')
    expect(conflicted).toContain('>>>>>>>')
    expect((await gitOut(['rev-parse', 'HEAD'], integration.path)).trim()).toBe(headBefore)
    const status = await manager.status(integration.path)
    expect(status.changes.some((line) => line.startsWith('UU'))).toBe(true)

    // A rerun refuses to merge over the unresolved merge; nothing is reset.
    const again = await manager.integrateBranch(opts)
    expect(again.status).toBe('failed')
    expect(again.detail).toMatch(/unresolved merge in progress/)
    expect(existsSync(join(integration.path, '.git', 'MERGE_HEAD'))).toBe(true)
  })

  it('reports failed when the source branch cannot be fetched', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const { integration } = await makePair(manager, repo)

    const result = await manager.integrateBranch({
      checkoutPath: integration.path,
      sourcePath: integration.path,
      sourceBranch: 'pluton/run_abc123ff/does-not-exist',
      message: 'pluton: merge missing branch',
    })
    expect(result.status).toBe('failed')
    expect(result.commit).toBeNull()
    expect(result.conflicts).toEqual([])
    expect(result.detail).toBeTruthy()
  })

  it('requires a non-empty merge message and a Pluton-managed source checkout', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const manager = makeManager(root)
    const { task, integration } = await makePair(manager, repo)

    await expect(
      manager.integrateBranch({
        checkoutPath: integration.path,
        sourcePath: task.path,
        sourceBranch: task.branch,
        message: '   ',
      }),
    ).rejects.toThrowError(ValidationError)

    const unmanaged = join(root, 'not-managed')
    mkdirSync(unmanaged, { recursive: true })
    await expect(
      manager.integrateBranch({
        checkoutPath: integration.path,
        sourcePath: unmanaged,
        sourceBranch: 'main',
        message: 'pluton: unmanaged source',
      }),
    ).rejects.toThrowError(/not a Pluton-managed checkout/)
  })

  it('fetches by source path + branch into FETCH_HEAD without refspecs or destructive git', async () => {
    const repo = await makeRepo()
    const root = tempDir('pluton-ws-root-')
    const creator = makeManager(root)
    const { task, integration } = await makePair(creator, repo)
    writeFileSync(join(task.path, 'g.txt'), 'g\n')
    await creator.commitAll(task.path, 'task: g')

    const argvLog: string[][] = []
    const spying = new GitWorkspaceManager({
      workspacesRoot: root,
      runFn: async (argv, options) => {
        argvLog.push(argv)
        return run(argv, options)
      },
    })
    const message = 'pluton: merge spied task'
    const result = await spying.integrateBranch({
      checkoutPath: integration.path,
      sourcePath: task.path,
      sourceBranch: task.branch,
      message,
    })
    expect(result.status).toBe('merged')
    expect(argvLog).toContainEqual(['git', 'fetch', task.path, task.branch])
    expect(argvLog).toContainEqual([
      'git',
      '-c',
      'user.name=Pluton',
      '-c',
      'user.email=pluton@localhost',
      'merge',
      '--no-ff',
      '-m',
      message,
      'FETCH_HEAD',
    ])
    await spying.changedFiles(task.path, task.baseCommit)
    expect(argvLog).toContainEqual(['git', 'diff', '--name-only', `${task.baseCommit}..HEAD`])

    const flat = argvLog.flat()
    expect(flat).not.toContain('--abort')
    expect(flat).not.toContain('reset')
    expect(flat).not.toContain('clean')
    expect(flat).not.toContain('--force')
  })
})
