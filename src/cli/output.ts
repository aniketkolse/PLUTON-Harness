import { errorToJson, type PlutonError } from '../domain/errors.ts'

/**
 * Output discipline (prompt §1.1):
 * - JSON mode: stdout carries exactly one JSON document, no ANSI, no progress.
 *   Human progress/diagnostics go to stderr.
 * - Human mode: friendly text on stdout, diagnostics on stderr.
 * No color is emitted at all in this build; scriptability beats decoration.
 */

export interface CliIo {
  out: (s: string) => void
  err: (s: string) => void
}

export const stdIo: CliIo = {
  out: (s: string) => process.stdout.write(s + '\n'),
  err: (s: string) => process.stderr.write(s + '\n'),
}

export interface JsonEnvelope {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

export function emitOk(io: CliIo, json: boolean, human: string, data: unknown): void {
  if (json) io.out(JSON.stringify({ ok: true, data } satisfies JsonEnvelope, null, 2))
  else if (human.length > 0) io.out(human)
}

export function emitErr(io: CliIo, json: boolean, e: unknown): number {
  const j = errorToJson(e)
  if (json) {
    io.out(JSON.stringify({ ok: false, error: j } satisfies JsonEnvelope, null, 2))
  } else {
    io.err(`error [${j.code}]: ${j.message}`)
    if (j.details !== undefined) {
      io.err(`details: ${JSON.stringify(j.details).slice(0, 2_000)}`)
    }
  }
  return 1
}

/** Wrap a command body: converts PlutonError (and unexpected throws) into exit codes. */
export async function runCommand(
  io: CliIo,
  json: boolean,
  fn: () => Promise<number | void>,
): Promise<void> {
  try {
    const code = await fn()
    process.exitCode = code ?? 0
  } catch (e) {
    process.exitCode = emitErr(io, json, e)
  }
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return ''
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n')
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info'

export interface CheckResult {
  id: string
  title: string
  status: CheckStatus
  message: string
  fix?: string
}

const STATUS_MARK: Record<CheckStatus, string> = {
  pass: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
  info: 'INFO',
}

export function renderChecks(checks: CheckResult[]): string {
  return checks
    .map((c) => {
      const fix = c.fix ? `\n       fix: ${c.fix}` : ''
      return `[${STATUS_MARK[c.status]}] ${c.title}: ${c.message}${fix}`
    })
    .join('\n')
}

export function summarizeChecks(checks: CheckResult[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  }
}

export type { PlutonError }
