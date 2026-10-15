import { ValidationError } from '../domain/errors.ts'
import type { EngineAdapter } from './contract/types.ts'
import { MockEngineAdapter } from './mock/adapter.ts'

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
}
