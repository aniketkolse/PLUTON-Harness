import { describe, expect, it } from 'vitest'
import type { VerificationCheckRecord } from '../../src/domain/models.ts'
import { verificationEvidenceProblem } from '../../src/verify/runner.ts'

/**
 * Evidence rules are the gate between "some rows exist" and "these rows attest
 * the content that will be integrated". They are pure, so every rejection path
 * is exercised directly here: a missing/legacy kind, a capture failure, mixed
 * kinds, incomplete Git fields, a moved HEAD, a changed worktree and an
 * explicit non-Git directory that cannot attest a Git branch.
 */

function check(overrides: Partial<VerificationCheckRecord> = {}): VerificationCheckRecord {
  return {
    id: 'verification_1',
    projectId: 'project_1',
    runId: 'run_1',
    taskId: 'task_1',
    attempt: 0,
    name: 'check',
    command: ['true'],
    cwd: '/tmp/checkout',
    workspaceId: null,
    evidenceKind: 'git',
    revision: 'a'.repeat(40),
    worktreeDirty: false,
    worktreeFingerprint: 'f'.repeat(64),
    postEvidenceKind: 'git',
    postRevision: 'a'.repeat(40),
    postWorktreeFingerprint: 'f'.repeat(64),
    postWorktreeDirty: false,
    executor: 'test:host',
    supersededAt: null,
    status: 'passed',
    exitCode: 0,
    stdoutArtifact: null,
    stderrArtifact: null,
    durationMs: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('verificationEvidenceProblem', () => {
  it('accepts one complete Git snapshot shared by every check', () => {
    expect(verificationEvidenceProblem([check()])).toBeNull()
    expect(verificationEvidenceProblem([check({ id: 'a' }), check({ id: 'b' })])).toBeNull()
  })

  it('never treats a NULL/legacy row as fresh evidence', () => {
    expect(verificationEvidenceProblem([check({ evidenceKind: null })])).toMatch(/no recorded kind/)
    expect(verificationEvidenceProblem([], {})).toMatch(/no verification checks/)
  })

  it('never downgrades a capture failure to non-Git', () => {
    expect(
      verificationEvidenceProblem([
        check({
          evidenceKind: 'capture-failed',
          revision: null,
          worktreeDirty: null,
          worktreeFingerprint: null,
          postEvidenceKind: 'capture-failed',
          postRevision: null,
          postWorktreeDirty: null,
          postWorktreeFingerprint: null,
        }),
      ]),
    ).toMatch(/capture failed/)
  })

  it('rejects mixed evidence kinds', () => {
    expect(
      verificationEvidenceProblem([check(), check({ id: 'b', evidenceKind: 'non-git' })]),
    ).toMatch(/different kinds/)
  })

  it('requires every Git field, including the executor identity', () => {
    expect(verificationEvidenceProblem([check({ revision: null })])).toMatch(/incomplete Git evidence/)
    expect(verificationEvidenceProblem([check({ postRevision: null })])).toMatch(/incomplete Git evidence/)
    expect(verificationEvidenceProblem([check({ worktreeDirty: null })])).toMatch(/incomplete Git evidence/)
    expect(verificationEvidenceProblem([check({ postWorktreeFingerprint: null })])).toMatch(
      /incomplete Git evidence/,
    )
    expect(verificationEvidenceProblem([check({ executor: null })])).toMatch(/executor identity/)
    expect(verificationEvidenceProblem([check({ executor: '   ' })])).toMatch(/executor identity/)
  })

  it('rejects HEAD movement, different revisions and a changed worktree', () => {
    expect(verificationEvidenceProblem([check({ postRevision: 'b'.repeat(40) })])).toMatch(/moved HEAD/)
    expect(
      verificationEvidenceProblem([check(), check({ id: 'b', revision: 'b'.repeat(40), postRevision: 'b'.repeat(40) })]),
    ).toMatch(/different HEAD revisions/)
    expect(verificationEvidenceProblem([check({ postWorktreeFingerprint: 'e'.repeat(64) })])).toMatch(
      /changed the worktree/,
    )
    expect(
      verificationEvidenceProblem([
        check(),
        check({ id: 'b', worktreeFingerprint: 'e'.repeat(64), postWorktreeFingerprint: 'e'.repeat(64) }),
      ]),
    ).toMatch(/different worktree states/)
  })

  it('rejects superseded rows', () => {
    expect(verificationEvidenceProblem([check({ supersededAt: '2026-01-01T00:00:00.000Z' })])).toMatch(
      /superseded/,
    )
  })

  it('accepts a complete explicit non-Git capture only when no Git truth is required', () => {
    const nonGit = check({
      evidenceKind: 'non-git',
      revision: null,
      worktreeDirty: null,
      worktreeFingerprint: null,
      postEvidenceKind: 'non-git',
      postRevision: null,
      postWorktreeDirty: null,
      postWorktreeFingerprint: null,
    })
    expect(verificationEvidenceProblem([nonGit])).toBeNull()
    expect(verificationEvidenceProblem([nonGit], { requireGit: true })).toMatch(/non-Git verification evidence/)
  })

  it('rejects non-Git evidence that smuggles Git fields', () => {
    expect(
      verificationEvidenceProblem([
        check({
          evidenceKind: 'non-git',
          revision: 'a'.repeat(40),
          postEvidenceKind: 'non-git',
        }),
      ]),
    ).toMatch(/mixes non-Git evidence with Git fields/)
  })
})
