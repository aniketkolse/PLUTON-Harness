import { spawn } from 'node:child_process'
import { TerminalUnavailableError, ValidationError } from '../domain/errors.ts'
import { assertSafeTmuxName } from './names.ts'
import type { TerminalManager } from './types.ts'

/**
 * Interactive attach seam (ADR-0005). `pluton attach` is exactly one child
 * process: `docker exec -it <container> tmux attach-session -t <target>` with
 * the user's terminal inherited. There is no host shell and no shell string —
 * the argv is built here, validated here, and spawned as an array.
 *
 * The tmux session is ensured through the TerminalManager first (always inside
 * the container, never on the host): attaching to a Muse that never ran still
 * works, and detaching never affects tasks.
 */

export interface AttachTarget {
  containerName: string
  sessionName: string
  windowName?: string
}

/** Same grammar as tmux names: no target-syntax metacharacters can survive. */
const SAFE_CONTAINER_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Exact-match tmux targets (`=name`, `=name:=window`), validated names.
 * `=` forces exact session matching so a prefix-named session can never alias.
 */
export function buildAttachArgv(target: AttachTarget): string[] {
  assertSafeTmuxName('session', target.sessionName)
  if (!SAFE_CONTAINER_RE.test(target.containerName)) {
    throw new ValidationError(
      `unsafe container name '${target.containerName}': expected ${String(SAFE_CONTAINER_RE)}`,
    )
  }
  let tmuxTarget = `=${target.sessionName}`
  if (target.windowName !== undefined) {
    assertSafeTmuxName('window', target.windowName)
    tmuxTarget += `:=${target.windowName}`
  }
  return ['docker', 'exec', '-it', target.containerName, 'tmux', 'attach-session', '-t', tmuxTarget]
}

/** Resolves the child exit code; throws when it cannot spawn. */
export type AttachSpawnFn = (argv: string[]) => Promise<number>

/** Default spawn: node:child_process spawn with stdio 'inherit'. */
export function inheritStdioSpawn(argv: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const bin = argv[0]
    if (bin === undefined) {
      reject(new Error('attach argv must not be empty'))
      return
    }
    const child = spawn(bin, argv.slice(1), { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
}

export interface AttachOutcome {
  containerName: string
  sessionName: string
  windowName: string | null
  sessionCreated: boolean
  /** null in plan mode (no spawn). */
  exitCode: number | null
}

export interface AttachDeps {
  sandboxKind: 'docker' | 'local-process'
  manager: TerminalManager
  target: AttachTarget
  /** Absent = plan mode: ensure the session, build the argv, do not spawn. */
  spawnAttach?: AttachSpawnFn
}

export async function attachToMuseTerminal(deps: AttachDeps): Promise<AttachOutcome> {
  const { sandboxKind, manager, target } = deps
  if (sandboxKind === 'local-process') {
    throw new ValidationError(
      'pluton attach requires container-mode Muses (sandbox.kind: docker): tmux sessions live inside the Muse container, not on the host',
    )
  }
  // Validate the target (and have the exact argv ready) even in plan mode.
  const argv = buildAttachArgv(target)
  const session = await manager.ensureSession(target.containerName, target.sessionName)
  if (target.windowName !== undefined) {
    await manager.ensureWindow(target.containerName, target.sessionName, target.windowName)
  }
  const base: Omit<AttachOutcome, 'exitCode'> = {
    containerName: target.containerName,
    sessionName: target.sessionName,
    windowName: target.windowName ?? null,
    sessionCreated: session.created,
  }
  if (deps.spawnAttach === undefined) return { ...base, exitCode: null }
  let exitCode: number
  try {
    exitCode = await deps.spawnAttach(argv)
  } catch (e) {
    throw new TerminalUnavailableError(
      `could not start docker exec for attach: ${e instanceof Error ? e.message : String(e)}`,
      {
        details: {
          reason: 'exec_failed',
          containerName: target.containerName,
          sessionName: target.sessionName,
        },
        fix: 'is Docker Desktop running and `docker` on PATH? (`docker version`)',
      },
    )
  }
  return { ...base, exitCode }
}
