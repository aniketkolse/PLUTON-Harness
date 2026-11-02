import { ValidationError } from '../domain/errors.ts'
import type { AcpSpawnFn } from './acp/client.ts'
import type { RetryOptions } from './acp/retry.ts'
import type { EngineAdapter } from './contract/types.ts'
import { MockEngineAdapter } from './mock/adapter.ts'
import { OpenAICompatibleAdapter } from './openai-compatible/adapter.ts'
import { OpenCodeEngineAdapter } from './opencode/adapter.ts'

/**
 * Creation options threaded to real adapters: container mode pins in-image
 * binaries and swaps the process spawn (`docker exec`); tests inject spawns.
 */
export interface EngineCreateOptions {
  spawnFn?: AcpSpawnFn
  binaryPath?: string
  platform?: NodeJS.Platform
  spawnRetry?: RetryOptions
  /**
   * Maps a host working directory to the engine's namespace (container mode:
   * the ACP session cwd must name a container path; the process spawn cwd is
   * mapped separately by the spawn function). Absent = identity.
   */
  mapWorkdir?: (hostPath: string) => string
  /**
   * Runtime-proven session isolation: true only when the session's workdir is
   * a Pluton-owned throwaway task checkout (never inferred from a mode name).
   * Absent/false = the fail-closed default shared by project-root sessions.
   */
  isolatedCheckout?: boolean
  /** Project root used to resolve project-local provider metadata and credentials. */
  rootDir?: string
  /** Explicit provider id selected by the Ship; absent means resolve by engine. */
  providerId?: string
}

export interface EngineFactory {
  kind: string
  description: string
  /** True for engines that exist only for tests/dev (must be labeled as such). */
  devOnly: boolean
  /**
   * Whether this engine spawns a child process. HTTP adapters report false so
   * the native execution wrapper (sandbox process supervision) is bypassed.
   * Absent = true: the conservative default for process engines.
   */
  spawnsProcess?: boolean
  create: (opts?: EngineCreateOptions) => EngineAdapter
}

const factories = new Map<string, EngineFactory>()

export function registerEngine(factory: EngineFactory): void {
  factories.set(factory.kind, factory)
}

export function listEngineKinds(): EngineFactory[] {
  return [...factories.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

export function getEngineAdapter(kind: string, opts: EngineCreateOptions = {}): EngineAdapter {
  const f = factories.get(kind)
  if (!f) {
    const known = listEngineKinds().map((k) => k.kind).join(', ') || '(none registered)'
    throw new ValidationError(`unknown engine '${kind}'; known engines: ${known}`)
  }
  return f.create(opts)
}

/**
 * Whether an engine creates an OS process. Non-process (HTTP) engines must not
 * be wrapped in the native execution provider: there is nothing to spawn and
 * preparing a sandbox session for them would be a fake security boundary.
 */
export function engineSpawnsProcess(kind: string): boolean {
  const f = factories.get(kind)
  if (!f) {
    const known = listEngineKinds().map((k) => k.kind).join(', ') || '(none registered)'
    throw new ValidationError(`unknown engine '${kind}'; known engines: ${known}`)
  }
  return f.spawnsProcess !== false
}

/** Built-in registrations. Real engines are appended as their adapters land. */
export function registerBuiltinEngines(): void {
  registerEngine({
    kind: 'mock',
    description: 'deterministic mock engine (tests/dev only; no model inference)',
    devOnly: true,
    create: () => new MockEngineAdapter(),
  })
  registerEngine({
    kind: 'opencode',
    description: 'OpenCode CLI over ACP (stdio JSON-RPC; verified against v2.0.29)',
    devOnly: false,
    create: (opts) => new OpenCodeEngineAdapter(opts ?? {}),
  })
  registerEngine({
    kind: 'openai-compatible',
    description:
      'OpenAI-compatible HTTP providers (chat completions + Pluton tool bridge; no local process)',
    devOnly: false,
    spawnsProcess: false,
    create: (opts) => new OpenAICompatibleAdapter(opts ?? {}),
  })
}
