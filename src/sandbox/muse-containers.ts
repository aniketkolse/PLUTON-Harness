import { SandboxUnavailableError } from '../domain/errors.ts'
import type { Store } from '../store/store.ts'
import {
  sandboxContainerName,
  type SandboxInspect,
  type SandboxLimits,
  type SandboxManager,
  type SandboxMount,
} from './types.ts'

/**
 * Per-Muse container provisioning (ADR-0004, Phase B): one long-lived
 * container per (project, muse), created on first use and reused afterwards.
 * Container-mode engine sessions run through `docker exec` in these
 * containers, so every Pluton-created container carries the
 * `host.docker.internal:host-gateway` mapping and the loopback tool bridge is
 * reached from inside via `host.docker.internal`.
 *
 * Reuse safety: a container is reused only when it still matches the requested
 * spec — image ID, container user, mount set and host-gateway entry are read
 * back via `inspect`, and a stale Pluton-owned container (e.g. after an image
 * rebuild or a workspace-policy change) is removed and recreated. The removal
 * and the reuse `start()` both go through the managed-label guard — a
 * pre-existing container without the label is refused (PolicyDeniedError),
 * never adopted, and never removed by this path. A container whose state
 * cannot be determined fails closed.
 *
 * The record (one row per project+muse, `upsertSandbox`) is advisory state for
 * status/doctor; the container itself is the source of truth.
 */

/** Docker's special value: the host as seen from inside any container. */
export const HOST_GATEWAY_HOSTNAME = 'host.docker.internal'

/** The `/etc/hosts` mapping every Pluton-created container carries. */
export const HOST_GATEWAY_ADD_HOST = `${HOST_GATEWAY_HOSTNAME}:host-gateway`

/** The uid:gid the worker image creates (docker/worker/Dockerfile). */
const MUSE_CONTAINER_USER = '10001:10001'

export interface MuseContainerSpec {
  projectId: string
  museId: string
  image: string
  /**
   * Image ID the spec expects (from the worker-image probe); a running
   * container built from a different image is stale and recreated. Absent =
   * the image ID cannot be checked here (mounts/user/gateway are still).
   */
  imageId?: string
  limits: SandboxLimits
  network: 'restricted' | 'none' | 'open'
  mounts: SandboxMount[]
}

/**
 * Ensure the Muse's container exists and is running; returns its name and
 * whether this call created it. Idempotent for a matching container (label
 * re-validated, then a no-op `start`); a stale Pluton-owned container is
 * recreated, never adopted.
 */
export async function ensureMuseContainer(
  manager: SandboxManager,
  store: Store,
  spec: MuseContainerSpec,
): Promise<{ containerName: string; created: boolean }> {
  const containerName = sandboxContainerName(spec.projectId, spec.museId)
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
      const existing = store.getSandboxForMuse(spec.projectId, spec.museId)
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

  if (!reusable) {
    const result = await manager.create({
      projectId: spec.projectId,
      museId: spec.museId,
      image: spec.image,
      containerName,
      containerUser: MUSE_CONTAINER_USER,
      limits: { ...spec.limits },
      mounts: spec.mounts.map((m) => ({ ...m })),
      // Container creation carries no secrets or engine config: identity and
      // env arrive per-session at `docker exec` time (ADR-0008).
      env: {},
      network: spec.network,
      extraHosts: [HOST_GATEWAY_ADD_HOST],
    })
    containerId = result.containerId
    created = true
    await manager.start(containerName)
  }

  store.upsertSandbox({
    projectId: spec.projectId,
    museId: spec.museId,
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
function containerMatchesSpec(spec: MuseContainerSpec, info: SandboxInspect): boolean {
  if (info.user !== MUSE_CONTAINER_USER) return false
  if (spec.imageId !== undefined && info.imageId !== '' && info.imageId !== spec.imageId) return false
  if (!info.extraHosts.includes(HOST_GATEWAY_ADD_HOST)) return false
  if (info.mounts.length !== spec.mounts.length) return false
  return spec.mounts.every((m) =>
    info.mounts.some((x) => x.destination === m.containerPath && x.readOnly === (m.readOnly === true)),
  )
}
