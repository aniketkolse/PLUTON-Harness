import type { EnginePermissionChannel, EnginePermissionRequest } from '../../src/engines/interactive-approval.ts'

/**
 * Test double for the operator approval channel: records forwarded requests
 * and lets the test settle them by hand (no timers, no store).
 */
export interface ControlledChannel {
  channel: EnginePermissionChannel
  requests: EnginePermissionRequest[]
  /** Resolves with the first forwarded request (the engine is then waiting). */
  whenRequested: Promise<EnginePermissionRequest>
  respond(decision: 'allow' | 'deny'): void
  aborted: string[]
}

export function controlledChannel(): ControlledChannel {
  const requests: EnginePermissionRequest[] = []
  const aborted: string[] = []
  let pending: Array<(decision: 'allow' | 'deny') => void> = []
  let firstRequest!: (req: EnginePermissionRequest) => void
  const whenRequested = new Promise<EnginePermissionRequest>((resolve) => {
    firstRequest = resolve
  })
  return {
    requests,
    whenRequested,
    aborted,
    channel: {
      requestPermission: (req) => {
        requests.push(req)
        firstRequest(req)
        return new Promise((resolve) => {
          pending.push(resolve)
        })
      },
      abort: (reason) => {
        aborted.push(reason)
        const waiters = pending
        pending = []
        for (const resolve of waiters) resolve('deny')
      },
    },
    respond: (decision) => {
      const waiters = pending
      pending = []
      for (const resolve of waiters) resolve(decision)
    },
  }
}
