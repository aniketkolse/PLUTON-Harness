import type { MuseRecord } from '../../domain/models.ts'
import { ensureMuseContainer } from '../../sandbox/muse-containers.ts'
import type { SandboxLimits, SandboxManager, SandboxMount } from '../../sandbox/types.ts'
import type { Store } from '../../store/store.ts'

/**
 * Shared per-Muse container provisioning (ADR-0004): the mount layout and the
 * `ensureMuseContainer` call `pluton run` performs for every enabled Muse in
 * container mode, extracted so the approvals inbox can instantiate an approved
 * `muse.create` specialist against a live docker-mode run without duplicating
 * the contract.
 *
 * Mount layout (unchanged from `prepareContainerMode`): every Muse container
 * receives the workspaces root (task checkouts) and its own engine home; muses
 * whose sessions run with the project root as workdir (every policy except
 * isolated-task-checkout) additionally get the project tree read-only.
 */

/** Container paths for the mounts every Muse container receives. */
export const CONTAINER_WORKSPACES_PATH = '/pluton/workspaces'
export const CONTAINER_ENGINE_HOME_PATH = '/pluton/engine-home'
export const CONTAINER_PROJECT_PATH = '/pluton/project'

export interface MuseContainerMountsOptions {
  muse: MuseRecord
  /** The project root (`ProjectContext.rootDir`). */
  rootDir: string
  /** Pluton's workspaces root (`workspaceDir(rootDir)`). */
  workspacesRoot: string
}

/**
 * The mounts a Muse's container must carry. The project tree is read-only for
 * every workspace policy except `isolated-task-checkout` (sessions of those
 * policies run with the project root as their workdir).
 */
export function museContainerMounts(opts: MuseContainerMountsOptions): SandboxMount[] {
  return [
    { hostPath: opts.workspacesRoot, containerPath: CONTAINER_WORKSPACES_PATH },
    { hostPath: opts.muse.engineHome, containerPath: CONTAINER_ENGINE_HOME_PATH },
    ...(opts.muse.workspacePolicy !== 'isolated-task-checkout'
      ? [{ hostPath: opts.rootDir, containerPath: CONTAINER_PROJECT_PATH, readOnly: true }]
      : []),
  ]
}

export interface ProvisionMuseContainerOptions {
  manager: SandboxManager
  store: Store
  projectId: string
  muse: MuseRecord
  image: string
  /** Absent = the image ID cannot be checked (mounts/user/gateway still are). */
  imageId?: string
  limits: SandboxLimits
  network: 'restricted' | 'none' | 'open'
  customNetwork?: string
  rootDir: string
  workspacesRoot: string
  /** Numeric non-root container user (uid or uid:gid) for file ownership alignment. */
  containerUser?: string
}

/**
 * Ensure the Muse's container exists and is running for the given image,
 * limits, network policy and mounts. Idempotent; see `ensureMuseContainer` for
 * the reuse/staleness rules.
 */
export async function provisionMuseContainer(
  opts: ProvisionMuseContainerOptions,
): Promise<{ containerName: string; created: boolean }> {
  return ensureMuseContainer(opts.manager, opts.store, {
    projectId: opts.projectId,
    museId: opts.muse.id,
    image: opts.image,
    ...(opts.imageId !== undefined ? { imageId: opts.imageId } : {}),
    limits: opts.limits,
    network: opts.network,
    ...(opts.customNetwork !== undefined ? { customNetwork: opts.customNetwork } : {}),
    ...(opts.containerUser !== undefined ? { containerUser: opts.containerUser } : {}),
    mounts: museContainerMounts({
      muse: opts.muse,
      rootDir: opts.rootDir,
      workspacesRoot: opts.workspacesRoot,
    }),
  })
}
