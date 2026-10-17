import type { MuseRole } from './models.ts'

/**
 * The complete permission catalog. A Muse config can only name permissions from
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
  'result.collect',
  'muse.propose_create',
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
] as const

export type Permission = (typeof PERMISSIONS)[number]

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

/** Default permission sets per role — config may narrow these, never widen silently. */
export const ROLE_DEFAULT_PERMISSIONS: Readonly<Record<MuseRole, readonly Permission[]>> = {
  supervisor: [
    'project.read',
    'task.create',
    'task.delegate',
    'task.inspect',
    'task.cancel',
    'result.collect',
    'muse.propose_create',
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
  ],
  researcher: ['project.read', 'research.report', 'diff.inspect'],
  coder: ['project.read', 'project.write', 'tests.run', 'diff.inspect', 'verification.report', 'scope.declare', 'scope.release'],
  tester: ['project.read', 'tests.run', 'diff.inspect', 'verification.report', 'verification.run', 'scope.declare', 'scope.release'],
  reviewer: ['project.read', 'diff.inspect', 'tests.run', 'review.report'],
  custom: ['project.read'],
}
