import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureWorkspaceEvidence } from '../../src/verify/evidence.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import type { RunBudget } from '../../src/domain/models.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Pluton', GIT_AUTHOR_EMAIL: 'pluton@localhost' },
  })
}

function seedRepo(): string {
  const dir = tmpDir('pluton-evidence-git-')
  git(dir, ['init', '-b', 'main'])
  writeFileSync(join(dir, 'app.ts'), 'export const x = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  return dir
}

const BUDGET: RunBudget = {
  maxConcurrentWorkers: 1,
  maxTasks: 4,
  maxDelegationDepth: 1,
  maxRunMinutes: 10,
  defaultTaskMinutes: 5,
}

function testStore(): Store {
  const db = openDatabase(join(tmpDir('pluton-evidence-db-'), 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  return new Store(db)
}

describe('workspace verification evidence', () => {
  it('captures a stable revision/fingerprint and detects tracked or untracked drift', async () => {
    const dir = seedRepo()
    const initial = await captureWorkspaceEvidence(dir)
    expect(initial.available).toBe(true)
    expect(initial.revision).toHaveLength(40)
    expect(initial.worktreeDirty).toBe(false)
    expect(initial.worktreeFingerprint).toMatch(/^[0-9a-f]{64}$/)

    const again = await captureWorkspaceEvidence(dir)
    expect(again.worktreeFingerprint).toBe(initial.worktreeFingerprint)

    writeFileSync(join(dir, 'app.ts'), 'export const x = 2\n')
    const tracked = await captureWorkspaceEvidence(dir)
    expect(tracked.worktreeDirty).toBe(true)
    expect(tracked.worktreeFingerprint).not.toBe(initial.worktreeFingerprint)

    writeFileSync(join(dir, 'new-file.ts'), 'export const y = 3\n')
    const untracked = await captureWorkspaceEvidence(dir)
    expect(untracked.worktreeFingerprint).not.toBe(tracked.worktreeFingerprint)

    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'change'])
    const committed = await captureWorkspaceEvidence(dir)
    expect(committed.worktreeDirty).toBe(false)
    expect(committed.revision).not.toBe(initial.revision)
    expect(committed.worktreeFingerprint).not.toBe(untracked.worktreeFingerprint)
  })

  it('ignores control-plane churn while still fingerprinting deliverable content', async () => {
    const dir = seedRepo()
    const initial = await captureWorkspaceEvidence(dir)

    mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
    writeFileSync(join(dir, '.pluton', 'state', 'pluton.sqlite'), 'db')
    writeFileSync(join(dir, '.pluton', 'state', 'pluton.sqlite-wal'), 'wal')
    const state = await captureWorkspaceEvidence(dir)
    expect(state.available).toBe(true)
    expect(state.worktreeDirty).toBe(false)
    expect(state.worktreeFingerprint).toBe(initial.worktreeFingerprint)

    // The running CLI appends to the WAL while a check is being verified.
    writeFileSync(join(dir, '.pluton', 'state', 'pluton.sqlite-wal'), 'wal-after-checkpoint')
    expect((await captureWorkspaceEvidence(dir)).worktreeFingerprint).toBe(initial.worktreeFingerprint)

    // Untracked deliverable content is still evidence.
    writeFileSync(join(dir, 'added.ts'), 'export const z = 1\n')
    const added = await captureWorkspaceEvidence(dir)
    expect(added.worktreeDirty).toBe(true)
    expect(added.worktreeFingerprint).not.toBe(initial.worktreeFingerprint)
  })

  it('still fingerprints control-plane paths that are tracked in HEAD', async () => {
    const dir = seedRepo()
    mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
    writeFileSync(join(dir, '.pluton', 'state', 'pinned.txt'), 'one\n')
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'track control plane'])
    const initial = await captureWorkspaceEvidence(dir)

    writeFileSync(join(dir, '.pluton', 'state', 'pinned.txt'), 'two\n')
    const changed = await captureWorkspaceEvidence(dir)
    expect(changed.worktreeDirty).toBe(true)
    expect(changed.worktreeFingerprint).not.toBe(initial.worktreeFingerprint)
  })

  it('returns explicit unavailable evidence outside a git worktree', async () => {
    const dir = tmpDir('pluton-evidence-nogit-')
    const evidence = await captureWorkspaceEvidence(dir)
    expect(evidence).toEqual({
      kind: 'non-git',
      available: false,
      reason: null,
      revision: null,
      worktreeDirty: null,
      worktreeFingerprint: null,
    })
  })

  it('distinguishes a broken git checkout from a non-git directory', async () => {
    const dir = tmpDir('pluton-evidence-broken-')
    writeFileSync(join(dir, '.git'), 'not a directory\n')
    const evidence = await captureWorkspaceEvidence(dir)
    expect(evidence.kind).toBe('capture-failed')
    expect(evidence.available).toBe(false)
    expect(evidence.reason).toBeTruthy()
    expect(evidence.revision).toBeNull()
  })
})

