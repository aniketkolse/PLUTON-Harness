import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cliEntry = join(repoRoot, 'src', 'cli', 'main.ts')

function runCli(
  args: string[],
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, PLUTON_JSON: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe('pluton chat --demo', () => {
  it('renders the demo scenario instead of resolving a chat session', async () => {
    const result = await runCli(['chat', '--demo'], 'q\n')

    expect(result.stderr).not.toContain('needs an interactive terminal')
    expect(result.stdout).toContain('Currency validator')
    expect(result.code).toBe(0)
  }, 30_000)
})
