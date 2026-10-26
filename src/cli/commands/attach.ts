import { bootstrapStore } from '../../bootstrap.ts'
import { TerminalUnavailableError, ValidationError } from '../../domain/errors.ts'
import { assertNativeSandboxKind } from '../../execution/factory.ts'
import {
  attachToShipTerminal,
  buildAttachArgv,
  type AttachOutcome,
  type AttachSpawnFn,
  type AttachTarget,
} from '../../terminal/attach.ts'
import { NativeTerminalManager } from '../../terminal/native.ts'
import { tmuxSessionName } from '../../terminal/names.ts'
import type { TerminalManager } from '../../terminal/types.ts'
import type { ProjectContext } from '../context.ts'
import { resolveShipByRef } from './mcp.ts'

/**
 * `pluton attach <ship> [--window <name>]` — resolve the Ship's terminal target,
 * ensure the host tmux session exists and hand the terminal to host
 * `tmux attach-session`.
 *
 * In `--json` mode (or when no spawn fn is injected) this is plan mode: the
 * target is resolved, the session ensured and the exact argv returned, but
 * nothing is spawned. Attach only touches the terminals bookkeeping row — it
 * never affects tasks (ADR-0005).
 */

export interface AttachCommandOptions {
  shipRef?: string
  /** @deprecated Use `shipRef`; kept for backward compatibility. */
  museRef?: string
  windowName?: string
}

export interface AttachDeps {
  terminalManager?: TerminalManager
  spawnAttach?: AttachSpawnFn
}

export interface AttachCommandResult {
  shipId: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  /** Always 'host': native execution has no container. */
  containerName: string
  sessionName: string
  windowName: string | null
  sessionCreated: boolean
  argv: string[]
  attached: boolean
  exitCode: number | null
}

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
    if (ctx.loaded.config.sandbox.kind !== 'native') {
      assertNativeSandboxKind(ctx.loaded.config)
    }
    const target: AttachTarget = {
      sessionName: tmuxSessionName(ctx.loaded.config.project.name, ship.id),
      ...(opts.windowName !== undefined ? { windowName: opts.windowName } : {}),
    }
    const manager = deps.terminalManager ?? new NativeTerminalManager()

    let outcome: AttachOutcome
    try {
      outcome = await attachToShipTerminal({
        manager,
        target,
        ...(deps.spawnAttach !== undefined ? { spawnAttach: deps.spawnAttach } : {}),
      })
    } catch (e) {
      if (terminalFailureReason(e) === 'container_missing') {
        throw new TerminalUnavailableError(
          `host tmux session '${target.sessionName}' is unavailable`,
          { details: (e as TerminalUnavailableError).details },
        )
      }
      throw e
    }

    store.upsertTerminal({
      projectId,
      shipId: ship.id,
      sandboxId: null,
      tmuxSessionName: target.sessionName,
      state: 'present',
    })
    return {
      shipId: ship.id,
      museId: ship.id,
      containerName: 'host',
      sessionName: target.sessionName,
      windowName: outcome.windowName,
      sessionCreated: outcome.sessionCreated,
      argv: buildAttachArgv(target),
      attached: outcome.exitCode !== null,
      exitCode: outcome.exitCode,
    }
  } finally {
    store.close()
  }
}

/** @deprecated Use `attachShip`; kept for backward compatibility. */
export const attachMuse = attachShip
