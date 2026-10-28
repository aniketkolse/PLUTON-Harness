import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProjectContext } from '../context.ts'
import { bootstrapStore } from '../../bootstrap.ts'
import {
  exportSessionToJsonl,
  importSessionFromJsonl,
  exportRunToJsonl,
  importRunFromJsonl,
} from '../../store/jsonl.ts'
import { ValidationError } from '../../domain/errors.ts'

export interface SessionExportOptions {
  out?: string
}

export function exportSession(
  ctx: ProjectContext,
  sessionId: string,
  opts: SessionExportOptions = {},
): { sessionId: string; path?: string; jsonl: string } {
  if (!sessionId) {
    throw new ValidationError('sessionId is required')
  }
  const { store } = bootstrapStore(ctx.loaded)
  try {
    const jsonl = exportSessionToJsonl(store, sessionId)
    if (opts.out) {
      const targetPath = resolve(opts.out)
      writeFileSync(targetPath, jsonl, 'utf8')
      return { sessionId, path: targetPath, jsonl }
    }
    return { sessionId, jsonl }
  } finally {
    store.close()
  }
}

export interface SessionImportOptions {
  /**
   * Local workspace root for a cross-host restore. Absolute workspace paths in
   * an export are host-specific, so import refuses one that does not exist
   * unless the operator chooses a replacement.
   */
  workspaceRoot?: string
}

export function importSession(
  ctx: ProjectContext,
  filePath: string,
  opts: SessionImportOptions = {},
): { sessionId: string; messageCount: number } {
  if (!filePath) {
    throw new ValidationError('file path is required')
  }
  const content = readFileSync(resolve(filePath), 'utf8')
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const result = importSessionFromJsonl(store, content, {
      targetProjectId: projectId,
      ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
    })
    return {
      sessionId: result.session.id,
      messageCount: result.messageCount,
    }
  } finally {
    store.close()
  }
}

export function exportRun(
  ctx: ProjectContext,
  runId: string,
  opts: SessionExportOptions = {},
): { runId: string; path?: string; jsonl: string } {
  if (!runId) {
    throw new ValidationError('runId is required')
  }
  const { store } = bootstrapStore(ctx.loaded)
  try {
    const jsonl = exportRunToJsonl(store, runId)
    if (opts.out) {
      const targetPath = resolve(opts.out)
      writeFileSync(targetPath, jsonl, 'utf8')
      return { runId, path: targetPath, jsonl }
    }
    return { runId, jsonl }
  } finally {
    store.close()
  }
}

export function importRun(
  ctx: ProjectContext,
  filePath: string,
  opts: SessionImportOptions = {},
): { runId: string; taskCount: number; eventCount: number } {
  if (!filePath) {
    throw new ValidationError('file path is required')
  }
  const content = readFileSync(resolve(filePath), 'utf8')
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const result = importRunFromJsonl(store, content, {
      targetProjectId: projectId,
      ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
    })
    return {
      runId: result.run.id,
      taskCount: result.taskCount,
      eventCount: result.eventCount,
    }
  } finally {
    store.close()
  }
}
