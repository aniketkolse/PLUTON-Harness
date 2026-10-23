import { SandboxUnavailableError, ValidationError } from '../../domain/errors.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import { createNativeExecutionProvider } from '../../execution/factory.ts'
import {
  DEFAULT_WORKER_IMAGE_TAG,
  dispatchReadiness,
  WorkerImageManager,
  type WorkerImageProbe,
  type WorkerImageProfile,
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
  /** True when task dispatch could actually start a Ship container right now. */
  dispatchReady: boolean
}

export async function sandboxProbe(ctx: ProjectContext): Promise<SandboxProbeReport> {
  const config = ctx.loaded.config
  if (config.sandbox.kind === 'native') {
    const provider = createNativeExecutionProvider({ config, rootDir: ctx.rootDir })
    const probe = await provider.probe()
    await provider.close()
    return {
      sandbox: {
        available: probe.available,
        kind: 'native',
        detail: probe.detail,
        ...(probe.fix !== undefined ? { fix: probe.fix } : {}),
      },
      image: null,
      warnings: [
        probe.detail,
        'native execution runs engine processes directly on the host (partial enforcement); no worker image or container is used',
      ],
      dispatchReady: probe.available,
    }
  }

  const sandbox = createSandboxManager(config)
  const probe = await sandbox.probe()
  const warnings: string[] = []
  let image: WorkerImageProbe | null = null
  let imageProbeError: SandboxUnavailableError | null = null

  if (sandbox.kind === 'local-process') {
    warnings.push(LOCAL_PROCESS_WARNING)
  } else if (probe.available) {
    const tag = config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
    try {
      image = await new WorkerImageManager().probe(ctx.rootDir, tag)
    } catch (e) {
      // The daemon answered the sandbox probe but not the image inspect: a
      // probe/daemon problem, never "image not built" (the message carries the
      // daemon fix).
      if (!(e instanceof SandboxUnavailableError)) throw e
      imageProbeError = e
    }
    if (config.sandbox.image === undefined) {
      warnings.push(
        `sandbox.image is not set in pluton.yaml — using the default tag '${DEFAULT_WORKER_IMAGE_TAG}'; set it to pin the image this project runs`,
      )
    }
  } else {
    warnings.push(probe.fix ?? 'the Docker sandbox is unavailable — dispatch fails closed')
  }

  const readiness =
    imageProbeError !== null
      ? { ready: false, warnings: [imageProbeError.message] }
      : dispatchReadiness(probe.available, image)
  warnings.push(...readiness.warnings)

  return { sandbox: probe, image, warnings, dispatchReady: readiness.ready }
}

export interface BuildImageRequest {
  tag?: string
  base?: string
  /** `base` (default) = probe/terminal layer only; `engines` adds the pinned engine CLIs. */
  profile?: WorkerImageProfile
}

export async function sandboxBuildImage(ctx: ProjectContext, req: BuildImageRequest = {}): Promise<{
  record: WorkerImageRecord
  /** True when the config pins a different tag than the one just built. */
  configTagMismatch: boolean
}> {
  if (ctx.loaded.config.sandbox.kind === 'native') {
    throw new ValidationError(
      'sandbox.kind native runs host engine processes and does not use a container image; use sandbox.kind: docker to build and run worker images',
    )
  }
  const tag = req.tag ?? ctx.loaded.config.sandbox.image ?? DEFAULT_WORKER_IMAGE_TAG
  const record = await new WorkerImageManager().build(ctx.rootDir, {
    tag,
    ...(req.base !== undefined ? { base: req.base } : {}),
    ...(req.profile !== undefined ? { profile: req.profile } : {}),
  })
  const configured = ctx.loaded.config.sandbox.image
  return { record, configTagMismatch: configured !== undefined && configured !== tag }
}
