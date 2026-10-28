import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { captureRawSnapshot } from '../workspace/trusted-git.ts'

/**
 * Workspace evidence for verification (durable, attempt-scoped).
 *
 * The revision alone is not enough: a verification check can run while the
 * checkout is dirty, and a later commit/merge can silently include work that
 * was never tested. A fingerprint therefore covers HEAD plus the exact tracked
 * and untracked content, computed through the trusted Git layer
 * (`hash-object --no-filters` + a throwaway index), never through `git add`,
 * `git status` or any other command that would run repository-controlled
 * filters, hooks or fsmonitor programs.
 *
 * `kind` separates the two distinct "no evidence" cases:
 *
 * - `non-git`: the directory is deliberately not a Git checkout, so there is
 *   nothing to fingerprint (callers must not infer freshness from it);
 * - `capture-failed`: Git metadata was expected but could not be trusted or
 *   read. This is an error, never a clean result.
 */

export type WorkspaceEvidenceKind = 'git' | 'non-git' | 'capture-failed'

export interface WorkspaceEvidence {
  kind: WorkspaceEvidenceKind
  /** True only for a complete, trusted Git snapshot. */
  available: boolean
  /** Human-readable failure detail for `capture-failed`, otherwise null. */
  reason: string | null
  revision: string | null
  worktreeDirty: boolean | null
  worktreeFingerprint: string | null
}

function unavailable(kind: 'non-git' | 'capture-failed', reason: string | null): WorkspaceEvidence {
  return {
    kind,
    available: false,
    reason,
    revision: null,
    worktreeDirty: null,
    worktreeFingerprint: null,
  }
}

function hasGitEntry(cwd: string): boolean {
  // `.git` may be a directory (normal checkout) or a file (worktree/submodule
  // link). Either way it is a Git claim that must be validated; only an
  // absent entry is unambiguously non-Git.
  return existsSync(join(cwd, '.git'))
}

export async function captureWorkspaceEvidence(cwd: string): Promise<WorkspaceEvidence> {
  if (!hasGitEntry(cwd)) return unavailable('non-git', null)
  try {
    const snapshot = await captureRawSnapshot(cwd)
    return {
      kind: 'git',
      available: true,
      reason: null,
      revision: snapshot.identity.head,
      worktreeDirty: snapshot.dirty,
      worktreeFingerprint: snapshot.fingerprint,
    }
  } catch (error) {
    // Fail closed: a checkout with Git metadata that cannot be trusted is a
    // capture failure, never a clean or non-Git result.
    return unavailable('capture-failed', error instanceof Error ? error.message : String(error))
  }
}
