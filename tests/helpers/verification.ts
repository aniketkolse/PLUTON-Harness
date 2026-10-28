import { buildVerificationEnvironment, type VerificationExecutionRequest, type VerificationExecutionResult, type VerificationExecutor } from '../../src/verify/executor.ts'
import { run } from '../../src/util/exec.ts'

/**
 * Explicit test-only verification executor.
 *
 * Production verification must fail closed on hosts without proven OS
 * confinement (see `createVerificationExecutor`). Tests that exercise the
 * gate's bookkeeping need real process exits, so they opt in here — loudly and
 * locally — instead of production silently falling back to the host.
 */
export function hostTestExecutor(id = 'test:host'): VerificationExecutor {
  return {
    id,
    availability: { available: true, reason: null },
    async run(request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
      const env = buildVerificationEnvironment(request.workspaceRoot, request.env)
      const result = await run(request.command, {
        cwd: request.cwd,
        env,
        envMode: 'explicit',
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        truncated: result.truncated,
        executor: id,
      }
    },
  }
}
