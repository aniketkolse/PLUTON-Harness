import type { ShipRecord } from '../../domain/models.ts'
import { ensureShipContainer } from '../../sandbox/muse-containers.ts'
import type { SandboxLimits, SandboxManager, SandboxMount } from '../../sandbox/types.ts'
import type { Store } from '../../store/store.ts'

/**
 * Shared per-Ship container provisioning (ADR-0004): the mount layout and the
 * `ensureShipContainer` call `pluton run` performs for every enabled Ship in
 * container mode, extracted so the approvals inbox can instantiate an approved
 * `ship.create` specialist against a live docker-mode run without duplicating
 * the contract.
 *
 * Mount layout (unchanged from `prepareContainerMode`): every Ship container
 * receives the workspaces root (task checkouts) and its own engine home; ships
 * whose sessions run with the project root as workdir (every policy except
 * isolated-task-checkout) additionally get the project tree read-only.
 */

/** Container paths for the mounts every Ship container receives. */
export const CONTAINER_WORKSPACES_PATH = '/pluton/workspaces'
export const CONTAINER_ENGINE_HOME_PATH = '/pluton/engine-home'
export const CONTAINER_PROJECT_PATH = '/pluton/project'

export interface ShipContainerMountsOptions {
  ship: ShipRecord
  /** The project root (`ProjectContext.rootDir`). */
  rootDir: string
  /** Pluton's workspaces root (`workspaceDir(rootDir)`). */
  workspacesRoot: string
}

/**
 * The mounts a Ship's container must carry. The project tree is read-only for
 * every workspace policy except `isolated-task-checkout` (sessions of those
 * policies run with the project root as their workdir).
 */
export function shipContainerMounts(opts: ShipContainerMountsOptions): SandboxMount[] {
  return [
    { hostPath: opts.workspacesRoot, containerPath: CONTAINER_WORKSPACES_PATH },
    { hostPath: opts.ship.engineHome, containerPath: CONTAINER_ENGINE_HOME_PATH },
    ...(opts.ship.workspacePolicy !== 'isolated-task-checkout'
      ? [{ hostPath: opts.rootDir, containerPath: CONTAINER_PROJECT_PATH, readOnly: true }]
      : []),
  ]
}

export interface ProvisionShipContainerOptions {
  manager: SandboxManager
  store: Store
  projectId: string
  ship: ShipRecord
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
 * Ensure the Ship's container exists and is running for the given image,
 * limits, network policy and mounts. Idempotent; see `ensureShipContainer` for
 * the reuse/staleness rules.
 */
export async function provisionShipContainer(
  opts: ProvisionShipContainerOptions,
): Promise<{ containerName: string; created: boolean }> {
  return ensureShipContainer(opts.manager, opts.store, {
    projectId: opts.projectId,
    shipId: opts.ship.id,
    image: opts.image,
    ...(opts.imageId !== undefined ? { imageId: opts.imageId } : {}),
    limits: opts.limits,
    network: opts.network,
    ...(opts.customNetwork !== undefined ? { customNetwork: opts.customNetwork } : {}),
    ...(opts.containerUser !== undefined ? { containerUser: opts.containerUser } : {}),
    mounts: shipContainerMounts({
      ship: opts.ship,
      rootDir: opts.rootDir,
      workspacesRoot: opts.workspacesRoot,
    }),
  })
}

/** @deprecated Use `shipContainerMounts`; kept for backward compatibility. */
export const museContainerMounts = shipContainerMounts
/** @deprecated Use `ProvisionShipContainerOptions`; kept for backward compatibility. */
export type ProvisionMuseContainerOptions = ProvisionShipContainerOptions
/** @deprecated Use `provisionShipContainer`; kept for backward compatibility. */
export const provisionMuseContainer = provisionShipContainer
