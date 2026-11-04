import type { ShipRecord } from '../domain/models.ts'
import type { ResolvedExecutionRoute } from '../engines/execution-router.ts'
import type {
  EngineAdapter,
  EngineSession,
  StartSessionRequest,
} from '../engines/contract/types.ts'
import type { EngineCreateOptions } from '../engines/registry.ts'
import { engineSpawnsProcess } from '../engines/registry.ts'
import { nativeAdapterFor } from './adapter.ts'
import type { ExecutionProvider, ExecutionSessionSpec } from './native.ts'

/**
 * Build the execution adapter for a resolved route.
 *
 * The route decides the engine and provider; the caller's Ship only supplies
 * approval, workspace, and execution-sandbox facts. HTTP engines are not
 * wrapped in the process sandbox (there is no process to contain), but every
 * session — HTTP or process — receives the provider-local model id.
 */
export function adapterForResolvedRoute(args: {
  route: ResolvedExecutionRoute
  ship: ShipRecord
  provider?: ExecutionProvider
  isolatedCheckout: boolean
  specFor: (req: StartSessionRequest) => ExecutionSessionSpec
  engineOptions?: EngineCreateOptions
  platform?: NodeJS.Platform
}): EngineAdapter {
  const engineKind = args.route.identity.engineKind
  let base: EngineAdapter
  if (engineSpawnsProcess(engineKind) && args.provider !== undefined) {
    base = nativeAdapterFor(
      { ...args.ship, engineKind },
      {
        provider: args.provider,
        isolatedCheckout: args.isolatedCheckout,
        specFor: args.specFor,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
        engineOptions: {
          ...(args.engineOptions ?? {}),
          providerId: args.route.provider?.id,
        },
      },
    )
  } else {
    base = args.route.adapter
  }

  if (args.route.providerModelId === args.route.identity.modelId) return base

  const adapter: EngineAdapter = {
    kind: base.kind,
    capabilities: () => base.capabilities(),
    discover: () => base.discover(),
    listModels: () => base.listModels(),
    authStatus: (configDir) => base.authStatus(configDir),
    startSession: (req: StartSessionRequest): Promise<EngineSession> => {
      const routed: StartSessionRequest = {
        ...req,
        ...(req.ship !== undefined ? { ship: { ...req.ship, model: args.route.providerModelId } } : {}),
        ...(req.muse !== undefined ? { muse: { ...req.muse, model: args.route.providerModelId } } : {}),
      }
      return base.startSession(routed)
    },
  }
  if (base.listModelsWithAvailability !== undefined) {
    adapter.listModelsWithAvailability = (candidates) =>
      base.listModelsWithAvailability?.(candidates) ?? Promise.resolve([])
  }
  return adapter
}
