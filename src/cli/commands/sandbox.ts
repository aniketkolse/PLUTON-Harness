import { createSandboxManager } from '../../sandbox/factory.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  WorkerImageManager,
  type WorkerImageProbe,
  type WorkerImageRecord,
} from '../../sandbox/image.ts'
import { LOCAL_PROCESS_WARNING } from '../../sandbox/local-process.ts'
import type { SandboxProbe } from '../../sandbox/types.ts'
import type { ProjectContext } from '../context.ts'

/**
 * `pluton sandbox` — the substrate commands (ADR-0004): probe what this machine
 * can actually provide, and provision the worker image as an explicit step.
 * Nothing here builds images or mutates config implicitly.
 */

export interface SandboxProbeReport {
  sandbox: SandboxProbe
  image: WorkerImageProbe | null
  /** Non-fatal findings the operator must see (degraded mode, missing image). */
  warnings: string[]
  /** True when task dispatch could actually start a Muse container right now. */
  dispatchReady: boolean
}

export async function sandboxProbe(ctx: ProjectContext): Promise<SandboxProbeReport> {
  const config = ctx.loaded.config
  const sandbox = createSandboxManager(config)
  const probe = await sandbox.probe()
  const warnings: string[] = []
  let image: WorkerImageProbe | null = null
  let dispatchReady = probe.available

  if (sandbox.kind === 'local-process') {
    warnings.push(LOCAL_PROCESS_WARNING)
  } else if (probe.available) {
    const tag = config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
    image = await new WorkerImageManager().probe(ctx.rootDir, tag)
    if (!image.present) {
      dispatchReady = false
      warnings.push(`worker image '${tag}' is not built — run \`pluton sandbox build-image\` before dispatching tasks`)
    } else if (!image.matchesRecord) {
      warnings.push(image.detail)
    }
    if (config.sandbox.image === undefined) {
      warnings.push(
        `sandbox.image is not set in pluton.yaml — using the default tag '${DEFAULT_WORKER_IMAGE_TAG}'; set it to pin the image this project runs`,
      )
    }
  } else {
    dispatchReady = false
    warnings.push(probe.fix ?? 'the Docker sandbox is unavailable — dispatch fails closed')
  }

  return { sandbox: probe, image, warnings, dispatchReady }
}

export interface BuildImageRequest {
  tag?: string
  base?: string
}

export async function sandboxBuildImage(ctx: ProjectContext, req: BuildImageRequest = {}): Promise<{
  record: WorkerImageRecord
  /** True when the config pins a different tag than the one just built. */
  configTagMismatch: boolean
}> {
  const tag = req.tag ?? ctx.loaded.config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
  const record = await new WorkerImageManager().build(ctx.rootDir, {
    tag,
    ...(req.base !== undefined ? { base: req.base } : {}),
  })
  const configured = ctx.loaded.config.sandbox.image
  return { record, configTagMismatch: configured !== undefined && configured !== tag }
}
