import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureWorkspaceEvidence } from '../../src/verify/evidence.ts'
import { GitWorkspaceManager } from '../../src/workspace/manager.ts'
import { diffCommitPatch, diffTreeStat, diffWorktreePatch, diffWorktreeStat, logOneline } from '../../src/workspace/trusted-git.ts'

/**
 * The host Git trust boundary. Every test below builds a disposable repository
 * whose worktree metadata (hooks, filters, external diff, merge drivers,
 * upload-pack hooks) would create a marker file if Pluton ever handed that
 * metadata to a host Git process. The marker must never appear.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pluton',
      GIT_AUTHOR_EMAIL: 'pluton@localhost',
      GIT_COMMITTER_NAME: 'Pluton',
      GIT_COMMITTER_EMAIL: 'pluton@localhost',
      ...env,
    },
  })
}

function seedRepo(): string {
  const dir = tmp('pluton-trusted-git-')
  git(dir, ['init', '-b', 'main'])
  writeFileSync(join(dir, 'app.txt'), 'seed\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  return dir
}

/** A helper script that records that Git executed it. */
function markerScript(dir: string, name: string, marker: string): string {
  const script = join(dir, `${name}.cjs`)
  writeFileSync(
    script,
    [
      "const fs = require('node:fs')",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'executed')`,
      'process.stdin.pipe(process.stdout)',
      '',
    ].join('\n'),
  )
  return `"${process.execPath}" "${script}"`
}

function hook(checkout: string, name: string, marker: string): void {
  const path = join(checkout, '.git', 'hooks', name)
  writeFileSync(path, `#!/bin/sh\nprintf executed > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
}

function markManager(checkout: string): void {
  writeFileSync(
    join(checkout, '.git', 'pluton-workspace.json'),
    `${JSON.stringify({ managed: true, kind: 'task-checkout', branch: 'pluton/run_abc123/task', baseCommit: '0'.repeat(40), createdAt: new Date().toISOString() })}\n`,
  )
}

describe('host Git trust boundary', () => {
  it('commits raw worktree bytes without running hooks or clean filters', async () => {
    const repo = seedRepo()
    const marker = join(repo, '..', `commit-marker-${String(Date.now())}`)
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=hostile\n')
    git(repo, ['config', 'filter.hostile.clean', markerScript(repo, 'clean', marker)])
    hook(repo, 'pre-commit', marker)
    hook(repo, 'post-commit', marker)
    markManager(repo)
    writeFileSync(join(repo, 'app.txt'), 'raw bytes\n')

    const manager = new GitWorkspaceManager({ workspacesRoot: repo })
    const result = await manager.commitAll(repo, 'test commit')

    expect(result.commit).toMatch(/^[0-9a-f]{40,64}$/)
    expect(existsSync(marker)).toBe(false)
    const committed = git(repo, ['cat-file', 'blob', `${String(result.commit)}:app.txt`])
    expect(committed).toBe('raw bytes\n')
  })

  it('captures evidence, status and diff without running filters, fsmonitor or external diff', async () => {
    const repo = seedRepo()
    const marker = join(repo, '..', `evidence-marker-${String(Date.now())}`)
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=hostile diff=hostile\n')
    git(repo, ['config', 'filter.hostile.clean', markerScript(repo, 'clean', marker)])
    git(repo, ['config', 'diff.hostile.textconv', markerScript(repo, 'textconv', marker)])
    git(repo, ['config', 'diff.external', markerScript(repo, 'external', marker)])
    git(repo, ['config', 'core.fsmonitor', markerScript(repo, 'fsmonitor', marker)])
    git(repo, ['add', '.gitattributes'])
    git(repo, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'attributes'])
    markManager(repo)
    writeFileSync(join(repo, 'app.txt'), 'raw change\n')
    // Setup itself may have invoked fsmonitor while staging the attributes
    // file; only executions after this point are Pluton's responsibility.
    rmSync(marker, { force: true })

    const evidence = await captureWorkspaceEvidence(repo)
    expect(evidence.available).toBe(true)
    expect(evidence.worktreeDirty).toBe(true)
    expect(evidence.worktreeFingerprint).toMatch(/^[0-9a-f]{64}$/)

    const manager = new GitWorkspaceManager({ workspacesRoot: repo })
    const status = await manager.status(repo)
    expect(status.changes.length).toBeGreaterThan(0)
    const diff = await manager.captureDiff(repo)
    expect(diff.diff).toContain('raw change')

    // The diff.inspect / verification paths use these helpers; every one of
    // them must stay inside the trusted view as well.
    const worktree = await diffWorktreeStat(repo, evidence.revision as string)
    expect(worktree.stat).toContain('app.txt')
    expect(worktree.changes.some((line) => line.endsWith('app.txt'))).toBe(true)
    const livePatch = await diffWorktreePatch(repo, evidence.revision as string)
    expect(livePatch.diff).toContain('raw change')
    expect(livePatch.files).toContain('app.txt')
    const commits = await diffCommitPatch(repo, evidence.revision as string, 'HEAD')
    expect(commits.files).toEqual([])
    const stat = await diffTreeStat(repo, evidence.revision as string, 'HEAD')
    expect(stat.stat).toBe('')
    const log = await logOneline(repo, evidence.revision as string, 'HEAD')
    expect(log.log).toBe('')
    expect(existsSync(marker)).toBe(false)
  })

  it('does not execute source upload-pack hooks, hooks or merge drivers during integration', async () => {
    const repo = seedRepo()
    const marker = join(repo, '..', `integrate-marker-${String(Date.now())}`)
    const workspaces = tmp('pluton-trusted-ws-')
    const manager = new GitWorkspaceManager({ workspacesRoot: workspaces })
    const task = await manager.createCheckout({
      repoPath: repo,
      kind: 'task-checkout',
      runId: 'run_abc123',
      slug: 'task',
      destName: 'task-one',
    })
    const integration = await manager.createCheckout({
      repoPath: repo,
      kind: 'integration-checkout',
      runId: 'run_abc123',
      destName: 'integration-one',
    })

    writeFileSync(join(task.path, 'feature.txt'), 'feature\n')
    writeFileSync(join(task.path, '.gitattributes'), '*.txt merge=hostile\n')
    git(task.path, ['config', 'merge.hostile.driver', markerScript(task.path, 'merge', marker)])
    git(task.path, ['config', 'uploadpack.packObjectsHook', markerScript(task.path, 'upload', marker)])
    hook(task.path, 'post-checkout', marker)
    hook(integration.path, 'post-merge', marker)
    hook(integration.path, 'post-checkout', marker)
    const committed = await manager.commitAll(task.path, 'feature')
    expect(committed.commit).not.toBeNull()

    const result = await manager.integrateBranch({
      checkoutPath: integration.path,
      sourcePath: task.path,
      sourceBranch: task.branch,
      message: 'merge feature',
    })

    expect(result.status).toBe('merged')
    expect(existsSync(marker)).toBe(false)
    // The merge preserves the checkout's effective non-executable core.*
    // settings (here Git for Windows' autocrlf), so the worktree may carry
    // CRLF while the committed blob stays byte-exact.
    expect(readFileSync(join(integration.path, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('feature\n')
    const blob = git(integration.path, ['cat-file', 'blob', 'HEAD:feature.txt'])
    expect(blob).toBe('feature\n')
  })

  it('refuses a merge that would need a worker-defined driver instead of executing it', async () => {
    const repo = seedRepo()
    const marker = join(repo, '..', `merge-refuse-marker-${String(Date.now())}`)
    const workspaces = tmp('pluton-trusted-ws-')
    const manager = new GitWorkspaceManager({ workspacesRoot: workspaces })
    const task = await manager.createCheckout({
      repoPath: repo,
      kind: 'task-checkout',
      runId: 'run_abc124',
      slug: 'task',
      destName: 'task-two',
    })
    const integration = await manager.createCheckout({
      repoPath: repo,
      kind: 'integration-checkout',
      runId: 'run_abc124',
      destName: 'integration-two',
    })

    writeFileSync(join(task.path, '.gitattributes'), '*.txt merge=hostile\n')
    writeFileSync(join(task.path, 'app.txt'), 'task version\n')
    git(task.path, ['config', 'merge.hostile.driver', markerScript(task.path, 'merge', marker)])
    const committed = await manager.commitAll(task.path, 'task change')
    expect(committed.commit).not.toBeNull()
    writeFileSync(join(integration.path, 'app.txt'), 'integration version\n')
    const base = await manager.commitAll(integration.path, 'integration change')
    expect(base.commit).not.toBeNull()

    const result = await manager.integrateBranch({
      checkoutPath: integration.path,
      sourcePath: task.path,
      sourceBranch: task.branch,
      message: 'merge conflicting change',
    })

    expect(['conflict', 'failed']).toContain(result.status)
    expect(existsSync(marker)).toBe(false)
  })

  it('distinguishes a genuine non-git directory from a broken git checkout', async () => {
    const plain = tmp('pluton-trusted-plain-')
    const plainEvidence = await captureWorkspaceEvidence(plain)
    expect(plainEvidence.kind).toBe('non-git')
    expect(plainEvidence.available).toBe(false)

    const broken = tmp('pluton-trusted-broken-')
    writeFileSync(join(broken, '.git'), 'not a git directory\n')
    const brokenEvidence = await captureWorkspaceEvidence(broken)
    expect(brokenEvidence.kind).toBe('capture-failed')
    expect(brokenEvidence.available).toBe(false)
    expect(brokenEvidence.reason).toMatch(/git/i)
  })
})
