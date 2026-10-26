import { createNativeExecutionProvider } from '../../execution/factory.ts'
import type { ProjectContext } from '../context.ts'

/**
 * `pluton sandbox` — the execution substrate probe (ADR-0013). Native host
 * execution is the only substrate; there is no image to build and no container
 * runtime to contact. Nothing here mutates config or starts a process.
 */

export interface SandboxProbeReport {
  sandbox: {
    available: boolean
    kind: 'native'
    detail: string
    fix?: string
  }
  /** Non-fatal findings the operator must see. */
  warnings: string[]
  /** True when task dispatch could actually start a confined engine now. */
  dispatchReady: boolean
}

export async function sandboxProbe(ctx: ProjectContext): Promise<SandboxProbeReport> {
  const provider = createNativeExecutionProvider({
    config: ctx.loaded.config,
    rootDir: ctx.rootDir,
  })
  try {
    const probe = await provider.probe()
    const warnings = [
      probe.detail,
      'native execution runs engine processes directly on the host; no worker image or container is used',
    ]
    return {
      sandbox: {
        available: probe.available,
        kind: 'native',
        detail: probe.detail,
        ...(probe.fix !== undefined ? { fix: probe.fix } : {}),
      },
      warnings: [...new Set(warnings)],
      dispatchReady: probe.available,
    }
  } finally {
    await provider.close()
  }
}
