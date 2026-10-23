import { bootstrapStore } from '../../bootstrap.ts'
import { TerminalUnavailableError, ValidationError } from '../../domain/errors.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import { sandboxContainerName, type SandboxManager } from '../../sandbox/types.ts'
import {
  attachToShipTerminal,
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
import { resolveShipByRef } from './mcp.ts'

/**
 * `pluton attach <ship> [--window <name>]` — resolve the Ship's terminal target,
 * ensure the tmux session exists (inside the container for Docker mode, on the
 * host for native mode) and hand the terminal to `docker exec -it … tmux
 * attach-session` or host `tmux attach-session`.
 *
 * In `--json` mode (or when no spawn fn is injected) this is plan mode: the
 * target is resolved, the session ensured and the exact argv returned, but
 * nothing is spawned. Attach only touches the terminals bookkeeping row —
 * it never creates containers and never affects tasks (ADR-0005).
 */

export interface AttachCommandOptions {
  shipRef?: string
  /** @deprecated Use `shipRef`; kept for backward compatibility. */
  museRef?: string
  windowName?: string
}

export interface AttachDeps {
  sandboxManager?: SandboxManager
  terminalManager?: TerminalManager
  spawnAttach?: AttachSpawnFn
}

export interface AttachCommandResult {
  shipId: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  containerName: string
  sessionName: string
  windowName: string | null
  sessionCreated: boolean
  argv: string[]
  attached: boolean
  exitCode: number | null
}

const CONTAINER_MISSING_FIX =
  'start a run first — per-Ship containers are created by `pluton run`; attach never creates containers'

/** `details.reason` is the terminal manager's stable failure vocabulary. */
function terminalFailureReason(e: unknown): unknown {
  if (!(e instanceof TerminalUnavailableError)) return undefined
  const d = e.details
  if (typeof d !== 'object' || d === null) return undefined
  return (d as { reason?: unknown }).reason
}

export async function attachShip(
  ctx: ProjectContext,
  opts: AttachCommandOptions,
  deps: AttachDeps = {},
): Promise<AttachCommandResult> {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const shipRef = opts.shipRef ?? opts.museRef
    if (!shipRef) throw new ValidationError('shipRef is required')
    const ship = resolveShipByRef(store, shipRef)
    if (!ship.enabled) {
      throw new ValidationError(
        `ship '${ship.id}' is disabled (it is no longer in pluton.yaml) — add it back with \`pluton ship create\` or attach to an enabled ship`,
      )
    }
    const sandboxKind = ctx.loaded.config.sandbox.kind
    if (sandboxKind !== 'docker' && sandboxKind !== 'native') {
      throw new ValidationError(
        `pluton attach requires container-mode Ships (sandbox.kind: docker) or native host mode (sandbox.kind: native): ${sandboxKind} sessions have no Ship container or host tmux session`,
      )
    }
    const isNative = sandboxKind === 'native'
    const containerName = isNative ? 'host' : sandboxContainerName(projectId, ship.id)
    const target: AttachTarget = {
      containerName,
      sessionName: tmuxSessionName(ctx.loaded.config.project.name, ship.id),
      ...(opts.windowName !== undefined ? { windowName: opts.windowName } : {}),
    }
    const manager =
      deps.terminalManager ??
      (isNative
        ? new NativeTerminalManager()
        : new TmuxTerminalManager(deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)))

    let outcome: AttachOutcome
    try {
      outcome = await attachToShipTerminal({
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
          `Ship container '${target.containerName}' does not exist — attach never creates containers`,
          { details: (e as TerminalUnavailableError).details, fix: CONTAINER_MISSING_FIX },
        )
      }
      throw e
    }

    store.upsertTerminal({
      projectId,
      shipId: ship.id,
      sandboxId: isNative ? null : (store.getSandboxForShip(projectId, ship.id)?.id ?? null),
      tmuxSessionName: target.sessionName,
      state: 'present',
    })
    return {
      shipId: ship.id,
      museId: ship.id,
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

/** @deprecated Use `attachShip`; kept for backward compatibility. */
export const attachMuse = attachShip
