import type { ShipRole } from './models.ts'

/**
 * The complete permission catalog. A Ship config can only name permissions from
 * this list; anything else is a config error (never silently ignored).
 * Enforcement happens per call in the runtime/tool bridge — this list only
 * declares what exists.
 */
export const PERMISSIONS = [
  'project.read',
  'project.write',
  'tests.run',
  'diff.inspect',
  'research.report',
  'review.report',
  'verification.report',
  'task.create',
  'task.delegate',
  'task.inspect',
  'task.cancel',
  'task.request_revision',
  'result.collect',
  /** @deprecated Use ship.propose_create; kept for backward compatibility with existing configs. */
  'muse.propose_create',
  'ship.propose_create',
  'verification.run',
  'approval.request',
  'run.stop',
  'project.status',
  'run.list',
  'run.inspect',
  'run.start',
  'approvals.list',
  'scope.declare',
  'scope.release',
  'worker.message',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

/** Maps deprecated permission names to their canonical equivalents. */
export const PERMISSION_ALIASES: Readonly<Record<string, string>> = {
  'muse.propose_create': 'ship.propose_create',
}

/** Normalizes a permission string, resolving deprecated `muse.*` aliases to canonical `ship.*` names. */
export function normalizePermission(perm: string): string {
  return PERMISSION_ALIASES[perm] ?? perm
}

/** Default permission sets per role — config may narrow these, never widen silently. */
export const ROLE_DEFAULT_PERMISSIONS: Readonly<Record<ShipRole, readonly Permission[]>> = {
  supervisor: [
    'project.read',
    'project.write',
    'tests.run',
    'research.report',
    'review.report',
    'verification.report',
    'task.create',
    'task.delegate',
    'task.inspect',
    'task.cancel',
    // CS-5: manager-only — send a `failed` task back for one bounded revision.
    'task.request_revision',
    'result.collect',
    'ship.propose_create',
    'verification.run',
    'diff.inspect',
    'approval.request',
    'project.status',
    'run.list',
    'run.inspect',
    'run.start',
    'approvals.list',
    'scope.declare',
    'scope.release',
    'worker.message',
  ],
  researcher: ['project.read', 'research.report', 'diff.inspect', 'worker.message'],
  coder: [
    'project.read',
    'project.write',
    'tests.run',
    'diff.inspect',
    'verification.report',
    'scope.declare',
    'scope.release',
    'worker.message',
  ],
  tester: [
    'project.read',
    'tests.run',
    'diff.inspect',
    'verification.report',
    'verification.run',
    'scope.declare',
    'scope.release',
    'worker.message',
  ],
  reviewer: ['project.read', 'diff.inspect', 'tests.run', 'review.report', 'worker.message'],
  custom: ['project.read'],
}
