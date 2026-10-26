import { SandboxUnavailableError } from '../domain/errors.ts'
import type { Store } from '../store/store.ts'
import { expectedContainerNetworks } from './network.ts'
import { resolveContainerUser } from './user-mapping.ts'
import {
  sandboxContainerName,
  type SandboxInspect,
  type SandboxLimits,
  type SandboxManager,
  type SandboxMount,
} from './types.ts'

/**
 * Per-Ship container provisioning (ADR-0004, Phase B): one long-lived
 * container per (project, ship), created on first use and reused afterwards.
 * Container-mode engine sessions run through `docker exec` in these
 * containers, so every Pluton-created container carries the
 * `host.docker.internal:host-gateway` mapping and the loopback tool bridge is
 * reached from inside via `host.docker.internal`.
 *
 * Reuse safety: a container is reused only when it still matches the requested
 * spec — image ID, container user, mount set, host-gateway entry and the exact
 * Docker network set are read back via `inspect`, and a stale Pluton-owned
 * container (e.g. after an image rebuild, a workspace-policy change or a
 * network-policy change) is removed and recreated. The removal and the reuse
 * `start()` both go through the managed-label guard — a pre-existing container
 * without the label is refused (PolicyDeniedError), never adopted, and never
 * removed by this path. A container whose state cannot be determined fails
 * closed.
 *
 * The record (one row per project+ship, `upsertSandbox`) is advisory state for
 * status/doctor; the container itself is the source of truth.
 */

/** Docker's special value: the host as seen from inside any container. */
export const HOST_GATEWAY_HOSTNAME = 'host.docker.internal'

/** The `/etc/hosts` mapping every Pluton-created container carries. */
export const HOST_GATEWAY_ADD_HOST = `${HOST_GATEWAY_HOSTNAME}:host-gateway`

/** The uid:gid the worker image creates (docker/worker/Dockerfile). */
const SHIP_CONTAINER_USER = '10001:10001'

export interface ShipContainerSpec {
  projectId: string
  shipId?: string
  /** @deprecated Use `shipId`; kept for backward compatibility. */
  museId?: string
  image: string
  /**
   * Image ID the spec expects (from the worker-image probe); a running
   * container built from a different image is stale and recreated. Absent =
   * the image ID cannot be checked here (mounts/user/gateway are still).
   */
  imageId?: string
  limits: SandboxLimits
  network: 'restricted' | 'none' | 'open'
  customNetwork?: string
  mounts: SandboxMount[]
  /**
   * Numeric non-root container user (uid or uid:gid) for file ownership alignment.
   * If omitted, resolved via resolveContainerUser().
   */
  containerUser?: string
}

/**
 * Ensure the Ship's container exists and is running; returns its name and
 * whether this call created it. Idempotent for a matching container (label
 * re-validated, then a no-op `start`); a stale Pluton-owned container is
 * recreated, never adopted.
 */
export async function ensureShipContainer(
  manager: SandboxManager,
  store: Store,
  spec: ShipContainerSpec,
): Promise<{ containerName: string; created: boolean }> {
  const shipId = spec.shipId ?? spec.museId ?? 'unknown'
  const containerName = sandboxContainerName(spec.projectId, shipId)
  const status = await manager.status(containerName)
  if (status === 'unknown') {
    throw new SandboxUnavailableError(
      `cannot determine the state of container '${containerName}' — is the Docker daemon reachable?`,
      { details: { containerName } },
    )
  }

  let created = false
  let containerId: string | null = null
  let reusable = false
  if (status === 'running' || status === 'stopped') {
    const info = await manager.inspect(containerName)
    if (info === null || containerMatchesSpec(spec, info)) {
      reusable = true
      // start() validates the managed label first; `docker start` on a running
      // container is a no-op success, so this is safe for both states.
      await manager.start(containerName)
      const existing = store.getSandboxForShip(spec.projectId, shipId)
      if (existing !== null && existing.containerName === containerName) {
        containerId = existing.containerId
      }
    } else {
      // Stale Pluton-owned container (rebuilt image, changed mounts/policy,
      // older layout): remove it and recreate from the current spec. remove()
      // is managed-label guarded — a foreign container is refused, not removed.
      await manager.remove(containerName)
    }
  }

  const resolvedUser = spec.containerUser ?? resolveContainerUser().containerUser

  if (!reusable) {
    const result = await manager.create({
      projectId: spec.projectId,
      shipId,
      museId: shipId,
      image: spec.image,
      containerName,
      containerUser: resolvedUser,
      limits: { ...spec.limits },
      mounts: spec.mounts.map((m) => ({ ...m })),
      // Container creation carries no secrets or engine config: identity and
      // env arrive per-session at `docker exec` time (ADR-0008).
      env: {},
      network: spec.network,
      ...(spec.customNetwork !== undefined ? { customNetwork: spec.customNetwork } : {}),
      extraHosts: [HOST_GATEWAY_ADD_HOST],
    })
    containerId = result.containerId
    created = true
    await manager.start(containerName)
  }

  store.upsertSandbox({
    projectId: spec.projectId,
    shipId,
    kind: manager.kind,
    containerName,
    containerId,
    image: spec.image,
    state: 'running',
    createdBy: 'run',
  })
  return { containerName, created }
}

/** Reuse predicate: the container must still serve the requested spec exactly. */
function containerMatchesSpec(spec: ShipContainerSpec, info: SandboxInspect): boolean {
  const expectedUser = spec.containerUser ?? resolveContainerUser().containerUser
  if (info.user !== expectedUser) return false
  if (spec.imageId !== undefined && info.imageId !== '' && info.imageId !== spec.imageId) return false
  if (!info.extraHosts.includes(HOST_GATEWAY_ADD_HOST)) return false
  if (!containerNetworksMatch(spec, info.networks)) return false
  if (info.mounts.length !== spec.mounts.length) return false
  return spec.mounts.every((m) =>
    info.mounts.some((x) => x.destination === m.containerPath && x.readOnly === (m.readOnly === true)),
  )
}

/**
 * `--network none` removes every endpoint, and Docker has reported both `{}`
 * and `{none: …}` for that mode across versions. Both mean "no egress"; any
 * other attachment is stale. Every other policy requires the exact set.
 */
function containerNetworksMatch(spec: ShipContainerSpec, actual: string[]): boolean {
  if (spec.network === 'none') {
    return actual.length === 0 || (actual.length === 1 && actual[0] === 'none')
  }
  return sameNetworkSet(actual, expectedContainerNetworks(spec))
}

/** Exact set equality: an extra network (e.g. a later `docker network connect bridge`) is stale. */
function sameNetworkSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false
  const a = [...actual].sort()
  const b = [...expected].sort()
  return a.every((name, i) => name === b[i])
}

/** @deprecated Use `ShipContainerSpec`; kept for backward compatibility. */
export type MuseContainerSpec = ShipContainerSpec
/** @deprecated Use `ensureShipContainer`; kept for backward compatibility. */
export const ensureMuseContainer = ensureShipContainer