describe('attempt-scoped verification evidence storage', () => {
  it('stores evidence per attempt and refuses to rewrite post-check evidence', () => {
    const store = testStore()
    const project = store.ensureProject({
      name: 'evidence-store',
      rootPath: '/tmp/evidence-store',
      configPath: '/tmp/evidence-store/pluton.yaml',
      defaultBranch: 'main',
    })
    const run = store.createRun({
      projectId: project.id,
      goal: 'evidence goal',
      origin: 'cli',
      requestedBy: 'test',
      acceptanceCriteria: [],
      managerMuseId: 'manager',
      budget: BUDGET,
    })
    store.syncMuses(project.id, [
      {
        id: 'manager',
        slug: 'manager',
        displayName: 'Manager',
        role: 'supervisor',
        engineKind: 'mock',
        model: 'mock/model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [],
        approvalMode: 'autonomous-bounded',
        engineHome: '.pluton/engine-homes/manager',
      },
      {
        id: 'worker',
        slug: 'worker',
        displayName: 'Worker',
        role: 'coder',
        engineKind: 'mock',
        model: 'mock/model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [],
        approvalMode: 'ask-for-sensitive-actions',
        engineHome: '.pluton/engine-homes/worker',
      },
    ])
    const task = store.createTask({
      runId: run.id,
      title: 'evidence task',
      brief: 'do work',
      acceptanceCriteria: [],
      assigneeMuseId: 'worker',
    })

    const attempt0 = store.createVerificationCheck({
      projectId: project.id,
      runId: run.id,
      taskId: task.id,
      attempt: 0,
      name: 'old',
      command: ['true'],
      cwd: '/tmp',
      workspaceId: null,
      evidenceKind: 'git',
      revision: 'a'.repeat(40),
      worktreeDirty: false,
      worktreeFingerprint: 'f'.repeat(64),
    })
    const attempt1 = store.createVerificationCheck({
      projectId: project.id,
      runId: run.id,
      taskId: task.id,
      attempt: 1,
      name: 'new',
      command: ['true'],
      cwd: '/tmp',
      workspaceId: null,
    })
    expect(store.listVerificationChecksByTask(task.id)).toHaveLength(2)
    expect(store.listVerificationChecksByTaskAttempt(task.id, 0).map((c) => c.id)).toEqual([attempt0.id])
    expect(store.listVerificationChecksByTaskAttempt(task.id, 1).map((c) => c.id)).toEqual([attempt1.id])
    expect(attempt0.evidenceKind).toBe('git')
    expect(attempt0.revision).toBe('a'.repeat(40))

    // Interrupted attempt: a fresh run supersedes the same attempt instead of
    // deleting history or bumping the attempt number.
    expect(store.listCurrentVerificationChecksByTaskAttempt(task.id, 0).map((c) => c.id)).toEqual([
      attempt0.id,
    ])
    expect(store.supersedeVerificationChecks(task.id, 0)).toBe(1)
    expect(store.listCurrentVerificationChecksByTaskAttempt(task.id, 0)).toEqual([])
    expect(store.listVerificationChecksByTaskAttempt(task.id, 0).map((c) => c.id)).toEqual([attempt0.id])
    expect(store.getVerificationCheck(attempt0.id).supersededAt).not.toBeNull()
    const fresh = store.createVerificationCheck({
      projectId: project.id,
      runId: run.id,
      taskId: task.id,
      attempt: 0,
      name: 'fresh',
      command: ['true'],
      cwd: '/tmp',
      workspaceId: null,
      evidenceKind: 'git',
      revision: 'a'.repeat(40),
      worktreeDirty: false,
      worktreeFingerprint: 'f'.repeat(64),
    })
    expect(store.listCurrentVerificationChecksByTaskAttempt(task.id, 0).map((c) => c.id)).toEqual([
      fresh.id,
    ])
    expect(store.listVerificationChecksByTask(task.id)).toHaveLength(3)

    const post = store.setVerificationCheckPostEvidence(attempt1.id, {
      postRevision: 'b'.repeat(40),
      postWorktreeFingerprint: 'e'.repeat(64),
    })
    expect(post.postRevision).toBe('b'.repeat(40))
    expect(post.postWorktreeFingerprint).toBe('e'.repeat(64))

    // Idempotent same-value write, but a different rewrite is refused.
    expect(
      store.setVerificationCheckPostEvidence(attempt1.id, {
        postRevision: 'b'.repeat(40),
        postWorktreeFingerprint: 'e'.repeat(64),
      }).postWorktreeFingerprint,
    ).toBe('e'.repeat(64))
    expect(() =>
      store.setVerificationCheckPostEvidence(attempt1.id, {
        postRevision: 'c'.repeat(40),
        postWorktreeFingerprint: 'd'.repeat(64),
      }),
    ).toThrow(/post-check evidence/)
  })
})
