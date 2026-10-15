import { ValidationError } from '../domain/errors.ts'
import type { EngineAdapter } from './contract/types.ts'
import { MockEngineAdapter } from './mock/adapter.ts'
import { OpenCodeEngineAdapter } from './opencode/adapter.ts'
import { QwenEngineAdapter } from './qwen/adapter.ts'

export interface EngineFactory {
  kind: string
  description: string
  /** True for engines that exist only for tests/dev (must be labeled as such). */
  devOnly: boolean
  create: () => EngineAdapter
}

const factories = new Map<string, EngineFactory>()

export function registerEngine(factory: EngineFactory): void {
  factories.set(factory.kind, factory)
}

export function listEngineKinds(): EngineFactory[] {
  return [...factories.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

export function getEngineAdapter(kind: string): EngineAdapter {
  const f = factories.get(kind)
  if (!f) {
    const known = listEngineKinds().map((k) => k.kind).join(', ') || '(none registered)'
    throw new ValidationError(`unknown engine '${kind}'; known engines: ${known}`)
  }
  return f.create()
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
    create: () => new OpenCodeEngineAdapter(),
  })
  registerEngine({
    kind: 'qwen',
    description: 'Qwen Code CLI over ACP (stdio JSON-RPC; verified against v0.25.2; needs OPENAI_*/DASHSCOPE_* env or a per-Muse login)',
    devOnly: false,
    create: () => new QwenEngineAdapter(),
  })
}
