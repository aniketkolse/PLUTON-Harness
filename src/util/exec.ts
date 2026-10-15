import { spawn } from 'node:child_process'

/**
 * The only way Pluton launches external processes: argument arrays (never a
 * shell string), bounded output, hard timeouts, sanitized env, and a stable
 * result shape. Docker, git, tmux, engines and verification all go through it.
 */

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
  /** Cap for each of stdout/stderr; excess is truncated with a marker. */
  maxOutputBytes?: number
  /** Optional stdin write (then closed). */
  input?: string
  /** When true, inherit no env except the provided one (+ PATH resolution still works). */
  envMode?: 'inherit' | 'explicit'
}

export interface RunResult {
  argv: string[]
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT = 1_048_576 // 1 MiB per stream

export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  if (argv.length === 0) throw new Error('run() requires a non-empty argv')
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()

  return await new Promise<RunResult>((resolveFn) => {
    let truncated = false
    let settled = false
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: options.cwd,
      env: options.envMode === 'explicit' ? { ...options.env, PATH: process.env['PATH'] } : { ...process.env, ...options.env },
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLen = 0
    let errLen = 0

    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      finish(null, true)
    }, timeoutMs)

    function append(buffers: Buffer[], chunk: Buffer, lenRef: { v: number }): void {
      if (lenRef.v >= max) {
        truncated = true
        return
      }
      const remaining = max - lenRef.v
      if (chunk.length > remaining) {
        buffers.push(chunk.subarray(0, remaining))
        lenRef.v = max
        truncated = true
      } else {
        buffers.push(chunk)
        lenRef.v += chunk.length
      }
    }

    const outRef = { v: 0 }
    const errRef = { v: 0 }

    child.stdout?.on('data', (c: Buffer) => append(out, c, outRef))
    child.stderr?.on('data', (c: Buffer) => append(err, c, errRef))

    function finish(code: number | null, timedOut: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveFn({
        argv,
        exitCode: code,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
      })
    }

    child.on('error', (e: Error) => {
      err.push(Buffer.from(String(e.message), 'utf8'))
      finish(null, false)
    })
    child.on('close', (code) => finish(code, false))

    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}

export async function runOrThrow(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const r = await run(argv, options)
  if (r.timedOut) {
    throw new Error(`command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${argv.join(' ')}`)
  }
  if (r.exitCode !== 0) {
    throw new Error(`command failed (exit ${r.exitCode}): ${argv.join(' ')}\n${r.stderr.slice(0, 2_000)}`)
  }
  return r
}

/** First line of a version-style output, trimmed and bounded. */
export function firstLine(s: string, maxLen = 200): string {
  const line = s.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line.slice(0, maxLen)
}
