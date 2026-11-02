import type { ShipRecord } from '../domain/models.ts'
import { engineAdapterForShip } from '../engines/approval.ts'
import type {
  EngineAdapter,
  EngineSession,
  StartSessionRequest,
} from '../engines/contract/types.ts'
import type { EngineCreateOptions } from '../engines/registry.ts'
import { engineSpawnsProcess } from '../engines/registry.ts'
import type {
  ExecutionProvider,
  ExecutionSessionSpec,
} from './native.ts'

/**
 * Wrap a real engine adapter so every engine the adapter spawns goes through
 * a native execution session. Discovery/model/auth calls stay on the normal
 * host adapter; only process creation moves behind the provider.
 *
 * Session ownership: the returned adapter owns the execution session and closes
 * it after the engine session closes (or after a failed start).
 */
export function nativeAdapterFor(
  ship: ShipRecord,
  args: {
    provider: ExecutionProvider
    isolatedCheckout: boolean
    specFor: (req: StartSessionRequest) => ExecutionSessionSpec
    platform?: NodeJS.Platform
    engineOptions?: EngineCreateOptions
  },
): EngineAdapter {
  const baseOptions: EngineCreateOptions = {
    ...(args.platform !== undefined ? { platform: args.platform } : {}),
    isolatedCheckout: args.isolatedCheckout,
    ...(args.engineOptions ?? {}),
  }
  const base = engineAdapterForShip(ship, baseOptions)

  // HTTP engines create no OS process, so there is no execution session to
  // prepare. Wrapping them would pretend a sandbox boundary this provider
  // cannot place around network calls; return the adapter directly instead.
  if (!engineSpawnsProcess(ship.engineKind)) return base

  const adapter: EngineAdapter = {
    kind: base.kind,
    capabilities: () => base.capabilities(),
    discover: () => base.discover(),
    listModels: () => base.listModels(),
    authStatus: (configDir) => base.authStatus(configDir),
    startSession: async (req: StartSessionRequest): Promise<EngineSession> => {
      const execution = await args.provider.prepare(args.specFor(req))
      let session: EngineSession
      try {
        const inner = engineAdapterForShip(ship, {
          ...baseOptions,
          spawnFn: (command, spawnArgs, options) =>
            execution.spawn(command, spawnArgs, options),
        })
        session = await inner.startSession(req)
      } catch (error) {
        await execution.close()
        throw error
      }
      let closed = false
      return {
        info: session.info,
        sendPrompt: (prompt) => session.sendPrompt(prompt),
        interrupt: () => session.interrupt(),
        close: async () => {
          if (closed) return
          closed = true
          try {
            await session.close()
          } finally {
            await execution.close()
          }
        },
      }
    },
  }
  if (base.listModelsWithAvailability !== undefined) {
    adapter.listModelsWithAvailability = (candidates) =>
      base.listModelsWithAvailability?.(candidates) ?? Promise.resolve([])
  }
  return adapter
}
