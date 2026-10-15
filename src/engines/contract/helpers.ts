import { CapabilityError } from '../../domain/errors.ts'
import type { EngineAdapter, EngineCapabilities } from './types.ts'

/** Fail loudly rather than fabricating support for an engine feature. */
export function requireCapability(
  adapter: EngineAdapter,
  capability: keyof EngineCapabilities,
): void {
  if (!adapter.capabilities()[capability]) {
    throw new CapabilityError(adapter.kind, capability)
  }
}
