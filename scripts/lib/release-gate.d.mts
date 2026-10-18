/** Type declarations for the release-gate helper library (plain ESM for `node`). */

export interface LeakPattern {
  label: string
  regex: RegExp
}

export type GateStatus = 'pass' | 'fail' | 'not-tested' | 'blocked'

export interface GateResult {
  id?: string
  label: string
  status: GateStatus
  detail?: string
  fix?: string
}

export interface GateSummary {
  total: number
  passed: number
  failed: number
  notTested: number
  blocked: number
  technical: 'PASS' | 'FAIL'
  exitCode: number
}

export const REQUIRED_PACK_FILES: string[]
export const STATUS: {
  readonly PASS: 'pass'
  readonly FAIL: 'fail'
  readonly NOT_TESTED: 'not-tested'
  readonly BLOCKED: 'blocked'
}
export function parsePackManifest(raw: string): { files: string[] }
export function formatErrorDetail(err: unknown, maxLines?: number): string
export function findForbiddenPackFiles(files: string[]): string[]
export function buildLeakPatterns(opts: {
  homeDir: string
  repoRoot: string
  platform?: NodeJS.Platform
}): LeakPattern[]
export function scanTextForLeaks(text: string, patterns: LeakPattern[]): string[]
export function findContentLeaks(opts: {
  files: string[]
  readFile: (file: string) => string
  patterns: LeakPattern[]
}): { file: string; label: string }[]
export function findBrokenRelativeLinks(text: string, exists: (target: string) => boolean): string[]
export function sameDepMap(a: unknown, b: unknown): boolean
export function summarize(results: GateResult[]): GateSummary
export function renderResultLine(result: GateResult): string
