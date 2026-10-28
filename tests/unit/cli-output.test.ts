import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import {
  emitErr,
  emitOk,
  renderChecks,
  runCommand,
  summarizeChecks,
  table,
  type CheckResult,
  type CliIo,
} from '../../src/cli/output.ts'

function capture(): { out: string[]; err: string[]; io: CliIo } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
})

describe('CLI output envelopes', () => {
  it('emits one JSON document for success', () => {
    const { out, io } = capture()
    emitOk(io, true, 'ignored human text', { value: 42 })
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, data: { value: 42 } })
  })

  it('emits human text only when it is non-empty', () => {
    const { out, io } = capture()
    emitOk(io, false, 'done', undefined)
    emitOk(io, false, '', undefined)
    expect(out).toEqual(['done'])
  })

  it('renders a structured error with details in JSON mode', () => {
    const { out, io } = capture()
    const code = emitErr(io, true, new ValidationError('bad input', { details: { field: 'name' } }))
    expect(code).toBe(1)
    const envelope = JSON.parse(out[0]!)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toMatchObject({ code: 'validation_failed', message: 'bad input', details: { field: 'name' } })
  })

  it('renders a human error with and without details', () => {
    const withDetails = capture()
    expect(emitErr(withDetails.io, false, new ValidationError('bad input', { details: { field: 'name' } }))).toBe(1)
    expect(withDetails.err[0]).toBe('error [validation_failed]: bad input')
    expect(withDetails.err[1]).toBe('details: {"field":"name"}')

    const withoutDetails = capture()
    emitErr(withoutDetails.io, false, new Error('boom'))
    expect(withoutDetails.err).toHaveLength(1)
    expect(withoutDetails.err[0]).toMatch(/^error \[[a-z_]+\]: boom$/)
  })
})

describe('runCommand', () => {
  it('sets a zero exit code when the body returns nothing', async () => {
    await runCommand(capture().io, true, async () => undefined)
    expect(process.exitCode).toBe(0)
  })

  it('uses the numeric exit code returned by the body', async () => {
    await runCommand(capture().io, true, async () => 3)
    expect(process.exitCode).toBe(3)
  })

  it('converts a throw into exit code 1 and an error envelope', async () => {
    const { out, io } = capture()
    await runCommand(io, true, async () => {
      throw new ValidationError('no')
    })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(out[0]!).error.message).toBe('no')
  })
})

describe('CLI table and checks', () => {
  it('renders no table for no rows and pads columns otherwise', () => {
    expect(table([])).toBe('')
    expect(table([
      ['a', 'long'],
      ['bbb', 'c'],
    ])).toBe('a    long\nbbb  c')
  })

  it('renders every check status and optional fix', () => {
    const checks: CheckResult[] = [
      { id: '1', title: 'one', status: 'pass', message: 'ok' },
      { id: '2', title: 'two', status: 'warn', message: 'careful' },
      { id: '3', title: 'three', status: 'fail', message: 'broken', fix: 'repair it' },
      { id: '4', title: 'four', status: 'info', message: 'note' },
    ]
    expect(renderChecks(checks)).toBe(
      [
        '[OK  ] one: ok',
        '[WARN] two: careful',
        '[FAIL] three: broken\n       fix: repair it',
        '[INFO] four: note',
      ].join('\n'),
    )
    expect(summarizeChecks(checks)).toEqual({ pass: 1, warn: 1, fail: 1 })
  })

  it('summarizes an empty check list', () => {
    expect(summarizeChecks([])).toEqual({ pass: 0, warn: 0, fail: 0 })
  })
})
