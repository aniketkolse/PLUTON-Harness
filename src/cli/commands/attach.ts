import { bootstrapStore } from '../../bootstrap.ts'
import { TerminalUnavailableError, ValidationError } from '../../domain/errors.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import { sandboxContainerName, type SandboxManager } from '../../sandbox/types.ts'
import {
  attachToMuseTerminal,
  buildAttachArgv,
  type AttachOutcome,
  type AttachSpawnFn,
  type AttachTarget,
} from '../../terminal/attach.ts'
import { TmuxTerminalManager } from '../../terminal/manager.ts'
import { NativeTerminalManager } from '../../terminal/native.ts'
import { tmuxSessionName } from '../../terminal/names.ts'
import type { TerminalManager } from '../../terminal/types.ts'
import type { ProjectContext } from '../context.ts'
import { resolveMuseByRef } from './mcp.ts'

/**
 * `pluton attach <muse> [--window <name>]` — resolve the Muse's container and
 * tmux session names, ensure the session exists (inside the container, through
 * the SandboxManager) and hand the terminal to `docker exec -it … tmux
 * attach-session`.
 *
 * In `--json` mode (or when no spawn fn is injected) this is plan mode: the
 * target is resolved, the session ensured and the exact argv returned, but
 * nothing is spawned. Attach only touches the terminals bookkeeping row —
 * it never creates containers and never affects tasks (ADR-0005).
 */

export interface AttachCommandOptions {
  museRef: string
  windowName?: string
}

export interface AttachDeps {
  sandboxManager?: SandboxManager
  terminalManager?: TerminalManager
  spawnAttach?: AttachSpawnFn
}

export interface AttachCommandResult {
  museId: string
  containerName: string
  sessionName: string
  windowName: string | null
  sessionCreated: boolean
  argv: string[]
  attached: boolean
  exitCode: number | null
}

const CONTAINER_MISSING_FIX =
  'start a run first — per-Muse containers are created by `pluton run`; attach never creates containers'

/** `details.reason` is the terminal manager's stable failure vocabulary. */
function terminalFailureReason(e: unknown): unknown {
  if (!(e instanceof TerminalUnavailableError)) return undefined
  const d = e.details
  if (typeof d !== 'object' || d === null) return undefined
  return (d as { reason?: unknown }).reason
}

export async function attachMuse(
  ctx: ProjectContext,
  opts: AttachCommandOptions,
  deps: AttachDeps = {},
): Promise<AttachCommandResult> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const muse = resolveMuseByRef(store, opts.museRef)
    if (!muse.enabled) {
      throw new ValidationError(
        `muse '${muse.id}' is disabled (it is no longer in pluton.yaml) — add it back with \`pluton muse create\` or attach to an enabled muse`,
      )
    }
    const sandboxKind = ctx.loaded.config.sandbox.kind
    if (sandboxKind !== 'docker' && sandboxKind !== 'native') {
      throw new ValidationError(
        `pluton attach requires container-mode Muses (sandbox.kind: docker): ${sandboxKind} sessions have no Muse container or tmux session`,
      )
    }
    const isNative = sandboxKind === 'native'
    const containerName = isNative ? 'host' : sandboxContainerName(projectId, muse.id)
    const target: AttachTarget = {
      containerName,
      sessionName: tmuxSessionName(ctx.loaded.config.project.name, muse.id),
      ...(opts.windowName !== undefined ? { windowName: opts.windowName } : {}),
    }
    const manager =
      deps.terminalManager ??
      (isNative
        ? new NativeTerminalManager()
        : new TmuxTerminalManager(deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)))

    let outcome: AttachOutcome
    try {
      outcome = await attachToMuseTerminal({
        sandboxKind,
        manager,
        target,
        ...(deps.spawnAttach !== undefined ? { spawnAttach: deps.spawnAttach } : {}),
      })
    } catch (e) {
      if (terminalFailureReason(e) === 'container_missing') {
        // attach NEVER creates containers: the run path owns provisioning, so
        // the honest fix is "start a run", not "re-create the sandbox".
        throw new TerminalUnavailableError(
          `Muse container '${target.containerName}' does not exist — attach never creates containers`,
          { details: (e as TerminalUnavailableError).details, fix: CONTAINER_MISSING_FIX },
        )
      }
      throw e
    }

    store.upsertTerminal({
      projectId,
      museId: muse.id,
      sandboxId: isNative ? null : (store.getSandboxForMuse(projectId, muse.id)?.id ?? null),
      tmuxSessionName: target.sessionName,
      state: 'present',
    })
    return {
      museId: muse.id,
      containerName,
      sessionName: target.sessionName,
      windowName: outcome.windowName,
      sessionCreated: outcome.sessionCreated,
      argv: buildAttachArgv(target, sandboxKind),
      attached: outcome.exitCode !== null,
      exitCode: outcome.exitCode,
    }
  } finally {
    store.close()
  }
}
