import { randomBytes } from 'node:crypto'

/**
 * Stable, generated IDs. A user-provided title or name is NEVER an identifier.
 * Shape: `<prefix>_<base36 timestamp><8 random hex chars>` — collision-safe for
 * local use, roughly time-sortable, and readable in logs.
 */
export const ID_PREFIXES = [
  'project',
  'muse',
  'run',
  'task',
  'attempt',
  'workspace',
  'sandbox',
  'terminal',
  'request',
  'event',
  'approval',
  'verification',
  'session',
] as const

export type IdPrefix = (typeof ID_PREFIXES)[number]

const ID_RE = /^[a-z]+_[0-9a-z]{5,}[0-9a-f]{8}$/

export function newId(prefix: IdPrefix): string {
  const time = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return `${prefix}_${time}${rand}`
}

export function isId(value: string): boolean {
  return ID_RE.test(value)
}

export function idPrefix(id: string): string | undefined {
  const idx = id.indexOf('_')
  return idx > 0 ? id.slice(0, idx) : undefined
}

/** Short display form: last 6 chars after the underscore. */
export function shortId(id: string): string {
  const idx = id.lastIndexOf('_')
  const tail = idx >= 0 ? id.slice(idx + 1) : id
  return tail.slice(-6)
}

const SLUG_MAX = 48

/**
 * Strict slug used for filesystem paths, tmux session names, branch names and
 * container labels. Never trust user input here: everything outside
 * [a-z0-9-] is dropped, runs collapse, edges are trimmed, and an empty result
 * becomes 'unnamed' so a path is always produced deliberately.
 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return s.length > 0 ? s : 'unnamed'
}
